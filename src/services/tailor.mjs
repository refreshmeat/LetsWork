import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { askAI, parseJsonLoose } from './ai.mjs';
import { extractText, repairTextEncoding, inferProfile } from './resume.mjs';
import { runtime } from '../runtime.mjs';

function outputDir(source){
  const parent=path.dirname(source),base=path.basename(parent).toLowerCase();
  const candidateFolder=['curriculos','documentos','curriculos_personalizados'].includes(base);
  const dir=candidateFolder
    ?(base==='curriculos_personalizados'?parent:path.join(path.dirname(parent),'curriculos_personalizados'))
    :runtime.generated;
  fs.mkdirSync(dir,{recursive:true});
  return dir;
}
const slug=s=>String(s||'vaga').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,72);
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const stop=new Set('a o as os de da do das dos e em para por com sem um uma que se no na nos nas ao aos como mais muito sua seu suas seus esta este essa esse meu minha meus minhas'.split(' '));
const headingRx=/^(sobre mim|perfil|resumo|objetivo|formacoes?|formacao|educacao|experiencias?|experiencia|skills?|habilidades?|competencias?|idiomas?|projetos?|portfolio|contato)$/i;
const isHeading=text=>headingRx.test(norm(text));

function cleanLine(value){
  return String(value||'').replace(/[ \t]+/g,' ').replace(/^[-•·▪◦–—*]+\s*/u,'').trim();
}
function supportMarker(line){
  return line.match(/^===\s*DOCUMENTO DE APOIO:\s*(.*?)\s*===$/i)?.[1]||'';
}
function sectionFromHeading(text){
  const n=norm(text);
  if(/^(sobre mim|perfil|resumo|objetivo)/.test(n))return 'summary';
  if(/^(formac|educac|cursos?|qualific)/.test(n))return 'education';
  if(/^(experienc|historico profissional|atuacao profissional)/.test(n))return 'experience';
  if(/^(skills?|habilidades?|competencias?|ferramentas?)/.test(n))return 'skills';
  if(/^(idiomas?|linguas?)/.test(n))return 'languages';
  if(/^(projetos?|portfolio)/.test(n))return 'projects';
  return '';
}
function lineLooksGarbage(text){
  const s=cleanLine(text); if(!s)return true;
  const chars=[...s],letters=chars.filter(c=>/\p{L}/u.test(c)).length;
  if(s.length>8&&letters/Math.max(1,s.length)<0.42)return true;
  const toks=s.split(/\s+/),singles=toks.filter(x=>/^\p{L}$/u.test(x)).length;
  return toks.length>=8&&singles/toks.length>.35;
}
function buildBlocks(raw){
  const blocks=[]; let source='curriculo',section='general',order=0,buffer=[];
  const push=text=>{const t=cleanLine(text);if(t.length>=2&&!lineLooksGarbage(t))blocks.push({id:blocks.length,source,section,text:t,order:order++});};
  const flush=()=>{if(buffer.length){push(buffer.join(' '));buffer=[];}};
  for(const rawLine of String(raw||'').replace(/\r/g,'').split('\n')){
    const marker=supportMarker(rawLine.trim());
    if(marker){flush();source=`apoio:${marker}`;section='general';continue;}
    const text=cleanLine(rawLine); if(text.length<2||lineLooksGarbage(text))continue;
    const heading=sectionFromHeading(text);
    if(heading&&text.length<=45){flush();section=heading;continue;}
    if(/^(?:telefone|e-?mail|linkedin|instagram|github|portf[oó]lio)\s*:/i.test(text)){flush();push(text);continue;}
    if(source!=='curriculo'&&/^(?:este|esse|esta|essa)\s+[ée]\s+(?:um|uma)\s+(?:pequeno\s+)?projeto\b/i.test(text)){flush();section='projects';buffer=[text];continue;}
    if(section==='skills'||section==='languages'||(source==='curriculo'&&section==='education')){flush();push(text);continue;}
    buffer.push(text);
    const joined=buffer.join(' ');
    if(/[.!?;:]$/.test(text)||joined.length>=280||(section==='education'&&buffer.length>=3))flush();
  }
  flush();
  return blocks;
}
function significantWords(text){
  return [...new Set(norm(text).split(/[^a-z0-9+#.]+/).filter(x=>x.length>=4&&!stop.has(x)))];
}
function overlap(a,b){
  const aw=significantWords(a),bw=new Set(significantWords(b));
  if(!aw.length)return 0;
  return aw.filter(x=>bw.has(x)).length/aw.length;
}
function roleTitle(job){
  return cleanLine(String(job?.title||'Oportunidade').split(/\s+[|–—-]\s+/u)[0]).slice(0,110)||'Oportunidade';
}
function sourceForPrompt(blocks,job){
  const primary=blocks.filter(x=>x.source==='curriculo');
  const support=blocks.filter(x=>x.source!=='curriculo')
    .map(x=>({...x,_score:overlap(x.text,`${job.title||''} ${job.description||''}`)}))
    .sort((a,b)=>b._score-a._score||a.order-b.order);
  const chosen=[...primary.slice(0,75),...support.slice(0,65)];
  return [...new Map(chosen.map(x=>[x.id,x])).values()].sort((a,b)=>a.order-b.order);
}
function validIds(value,map,max=10){
  return [...new Set((Array.isArray(value)?value:[]).map(Number).filter(x=>map.has(x)))].slice(0,max);
}
function evidenceText(ids,map){
  return ids.map(id=>map.get(id)?.text||'').filter(Boolean).join(' ');
}
function groundedSummary(summary,evidence,allSource){
  const s=cleanLine(summary);
  if(s.length<25||s.length>520)return false;
  const source=norm(`${evidence} ${allSource}`);
  const nums=s.match(/\b\d+(?:[.,]\d+)?\b/g)||[];
  if(nums.some(n=>!source.includes(norm(n))))return false;
  const risky=['senior','pleno','lideranca','gerencia','especialista','anos de experiencia'];
  for(const word of risky)if(norm(s).includes(norm(word))&&!source.includes(norm(word)))return false;
  const sw=significantWords(s),src=new Set(significantWords(`${evidence} ${allSource}`));
  if(!sw.length)return false;
  const covered=sw.filter(x=>src.has(x)).length/sw.length;
  return covered>=0.55;
}
const workEvidenceRx=/\b(?:experiencia profissional|trabalhei|atuei|atuava|responsavel por|freelance|freela|emprego|cargo\s*:|empresa\s*:|historico profissional)\b/i;
const educationRx=/\b(?:graduacao|bacharel|faculdade|universidade|ensino medio|curso complementar|curso superior|tecnologo|mba|pos-graduacao|cursando|semestre|senac|senai)\b/i;
const projectRx=/\b(?:projeto|prototipo|fluxograma|interface|aplicativo|revista|capa|contracapa|identidade visual|peca grafica|layout)\b/i;
const languageRx=/\b(?:ingles|inglesa|english|espanhol|frances|alemao|italiano|mandarim|portugues|c1|c2|b2|b1)\b/i;
function isEducationBlock(x){return x?.section==='education'||educationRx.test(norm(x?.text||''));}
function isExperienceBlock(x){return x?.section==='experience'||workEvidenceRx.test(norm(x?.text||''));}
function isProjectBlock(x){return x?.source!=='curriculo'&&projectRx.test(norm(x?.text||''));}
function isLanguageBlock(x){return x?.section==='languages'||languageRx.test(norm(x?.text||''));}
function uniqTexts(ids,map,limit=8,predicate=()=>true){
  const seen=new Set(),out=[];
  for(const id of ids){
    const block=map.get(id); if(!block||!predicate(block))continue;
    const text=cleanLine(block.text||'');
    const key=norm(text);
    if(!text||isHeading(text)||seen.has(key))continue;
    seen.add(key);out.push(text);
    if(out.length>=limit)break;
  }
  return out;
}
function fallbackBy(blocks,rx,limit=6,sourceTest=()=>true){
  return blocks.filter(x=>sourceTest(x)&&rx.test(x.text)).map(x=>x.text).filter(x=>!isHeading(x)).slice(0,limit);
}
function bestSupport(blocks,job,limit=5){
  return blocks.filter(x=>isProjectBlock(x)&&!isHeading(x.text)&&x.text.length>=18)
    .map(x=>({...x,score:overlap(x.text,`${job.title||''} ${job.description||''}`)}))
    .sort((a,b)=>b.score-a.score||a.order-b.order).slice(0,limit).map(x=>x.text);
}

function formatSkill(value){
  const s=cleanLine(value); if(!s)return '';
  const connectors=new Set(['a','o','as','os','ao','aos','de','da','do','das','dos','e','em','para','por','com','sem']);
  return s.split(/\s+/).map((w,i)=>connectors.has(w.toLowerCase())&&i>0?w.toLowerCase():w.length<=3?w.toUpperCase():w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
}
function cleanProjectText(value){
  let t=cleanLine(value).replace(/[|_=<>]+/g,' ').replace(/[{}\[\]"""]+/g,' ').replace(/\s+/g,' ').trim();
  const start=t.search(/(?:este|esse|esta|essa)\s+[ée]\s+(?:um|uma)\s+(?:pequeno\s+)?projeto\b/i);
  if(start>0)t=t.slice(start);
  const month=t.search(/\b(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}\b/i);
  if(month>55)t=t.slice(0,month).trim();
  const sentence=t.match(/^(.{28,260}?[.!?])(?:\s|$)/);
  if(sentence)t=sentence[1];
  if(t.length>260){const cut=t.slice(0,260);t=cut.slice(0,Math.max(80,cut.lastIndexOf(' '))).trim()+'…';}
  return t.replace(/\s+/g,' ').trim();
}
function fallbackSummary(blocks,profile,job,skills){
  const primary=blocks.filter(x=>x.source==='curriculo').map(x=>x.text).join(' ');
  let status=primary.match(/\bsou\s+(?:uma?\s+)?(estudante\s+de\s+[^.,;]{2,80})/i)?.[1]||'';
  if(!status)status=primary.match(/\b(cursando\s+[^.,;]{3,90})/i)?.[1]||'';
  if(!status)status=primary.match(/\b(profissional\s+(?:de|em)\s+[^.,;]{3,90})/i)?.[1]||'';
  const parts=[];
  if(status)parts.push(status.charAt(0).toUpperCase()+status.slice(1)+'.');
  if(skills.length)parts.push(`Conhecimentos em ${skills.slice(0,5).join(', ')}.`);
  parts.push(`Interesse em oportunidades de ${roleTitle(job)}.`);
  return parts.join(' ').slice(0,420);
}

function wrapText(font,text,size,maxWidth){
  const words=cleanLine(text).split(/\s+/).filter(Boolean),lines=[];let line='';
  for(const word of words){
    const candidate=line?`${line} ${word}`:word;
    if(font.widthOfTextAtSize(candidate,size)<=maxWidth)line=candidate;
    else{if(line)lines.push(line);line=word;}
  }
  if(line)lines.push(line);
  return lines;
}
const RESUME_TEMPLATES={
  executive:{accent:[.06,.34,.24],ink:[.06,.075,.07],muted:[.34,.38,.36],line:[.80,.84,.82],soft:[.945,.968,.955],margin:42,nameSize:25,targetSize:11.6,sectionSize:10.5,bodySize:10.25,leading:14.4,itemGap:6,fontFamily:'sans',headerMode:'band'},
  classic:{accent:[.12,.12,.12],ink:[.055,.055,.055],muted:[.38,.38,.38],line:[.74,.74,.72],soft:[.965,.958,.94],margin:47,nameSize:25,targetSize:11.1,sectionSize:10.3,bodySize:10.2,leading:14.4,itemGap:6,fontFamily:'serif',headerMode:'centered'},
  compact:{accent:[.11,.23,.28],ink:[.07,.08,.09],muted:[.40,.42,.44],line:[.82,.85,.87],soft:[.95,.965,.97],margin:39,nameSize:22,targetSize:10.6,sectionSize:9.8,bodySize:9.4,leading:12.6,itemGap:3.6,fontFamily:'sans',headerMode:'compact'}
};
function resumeTemplateName(value){return Object.hasOwn(RESUME_TEMPLATES,String(value||''))?String(value):'executive';}
function resumeDisplayUrl(value){
  return String(value||'').trim().replace(/^https?:\/\/(?:www\.)?/i,'').replace(/\/$/,'');
}
function resumeLocation(profile={}){
  const city=String(profile.residenceCity||'').trim(),state=String(profile.residenceState||'').trim(),neighborhood=String(profile.neighborhood||'').trim();
  if(neighborhood&&city&&state)return `${neighborhood} - ${city}, ${state}`;
  if(city&&state)return `${city}, ${state}`;
  return neighborhood||city||state||'';
}
function parseExperienceEntry(value){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  const pipe=text.indexOf(' | ');
  if(pipe<0)return {company:'',role:'',dates:'',details:[],raw:text};
  const left=text.slice(0,pipe).trim(),right=text.slice(pipe+3).trim();
  const pos=left.lastIndexOf(' - ');
  if(pos<0)return {company:'',role:'',dates:'',details:[],raw:text};
  const rest=right.match(/^([^:]+?)(?::\s*(.*))?$/);
  return {
    company:left.slice(0,pos).trim(),
    role:left.slice(pos+3).trim(),
    dates:String(rest?.[1]||'').trim(),
    details:String(rest?.[2]||'').split(/\s*;\s*/).map(x=>x.replace(/[.;]+$/,'').trim()).filter(Boolean).slice(0,4),
    raw:text
  };
}
function parseEducationEntry(value){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  const [left,status='']=text.split(/\s*\|\s*/,2);
  const pos=left.lastIndexOf(' - ');
  return {title:(pos>=0?left.slice(0,pos):left).trim(),institution:(pos>=0?left.slice(pos+3):'').trim(),status:status.trim(),raw:text};
}
function parseProjectEntry(value){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  const pos=text.indexOf(' - ');
  return {title:(pos>=0?text.slice(0,pos):text).trim(),description:(pos>=0?text.slice(pos+3):'').trim(),raw:text};
}
async function renderResumePdf(source,job,profile,content,template='executive'){
  const templateName=resumeTemplateName(template);
  const style={...RESUME_TEMPLATES[templateName]};
  const contentChars=[
    content.summary||'',
    ...(content.experience||[]),
    ...(content.education||[]),
    ...(content.courses||[]),
    ...(content.projects||[]),
    ...(content.skills||[]),
    ...(content.languages||[]),
    ...(content.other||[])
  ].join(' ').length;
  const stretch=contentChars<950?1.22:contentChars<1350?1.14:contentChars<1800?1.07:1;
  style.bodySize*=Math.min(stretch,1.14);
  style.leading*=stretch;
  style.itemGap*=stretch;
  style.sectionSize*=Math.min(stretch,1.08);
  style.nameSize*=Math.min(stretch,1.08);
  style.targetSize*=Math.min(stretch,1.05);

  const pdf=await PDFDocument.create();
  const serif=style.fontFamily==='serif';
  const regular=await pdf.embedFont(serif?StandardFonts.TimesRoman:StandardFonts.Helvetica);
  const bold=await pdf.embedFont(serif?StandardFonts.TimesRomanBold:StandardFonts.HelveticaBold);
  const italic=await pdf.embedFont(serif?StandardFonts.TimesRomanItalic:StandardFonts.HelveticaOblique);
  const pageSize=[595.28,841.89],margin=style.margin,maxWidth=pageSize[0]-margin*2;
  let page,y;
  const toColor=a=>rgb(a[0],a[1],a[2]);
  const ink=toColor(style.ink),muted=toColor(style.muted),accent=toColor(style.accent),line=toColor(style.line),soft=toColor(style.soft);
  const white=rgb(1,1,1);

  const newPage=(continuation=false)=>{
    page=pdf.addPage(pageSize);y=pageSize[1]-margin;
    if(continuation){
      page.drawText(String(profile.name||'Candidato').slice(0,80),{x:margin,y,size:9.3,font:bold,color:muted});
      y-=14;page.drawLine({start:{x:margin,y},end:{x:pageSize[0]-margin,y},thickness:.5,color:line});y-=17;
    }
  };
  const ensure=height=>{if(y-height<margin+12)newPage(true);};
  const centeredX=(text,font,size)=>Math.max(margin,(pageSize[0]-font.widthOfTextAtSize(String(text||''),size))/2);

  const drawJustifiedLine=(text,size,font,color,x,width)=>{
    const words=String(text||'').trim().split(/\s+/).filter(Boolean);
    if(words.length<3){page.drawText(words.join(' '),{x,y,size,font,color});return;}
    const wordWidth=words.reduce((n,w)=>n+font.widthOfTextAtSize(w,size),0);
    const gap=(width-wordWidth)/(words.length-1);
    if(!Number.isFinite(gap)||gap<1.4||gap>7){
      page.drawText(words.join(' '),{x,y,size,font,color});return;
    }
    let cx=x;
    for(let i=0;i<words.length;i++){
      page.drawText(words[i],{x:cx,y,size,font,color});
      cx+=font.widthOfTextAtSize(words[i],size)+(i<words.length-1?gap:0);
    }
  };

  const drawLines=(text,size=style.bodySize,font=regular,color=ink,indent=0,leading=style.leading,max=maxWidth-indent,justify=false)=>{
    const wrapped=wrapText(font,String(text||''),size,max);
    ensure(wrapped.length*leading+2);
    wrapped.forEach((textLine,i)=>{
      const measured=font.widthOfTextAtSize(textLine,size);
      const shouldJustify=justify&&i<wrapped.length-1&&measured>max*.62;
      if(shouldJustify)drawJustifiedLine(textLine,size,font,color,margin+indent,max);
      else page.drawText(textLine,{x:margin+indent,y,size,font,color});
      y-=leading;
    });
    return wrapped.length;
  };
  const drawRight=(text,size,font,color,yPos)=>{
    const w=font.widthOfTextAtSize(String(text||''),size);
    page.drawText(String(text||''),{x:pageSize[0]-margin-w,y:yPos,size,font,color});
  };
  const section=title=>{
    ensure(32);y-=8;
    if(templateName==='executive'){
      page.drawRectangle({x:margin,y:y-2,width:3.2,height:style.sectionSize+5,color:accent});
      page.drawText(title.toUpperCase(),{x:margin+10,y,size:style.sectionSize,font:bold,color:accent});
      const tw=bold.widthOfTextAtSize(title.toUpperCase(),style.sectionSize);
      page.drawLine({start:{x:margin+tw+20,y:y+4},end:{x:pageSize[0]-margin,y:y+4},thickness:.45,color:line});
      y-=19;
    }else if(templateName==='classic'){
      page.drawText(title.toUpperCase(),{x:margin,y,size:style.sectionSize,font:bold,color:accent});
      const tw=bold.widthOfTextAtSize(title.toUpperCase(),style.sectionSize);
      page.drawLine({start:{x:margin+tw+12,y:y+4},end:{x:pageSize[0]-margin,y:y+4},thickness:.55,color:line});
      y-=19;
    }else{
      page.drawRectangle({x:margin,y:y-3,width:maxWidth,height:17,color:soft});
      page.drawText(title.toUpperCase(),{x:margin+7,y:y+1,size:style.sectionSize,font:bold,color:accent});
      y-=23;
    }
  };
  const simpleItems=(items,max=7)=>{
    for(const item of items.slice(0,max)){
      ensure(25);
      page.drawCircle({x:margin+2.5,y:y+3,size:1.15,color:accent});
      drawLines(item,style.bodySize,regular,ink,10,style.leading,maxWidth-10,true);
      y-=style.itemGap*.55;
    }
  };
  const experienceItems=items=>{
    for(const value of items.slice(0,7)){
      const item=parseExperienceEntry(value);
      if(!item.role){simpleItems([value],1);continue;}
      ensure(44);
      const titleSize=style.bodySize+.25;
      const dateSize=Math.max(8.8,style.bodySize-.9);
      const available=maxWidth-(item.dates?regular.widthOfTextAtSize(item.dates,dateSize)+18:0);
      const titleLines=wrapText(bold,item.role,titleSize,available);
      const topY=y;
      for(const ln of titleLines){page.drawText(ln,{x:margin,y,size:titleSize,font:bold,color:ink});y-=style.leading*.92;}
      if(item.dates&&titleLines.length===1)drawRight(item.dates,dateSize,regular,muted,topY);
      else if(item.dates){page.drawText(item.dates,{x:margin,y,size:dateSize,font:regular,color:muted});y-=style.leading*.76;}
      if(item.company){
        page.drawText(item.company,{x:margin,y,size:style.bodySize-.18,font:italic,color:muted});
        y-=style.leading*.86;
      }
      for(const detail of item.details.slice(0,4)){
        ensure(21);page.drawCircle({x:margin+2.4,y:y+3,size:1.0,color:accent});
        drawLines(detail,style.bodySize-.08,regular,ink,10,style.leading-.15,maxWidth-10,true);
        y-=1;
      }
      y-=style.itemGap;
    }
  };
  const educationItems=items=>{
    for(const value of items.slice(0,6)){
      const item=parseEducationEntry(value);ensure(31);
      const size=style.bodySize+.12,statusSize=Math.max(8.7,style.bodySize-.95);
      const available=maxWidth-(item.status?regular.widthOfTextAtSize(item.status,statusSize)+20:0);
      const titleLines=wrapText(bold,item.title,size,available);
      const topY=y;
      for(const ln of titleLines){page.drawText(ln,{x:margin,y,size,font:bold,color:ink});y-=style.leading*.92;}
      if(item.status&&titleLines.length===1)drawRight(item.status,statusSize,regular,muted,topY);
      else if(item.status){page.drawText(item.status,{x:margin,y,size:statusSize,font:regular,color:muted});y-=style.leading*.75;}
      if(item.institution){
        page.drawText(item.institution,{x:margin,y,size:style.bodySize-.18,font:italic,color:muted});
        y-=style.leading*.88;
      }
      y-=style.itemGap;
    }
  };
  const projectItems=items=>{
    for(const value of items.slice(0,5)){
      const item=parseProjectEntry(value);ensure(31);
      drawLines(item.title,style.bodySize+.12,bold,ink,0,style.leading,maxWidth,false);
      if(item.description)drawLines(item.description,style.bodySize-.08,regular,ink,0,style.leading-.15,maxWidth,true);
      y-=style.itemGap;
    }
  };

  newPage(false);
  const name=String(profile.name||'Candidato').slice(0,80);
  const target=String(content.target||roleTitle(job)).slice(0,110);
  const contact=[
    resumeLocation(profile),
    profile.phone,
    profile.email,
    profile.linkedin?resumeDisplayUrl(profile.linkedin):'',
    profile.portfolio?resumeDisplayUrl(profile.portfolio):''
  ].filter(Boolean).join('  |  ');

  if(templateName==='executive'){
    const headerHeight=112;
    page.drawRectangle({x:0,y:pageSize[1]-headerHeight,width:pageSize[0],height:headerHeight,color:rgb(.045,.105,.085)});
    y=pageSize[1]-margin+1;
    page.drawText(name,{x:margin,y,size:style.nameSize,font:bold,color:white});
    y-=style.nameSize+6;
    page.drawText(target,{x:margin,y,size:style.targetSize,font:bold,color:rgb(.68,.90,.80)});
    y-=15;
    if(contact){
      const lines=wrapText(regular,contact,8.85,maxWidth);
      for(const ln of lines.slice(0,2)){page.drawText(ln,{x:margin,y,size:8.85,font:regular,color:rgb(.90,.94,.92)});y-=11.4;}
    }
    y=pageSize[1]-headerHeight-12;
  }else if(templateName==='classic'){
    page.drawText(name,{x:centeredX(name,bold,style.nameSize),y,size:style.nameSize,font:bold,color:ink});
    y-=style.nameSize+6;
    page.drawText(target,{x:centeredX(target,italic,style.targetSize),y,size:style.targetSize,font:italic,color:accent});
    y-=16;
    if(contact){
      for(const ln of wrapText(regular,contact,8.9,maxWidth).slice(0,2)){
        page.drawText(ln,{x:centeredX(ln,regular,8.9),y,size:8.9,font:regular,color:muted});y-=11.5;
      }
    }
    y-=4;
    page.drawLine({start:{x:margin,y},end:{x:pageSize[0]-margin,y},thickness:1.15,color:accent});
    y-=8;
  }else{
    page.drawRectangle({x:margin,y:y-style.nameSize-12,width:4,height:style.nameSize+30,color:accent});
    page.drawText(name,{x:margin+12,y,size:style.nameSize,font:bold,color:ink});
    y-=style.nameSize+4;
    page.drawText(target,{x:margin+12,y,size:style.targetSize,font:bold,color:accent});
    y-=14;
    if(contact)drawLines(contact,8.7,regular,muted,12,11,maxWidth-12,false);
    y-=4;
  }

  if(content.summary){
    section('Perfil profissional');
    drawLines(content.summary,style.bodySize+.12,regular,ink,0,style.leading+.12,maxWidth,true);
    y-=style.itemGap*.35;
  }

  const hasExperience=Boolean(content.experience?.length);
  if(hasExperience){
    section('Experiência profissional');experienceItems(content.experience);
    if(content.education?.length){section('Formação acadêmica');educationItems(content.education);}
  }else{
    if(content.education?.length){section('Formação acadêmica');educationItems(content.education);}
    if(content.projects?.length){section('Projetos selecionados');projectItems(content.projects);}
  }

  if(content.courses?.length){section('Cursos complementares');simpleItems(content.courses,8);}
  if(hasExperience&&content.projects?.length){section('Projetos selecionados');projectItems(content.projects);}
  if(content.skills?.length){
    section('Competências');
    const skills=content.skills.join('  •  ');
    const skillLines=wrapText(regular,skills,style.bodySize-.02,maxWidth-18);
    const boxH=skillLines.length*style.leading+12;
    ensure(boxH+4);
    page.drawRectangle({x:margin,y:y-boxH+8,width:maxWidth,height:boxH,color:soft,borderColor:line,borderWidth:.35});
    y-=3;
    for(const ln of skillLines){page.drawText(ln,{x:margin+9,y,size:style.bodySize-.02,font:regular,color:ink});y-=style.leading;}
    y-=4;
  }
  if(content.languages?.length){section('Idiomas');simpleItems(content.languages,5);}
  if(content.other?.length){section('Informações adicionais');simpleItems(content.other,4);}

  const out=path.join(outputDir(source),`${slug(job.title)}_${Date.now()}.pdf`);
  fs.writeFileSync(out,await pdf.save());
  return out;
}
async function validateGeneratedPdf(file,profile,content){
  const data=new Uint8Array(fs.readFileSync(file));
  const doc=await pdfjs.getDocument({data,disableWorker:true}).promise;
  const chunks=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i);
    const tc=await page.getTextContent();
    chunks.push(tc.items.map(x=>x.str||'').join(' '));
  }
  const text=chunks.join('\n').replace(/\s+/g,' ').trim();
  if(text.length<220)throw new Error('Currículo personalizado gerado com conteúdo insuficiente');
  if(profile.name&&!norm(text).includes(norm(profile.name)))throw new Error('Currículo personalizado perdeu o nome do candidato');
  if(/resumo direcionado [àa] vaga|curr[ií]culo original completo est[aá] nas p[aá]ginas seguintes/i.test(text))throw new Error('Formato antigo de capa detectado e bloqueado');
  if(doc.numPages>2)throw new Error('Currículo personalizado excedeu 2 páginas');
  const sectionCount=label=>(norm(text).match(new RegExp(norm(label),'g'))||[]).length;
  if(sectionCount('Experiência profissional')>1)throw new Error('Currículo repetiu a seção de experiência profissional');
  if(sectionCount('Formação acadêmica')>1)throw new Error('Currículo repetiu a seção de formação acadêmica');
  const textDigits=text.replace(/\D/g,'');
  const phoneDigits=String(profile.phone||'').replace(/\D/g,'');
  if(phoneDigits&&phoneDigits.length>=10&&!textDigits.includes(phoneDigits))throw new Error('Currículo perdeu o telefone/WhatsApp do candidato');
  if(profile.email&&!norm(text).includes(norm(profile.email)))throw new Error('Currículo perdeu o e-mail do candidato');
  if(content.target&&!norm(text).includes(norm(content.target).slice(0,Math.min(18,norm(content.target).length))))throw new Error('Objetivo da vaga não apareceu no currículo personalizado');
  return {pages:doc.numPages,chars:text.length,text};
}

// Curriculo-base estruturado: a IA pode polir o resumo, mas formacao, cursos e projetos
// sao organizados por regras factuais para evitar frases soltas de OCR e alucinacoes.
function baseSplitSource(raw){
  const text=String(raw||'').replace(/\r/g,'');
  const idx=text.search(/===\s*DOCUMENTO DE APOIO:/i);
  return {primary:idx>=0?text.slice(0,idx):text,support:idx>=0?text.slice(idx):''};
}
function basePrettyText(value){
  let s=repairTextEncoding(value).replace(/\s+/g,' ').trim();
  s=s.replace(/\(\s+/g,'(').replace(/\s+\)/g,')');
  s=s.replace(/^[•·▪◦]\s*/u,'');
  s=s.replace(/\bexperiencia do usuario\b/ig,'Experiência do Usuário');
  s=s.replace(/\binterfaces com ia\b/ig,'Interfaces com IA');
  s=s.replace(/\bdesign grafico\b/ig,'Design Gráfico');
  s=s.replace(/\bUX\/UI Design\s+(?=Experi)/i,'UX/UI Design: ');
  return s.trim();
}
function baseLines(text){
  return String(text||'').replace(/\r/g,'').split('\n').map(basePrettyText).filter(line=>{
    if(!line||/^===/.test(line))return false;
    const letters=(line.match(/\p{L}/gu)||[]).length;
    return line.length<10||letters/Math.max(1,line.length)>=0.34;
  });
}
function baseSectionName(line){
  const n=norm(basePrettyText(line)).replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  if(/^(?:formacoes?|formacao academica|educacao|escolaridade)$/.test(n))return 'education';
  if(/^(?:experiencias? profission(?:al|ais)|historico profissional|experiencias?)$/.test(n))return 'experience';
  if(/^(?:habilidades(?: principais| e competencias)?|competencias(?: principais)?|skills?)$/.test(n))return 'skills';
  if(/^(?:qualificacoes?(?: e)? cursos?(?: complementares?)?|certificacoes?(?: e)? idiomas?|certificados?(?: e)? idiomas?|cursos?(?: complementares?)?|idiomas?)$/.test(n))return 'certs';
  if(/^(?:informacoes adicionais|dados adicionais|outros)$/.test(n))return 'additional';
  if(/^(?:projetos?|portfolio)$/.test(n))return 'projects';
  if(/^(?:objetivo profissional|objetivo|resumo profissional|perfil profissional|sobre mim)$/.test(n))return 'summary';
  return '';
}
function baseSections(text){
  const sections={header:[],summary:[],education:[],experience:[],skills:[],certs:[],additional:[],projects:[]};
  let current='header';
  for(const line of baseLines(text)){
    const section=baseSectionName(line);
    if(section){current=section;continue;}
    sections[current].push(line);
  }
  return sections;
}
function baseIsStatus(n){return /em andamento|cursando|semestre|concluido|completo|formado|previsao|previsto/.test(n);}
function baseIsCourseMarker(n){return /curso complementar|curso livre|certificac|certificado|bootcamp|workshop|extensao/.test(n);}
function baseIsLanguage(n){return /^(ingles|english|espanhol|frances|alemao|italiano|mandarim|portugues)\b/.test(n);}
function baseIsAcademic(n){
  if(baseIsStatus(n)&&!/ensino medio|ensino fundamental/.test(n))return false;
  return /ensino medio|ensino fundamental|bacharel|licenciatura|tecnologo|graduacao em|pos[- ]?graduacao|mestrado|doutorado/.test(n);
}
function baseLooksInstitution(line){
  const clean=basePrettyText(line),n=norm(clean);
  if(!clean||clean.length>100||baseSectionName(clean)||baseIsStatus(n)||baseIsCourseMarker(n)||baseIsLanguage(n)||baseIsAcademic(n))return false;
  if(/^(?:skills?|habilidades?|competencias?|idiomas?|projetos?|experiencias?|formacao|formacoes|educacao|informacoes adicionais)$/.test(n))return false;
  if(/telefone|e-?mail|linkedin|instagram|portfolio/.test(n)||/^curso\b/.test(n))return false;
  if(/^[•·▪◦-]/u.test(clean))return false;
  return true;
}
function baseInstitution(line){return basePrettyText(line).replace(/\s+-\s+/g,', ');}
function baseStatus(value){
  const text=basePrettyText(value),n=norm(text);
  const sem=text.match(/(\d{1,2})\s*[º°o]?\s*semestre/i)||n.match(/(\d{1,2})\s*semestre/i);
  if(/em andamento|cursando/.test(n))return `Em andamento${sem?`, ${sem[1]}\u00ba semestre`:''}`;
  if(/concluido|completo|formado/.test(n))return 'Conclu\u00eddo';
  return '';
}
function baseAcademicTitle(line){
  const t=basePrettyText(line),n=norm(t);
  if(n.includes('ensino medio'))return 'Ensino M\u00e9dio';
  if(n.includes('ensino fundamental'))return 'Ensino Fundamental';
  let m=t.match(/^(.+?)\s+bacharelado\b/i);
  if(m)return `Bacharelado em ${basePrettyText(m[1])}`;
  m=t.match(/bacharelado\s+(?:em\s+)?(.+)/i);
  if(m)return `Bacharelado em ${basePrettyText(m[1]).replace(/\s*-\s*(?:em andamento|completo|conclu.*)$/i,'')}`;
  return t.replace(/\s*-\s*(?:em andamento|cursando|completo|conclu[ií]do).*$/i,'').trim();
}
function baseEducationData(primary){
  const sections=baseSections(primary);
  const education=[],courses=[],languages=[];
  const edu=sections.education||[];
  const certs=sections.certs||[];
  const learning=[...edu,...certs];

  for(let i=0;i<edu.length;i++){
    const line=edu[i],n=norm(line);
    if(!baseIsAcademic(n))continue;
    let titleLine=line,institution='',status=baseStatus(line);
    const dash=line.match(/^(.+?)\s+[–—-]\s+(.+)$/u);
    if(dash&&baseIsAcademic(norm(dash[1]))){
      titleLine=dash[1].trim();
      const rightStatus=baseStatus(dash[2]);
      if(rightStatus)status=status||rightStatus;
      else institution=baseInstitution(dash[2]);
    }
    for(let j=i+1;j<=Math.min(edu.length-1,i+2);j++){
      const candidate=edu[j],cn=norm(candidate);
      if(baseIsAcademic(cn))break;
      const st=baseStatus(candidate);
      if(st){status=status||st;continue;}
      if(!institution&&baseLooksInstitution(candidate))institution=baseInstitution(candidate);
    }
    const title=baseAcademicTitle(titleLine);
    education.push(`${title}${institution?` - ${institution}`:''}${status?` | ${status}`:''}`);
  }

  for(let i=0;i<learning.length;i++){
    const line=learning[i],n=norm(line);
    if(baseIsLanguage(n)){
      let item=line.replace(/\s+[–—]\s+/gu,' - ');
      if(i+1<learning.length&&baseLooksInstitution(learning[i+1])&&!/^curso\b/.test(norm(learning[i+1]))&&!baseIsCourseMarker(norm(learning[i+1]))){
        item+=` - ${baseInstitution(learning[i+1])}`;
      }
      languages.push(item);
      continue;
    }
    if(/^(?:curso|bootcamp|workshop|extensao|certificacao)\b/.test(n)&&!baseIsCourseMarker(n)){
      courses.push(line.replace(/\s+[–—]\s+/gu,' - '));
      continue;
    }
    if(baseIsCourseMarker(n)){
      let title='',institution='';
      if(i>=2&&!baseIsAcademic(norm(learning[i-2]))&&!baseIsLanguage(norm(learning[i-2]))&&!baseSectionName(learning[i-2])){
        title=learning[i-2];
        if(baseLooksInstitution(learning[i-1]))institution=baseInstitution(learning[i-1]);
      }else if(i>=1&&!baseSectionName(learning[i-1])&&!baseIsLanguage(norm(learning[i-1]))){
        title=learning[i-1];
      }
      if(title)courses.push(`${title}${institution?` - ${institution}`:''}`);
    }
  }

  const tail=[...(sections.skills||[]),...(sections.additional||[])];
  for(const line of tail){
    const n=norm(line);
    if(baseIsLanguage(n)&&!languages.some(x=>norm(x)===n))languages.push(line.replace(/\s+[–—]\s+/gu,' - '));
    else if(/^curso\b/.test(n)&&!courses.some(x=>norm(x)===n))courses.push(line.replace(/\s+[–—]\s+/gu,' - '));
  }

  const eduScore=x=>{
    const n=norm(x);
    if(/doutorado|mestrado|pos/.test(n))return 5;
    if(/bacharel|graduacao|licenciatura|tecnologo/.test(n))return 4;
    if(/ensino medio/.test(n))return 2;
    return 1;
  };
  education.sort((a,b)=>eduScore(b)-eduScore(a));
  for(const rawLine of certs){
    const clean=basePrettyText(rawLine),n=norm(clean);
    if(!clean||baseSectionName(clean)||baseIsAcademic(n)||baseIsStatus(n)||baseIsLanguage(n))continue;
    if(/:\s*$/.test(clean)&&clean.length<90)continue;
    if(clean.length<4||clean.length>150)continue;
    if(!courses.some(x=>norm(x)===n))courses.push(clean);
  }
  return {
    education:[...new Set(education)].slice(0,6),
    courses:[...new Set(courses)].slice(0,8),
    languages:[...new Set(languages)].slice(0,4)
  };
}
function baseProjectScore(text,target){
  const t=norm(text),f=norm(target);let score=overlap(text,target)*10;
  if(/ux|ui|interface|produto|digital/.test(f)&&/interface|aplicativo|prototipo|fluxograma/.test(t))score+=6;
  if(/design grafico|branding|visual/.test(f)&&/revista|capa|identidade|grafico|editorial/.test(t))score+=5;
  return score;
}
function baseProjects(raw,target){
  const {support}=baseSplitSource(raw),n=norm(support),items=[];
  const add=(title,description)=>{
    const text=`${title} - ${description}`,key=norm(text);
    if(!items.some(x=>norm(x.text)===key))items.push({text,score:baseProjectScore(text,target)});
  };
  if(/revista cientifica/.test(n)&&/capa|contracapa/.test(n)){
    add('Revista cient\u00edfica de Design','Cria\u00e7\u00e3o da capa e contracapa de uma revista cient\u00edfica na \u00e1rea de Design.');
  }
  if(/odontologia infantil|sorriso kids/.test(n)){
    add('Aplicativo de odontologia infantil','Projeto de interface com telas de in\u00edcio, tratamentos e navega\u00e7\u00e3o voltadas ao p\u00fablico infantil.');
  }
  if(/interface de um aplicativo ja existente/.test(n)||(/fluxograma/.test(n)&&/prototipo/.test(n))){
    add('Redesign de aplicativo','Redefini\u00e7\u00e3o da interface de um aplicativo existente, com fluxograma e prot\u00f3tipo.');
  }
  if(/clinica psiquiatrica/.test(n)&&/crianc/.test(n)){
    add('Cl\u00ednica psiqui\u00e1trica infantil','Projeto acad\u00eamico de Design para uma cl\u00ednica psiqui\u00e1trica voltada a crian\u00e7as.');
  }

  const blocks=buildBlocks(raw).filter(x=>isProjectBlock(x));
  for(const block of blocks){
    let text=basePrettyText(cleanProjectText(block.text||''));
    if(text.length<32)continue;
    const nt=norm(text);
    if(/revista cientifica|odontologia infantil|interface de um aplicativo ja existente|clinica psiquiatrica/.test(nt))continue;
    if(items.some(x=>overlap(x.text,text)>.45))continue;
    text=text.replace(/^(?:este|esse|esta|essa)\s+(?:e|é)\s+(?:um|uma)\s+(?:pequeno\s+)?projeto\s+(?:de|para)\s*/i,'');
    if(text.length<28)continue;
    text=text.charAt(0).toUpperCase()+text.slice(1);
    add('Projeto acad\u00eamico',text.replace(/[.;,:-]+$/,'')+'.');
  }
  return items.sort((a,b)=>b.score-a.score).map(x=>x.text).slice(0,4);
}
function baseSkillDisplay(value){
  const n=norm(value);
  const known={figma:'Figma',canva:'Canva',photoshop:'Photoshop',illustrator:'Illustrator',indesign:'InDesign',word:'Microsoft Word',excel:'Excel',powerpoint:'PowerPoint',html:'HTML',css:'CSS',javascript:'JavaScript',typescript:'TypeScript',python:'Python',sql:'SQL',react:'React'};
  return known[n]||formatSkill(value);
}
function baseSkills(profile,target){
  let raw=[...new Set((profile?.skills||[]).map(x=>String(x).trim()).filter(Boolean))];
  const languageNames=new Set(['ingles','english','espanhol','spanish','frances','french','alemao','german','italiano','italian','portugues','portuguese']);
  raw=raw.filter(x=>!languageRx.test(x)&&!languageNames.has(norm(x)));
  const norms=new Set(raw.map(norm));
  const combined=[];
  if(norms.has('ux')&&norms.has('ui')){combined.push('UX/UI');raw=raw.filter(x=>!['ux','ui'].includes(norm(x)));}
  const priority={figma:12,illustrator:11,indesign:11,photoshop:10,canva:8,excel:8,sql:10,python:10,javascript:10,typescript:10,react:10,html:7,css:7,word:2};
  const f=norm(target);
  const scored=raw.map(x=>{
    const n=norm(x),display=baseSkillDisplay(x);
    let score=priority[n]||3;
    if(n&&f.includes(n))score+=20;
    if(n==='design'&&/design/.test(f))score+=12;
    return {display,score};
  }).sort((a,b)=>b.score-a.score);
  return [...combined,...scored.map(x=>x.display)].filter((x,i,a)=>a.indexOf(x)===i).slice(0,7);
}
function baseExperience(raw){
  const {primary}=baseSplitSource(raw);
  const lines=baseSections(primary).experience||[];
  const out=[];
  const dateRx=/\b(?:19|20)\d{2}\b.*\b(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s*[–—-]\s*(?:atual|presente)|\|\s*(?:19|20)\d{2}/i;
  let i=0;
  while(i<lines.length&&out.length<6){
    const company=lines[i];
    const next=lines[i+1]||'';
    if(i+1<lines.length&&dateRx.test(next)){
      const details=[];
      let j=i+2;
      while(j<lines.length){
        const maybeCompany=lines[j],maybeRole=lines[j+1]||'';
        if(j+1<lines.length&&dateRx.test(maybeRole))break;
        if(maybeCompany)details.push(maybeCompany);
        j++;
      }
      const detailText=details.slice(0,4).map(x=>x.replace(/[.;]\s*$/,'')).join('; ');
      out.push(`${company} - ${next}${detailText?`: ${detailText}`:''}`);
      i=j;
      continue;
    }
    i++;
  }
  if(out.length)return out;
  return buildBlocks(raw).filter(x=>x.source==='curriculo'&&isExperienceBlock(x)&&!isHeading(x.text||''))
    .map(x=>basePrettyText(x.text)).filter(Boolean).slice(0,5);
}
function baseListPt(items){
  const arr=items.filter(Boolean);
  if(arr.length<=1)return arr[0]||'';
  if(arr.length===2)return `${arr[0]} e ${arr[1]}`;
  return `${arr.slice(0,-1).join(', ')} e ${arr[arr.length-1]}`;
}
function baseSplitEntry(entry){
  const [left,status='']=String(entry||'').split(' | ');
  const pos=left.lastIndexOf(' - ');
  return {title:pos>=0?left.slice(0,pos):left,institution:pos>=0?left.slice(pos+3):'',status};
}
function baseTargetFromSource(raw,requested=''){
  const req=basePrettyText(requested).slice(0,110);
  const nr=norm(req);
  const generic=!req||/^(?:perfil profissional|objetivo profissional|curriculo|currículo|candidato)$/.test(nr)
    ||/\|\s*\d|habilidades principais|experiencia profissional|formacao academica/.test(nr);
  if(!generic)return req;
  const {primary}=baseSplitSource(raw);
  const sections=baseSections(primary);
  const expLine=(sections.experience||[]).find(x=>/\|\s*\d{1,2}\/\d{4}/.test(x))||'';
  const role=basePrettyText(expLine.split('|')[0]||'').replace(/^[–—-]+|[–—-]+$/g,'').trim();
  const eduLine=(sections.education||[]).find(x=>/graduacao em|bacharel|tecnologo|licenciatura/i.test(norm(x)))||'';
  const subject=basePrettyText(eduLine)
    .replace(/^.*?\b(?:graduacao|graduação|bacharelado|tecnologo|tecnólogo|licenciatura)\s+(?:em\s+)?/i,'')
    .replace(/\s+[–—-].*$/,'').trim();
  if(role&&subject&&!norm(role).includes(norm(subject))&&!norm(subject).includes(norm(role)))return `${role} | ${subject}`.slice(0,110);
  if(role)return role.slice(0,110);
  const firstExperience=baseExperience(raw)[0]||'';
  const experienceRole=parseExperienceEntry(firstExperience).role;
  if(experienceRole)return basePrettyText(experienceRole).slice(0,110);
  return (subject||'Perfil profissional').slice(0,110);
}

function baseSummary(content){
  const sentences=[];
  const higher=(content.education||[]).find(x=>/bacharel|graduacao|licenciatura|tecnologo|mestrado|doutorado|pos/.test(norm(x)));
  const expText=norm((content.experience||[]).join(' '));
  const tools=(content.skills||[]).filter(x=>!/^(Design|UX\/UI)$/i.test(x)).slice(0,4);

  if((content.experience||[]).length){
    const firstRole=parseExperienceEntry(content.experience[0]||'').role||String(content.target||'').split('|')[0].trim();
    sentences.push(firstRole?`Profissional com experiência como ${firstRole}.`:'Profissional com experiência comprovada.');
    const areas=[];
    if(/atendimento|publico|cliente/.test(expText))areas.push('atendimento ao público');
    if(/administrativ|document|planilha|registro/.test(expText))areas.push('rotinas administrativas');
    if(/caixa|pagamento|fechamento/.test(expText))areas.push('operação de caixa e pagamentos');
    if(/agenda|agendamento/.test(expText))areas.push('agendamentos');
    if(/venda/.test(expText))areas.push('apoio a vendas');
    if(areas.length)sentences.push(`Atuação comprovada em ${baseListPt(areas.slice(0,3))}.`);
  }else if(higher){
    const e=baseSplitEntry(higher);
    let subject=e.title.replace(/^(?:Bacharelado|Graduação|Licenciatura|Tecnólogo)\s+em\s+/i,'').trim()||e.title;
    const inst=e.institution.split(',')[0].trim();
    const sem=e.status.match(/(\d{1,2})\s*º?\s*semestre/i);
    if(/em andamento/.test(norm(e.status))&&sem){
      sentences.push(`Estudante de ${subject}, no ${sem[1]}º semestre${inst?` no ${inst}`:''}.`);
    }else if(/em andamento/.test(norm(e.status))){
      sentences.push(`Estudante de ${subject}${inst?` no ${inst}`:''}.`);
    }else{
      sentences.push(`Formação em ${e.title}${inst?` pelo ${inst}`:''}.`);
    }
  }else if(content.education?.length){
    sentences.push(`Formação: ${content.education[0].replace(/\s*\|\s*/g,', ')}.`);
  }

  if(!(content.experience||[]).length){
    const details=[];
    if(content.courses?.length){
      const c=baseSplitEntry(content.courses[0]);
      const courseTitle=c.title.replace(/^Curso\s+de\s+/i,'').trim();
      details.push(`${courseTitle}${c.institution?` pela ${c.institution.split(',')[0]}`:''}`);
    }
    if(content.languages?.length){
      const lang=baseSplitEntry(content.languages[0]).title.replace(/\s*-\s*/g,' ').trim();
      if(lang)details.push(lang.charAt(0).toLowerCase()+lang.slice(1));
    }
    if(details.length)sentences.push(`Formação complementar em ${baseListPt(details)}.`);
  }

  const topics=[];
  const pn=norm((content.projects||[]).join(' '));
  if(/interface|aplicativo/.test(pn))topics.push('interfaces digitais');
  if(/prototipo|fluxograma/.test(pn))topics.push('prototipação');
  if(/revista|capa|editorial/.test(pn))topics.push('design editorial');
  if(/clinica|servico/.test(pn)&&!topics.length)topics.push('projetos acadêmicos');
  if(topics.length)sentences.push(`Projetos acadêmicos em ${baseListPt(topics.slice(0,3))}${tools.length?`, com uso de ${baseListPt(tools.slice(0,3))}`:''}.`);
  else if(tools.length&&!(content.experience||[]).length)sentences.push(`Conhecimentos em ${baseListPt(tools.slice(0,3))}.`);

  return sentences.join(' ').replace(/\s+/g,' ').trim().slice(0,520);
}

function baseContentLocal(raw,profile,target){
  const {primary}=baseSplitSource(raw);
  const edu=baseEducationData(primary);
  const sections=baseSections(primary);
  const other=[...(sections.additional||[])]
    .map(basePrettyText)
    .filter(x=>x&&x.length>=12&&!/^(?:habilidades|competencias|skills)$/i.test(x))
    .slice(0,4);
  const content={
    target,
    summary:'',
    education:edu.education,
    courses:edu.courses,
    experience:baseExperience(raw),
    projects:baseProjects(raw,target),
    skills:baseSkills(profile,target),
    languages:edu.languages,
    other
  };
  content.summary=baseSummary(content);
  return content;
}
export function debugBaseResumeContent(raw,profile={},focus=''){
  const sourceText=repairTextEncoding(raw||'');
  const {primary}=baseSplitSource(sourceText);
  const target=baseTargetFromSource(sourceText,focus||profile?.desiredArea||'');
  return {sourceText,sections:baseSections(primary),target,content:baseContentLocal(sourceText,profile,target)};
}
async function basePolishSummary(content,raw,profile){
  if(process.env.LETSWORK_BASE_AI_POLISH!=='1')return content.summary;
  const facts={
    target:content.target,education:content.education,courses:content.courses,
    projects:content.projects,skills:content.skills,languages:content.languages,experience:content.experience
  };
  const system='Voc\u00ea \u00e9 editor de curr\u00edculos. Reescreva apenas o resumo profissional em portugu\u00eas do Brasil. Use exclusivamente os fatos fornecidos, sem inventar experi\u00eancia, cargo, resultado, ferramenta, forma\u00e7\u00e3o ou senioridade. O texto deve funcionar sem imagens e soar profissional, objetivo e natural. Retorne somente JSON.';
  const prompt=`FATOS CONFIRMADOS:\n${JSON.stringify(facts)}\n\nEscreva um resumo de 2 ou 3 frases, entre 220 e 430 caracteres, em terceira pessoa ou forma impessoal, sem clich\u00eas vazios. Retorne {"summary":""}.`;
  try{
    const parsed=parseJsonLoose(await askAI(system,prompt,{candidateId:profile?.candidateId,lane:1,timeoutMs:30000,maxAttempts:1,numCtx:4096,numPredict:240,temperature:0.1}))||{};
    const candidate=basePrettyText(parsed.summary||'');
    const evidence=[content.education,content.courses,content.projects,content.skills,content.languages,content.experience].flat().join(' ');
    if(candidate&&groundedSummary(candidate,evidence,`${evidence} ${raw}`)){ const cn=norm(candidate),rn=norm(raw); const inventaExperiencia=/\bexperiencia\b/.test(cn)&&!workEvidenceRx.test(rn); const inventaCargo=/\b(?:desenvolvedor|desenvolvedora|especialista|senior|pleno|lider|coordenador|coordenadora|gerente)\b/.test(cn)&&!new RegExp('\\b(?:desenvolvedor|desenvolvedora|especialista|senior|pleno|lider|coordenador|coordenadora|gerente)\\b','i').test(rn); if(!inventaExperiencia&&!inventaCargo)return candidate; }
  }catch(e){
    console.log('[tailor] resumo IA indisponivel; mantendo resumo factual local:',String(e?.message||e));
  }
  return content.summary;
}

// Gera UMA versao-base otimizada. O envio em massa reutiliza este mesmo arquivo.
export async function optimizeBaseResume(source,profile,focus='',template='executive'){
  let sourceText=repairTextEncoding(profile?.rawText||'');
  if(sourceText.length<120)sourceText=await extractText(source);
  sourceText=repairTextEncoding(sourceText);
  if(sourceText.length<120)throw new Error('Nao foi possivel extrair conteudo factual suficiente do curriculo');

  const inferred=inferProfile(sourceText);
  const effectiveProfile={...(profile||{}),rawText:sourceText};
  for(const [key,value] of Object.entries(effectiveProfile)){
    if(typeof value==='string')effectiveProfile[key]=repairTextEncoding(value);
  }
  for(const key of ['email','phone','linkedin','portfolio','instagram','address','neighborhood','residenceCity','residenceState','cnhCategory']){
    if(String(inferred?.[key]||'').trim())effectiveProfile[key]=inferred[key];
  }
  effectiveProfile.name=repairTextEncoding(effectiveProfile.name||inferred.name||'');
  effectiveProfile.skills=[...new Set([...(Array.isArray(profile?.skills)?profile.skills:[]),...(inferred.skills||[])].map(x=>repairTextEncoding(String(x||'')).trim()).filter(Boolean))];

  const target=baseTargetFromSource(sourceText,focus||effectiveProfile.desiredArea||'');
  const content=baseContentLocal(sourceText,effectiveProfile,target);
  content.summary=await basePolishSummary(content,sourceText,effectiveProfile);

  const templateName=resumeTemplateName(template);
  const resumeFile=await renderResumePdf(source,{id:'base',title:target},effectiveProfile,content,templateName);
  const resumeValidation=await validateGeneratedPdf(resumeFile,effectiveProfile,content);
  if(resumeValidation.pages!==1)throw new Error('Currículo-base executivo deve ocupar exatamente 1 página');
  const finalPath=path.join(outputDir(source),'curriculo_base_otimizado.pdf');
  if(path.resolve(resumeFile)!==path.resolve(finalPath)){
    fs.copyFileSync(resumeFile,finalPath);
    try{fs.rmSync(resumeFile,{force:true});}catch{}
  }
  const text=await extractText(finalPath).catch(()=>sourceText);
  return {
    file:finalPath,
    text,
    focus:target,
    strategy:'structured-base-resume',
    template:templateName,
    changed:1,
    content,
    normalizedProfile:Object.fromEntries(Object.entries(effectiveProfile).filter(([key])=>key!=='supportDocuments')),
    portfolioFiles:[],
    validation:{
      resumePages:resumeValidation.pages,
      portfolioPages:0,
      totalPages:resumeValidation.pages,
      chars:resumeValidation.chars
    }
  };
}
