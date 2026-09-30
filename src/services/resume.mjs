import fs from 'fs';
import path from 'path';
import os from 'os';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';
import { createWorker } from 'tesseract.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { convertToDocx } from './office.mjs';

const imageExt=new Set(['.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff']);
const textExt=new Set(['.txt','.md','.csv','.json','.xml','.html','.htm']);
const wordExt=new Set(['.doc','.rtf','.odt']);
const preferredZipExt=['.docx','.pdf','.doc','.rtf','.odt','.txt','.png','.jpg','.jpeg'];
const asciiText=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const ignoredNameWords=/\b(?:curriculo|curriculum|perfil|contato|formacao|experiencia|habilidades|competencias)\b/i;

function mojibakeScore(value){
  const s=String(value||'');
  const patterns=[/Ã./g,/Â./g,/â[\u0080-\u00bf]{1,3}/g,/ð[\u0080-\u00bf]{1,3}/g,/ƒ\?/g,/Ç[\u0080-\u00ff]/g,/\uFFFD/g];
  return patterns.reduce((sum,rx)=>sum+(s.match(rx)||[]).length,0);
}
export function repairTextEncoding(value){
  let current=String(value||'');
  for(let i=0;i<3;i++){
    if(!/[ÃÂâðƒÇ]/.test(current))break;
    const next=Buffer.from(current,'latin1').toString('utf8');
    if(!next||next.includes('\uFFFD'))break;
    if(mojibakeScore(next)>=mojibakeScore(current))break;
    current=next;
  }
  return current
    .replace(/\u00a0/g,' ')
    .replace(/\r/g,'')
    .replace(/[ \t]+/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}


async function withOcrWorker(fn){
  let worker;
  try{worker=await createWorker('por');}
  catch{worker=await createWorker('eng');}
  try{return await fn(worker);}finally{await worker.terminate();}
}

function pageTextLines(content){
  const rows=new Map();
  for(const item of content.items||[]){
    const y=Math.round((item.transform?.[5]||0)/3)*3;
    if(!rows.has(y)) rows.set(y,[]);
    rows.get(y).push({x:item.transform?.[4]||0,text:item.str||''});
  }
  return [...rows.entries()].sort((a,b)=>b[0]-a[0])
    .map(([,parts])=>parts.sort((a,b)=>a.x-b.x).map(x=>x.text).join(' ').replace(/\s+/g,' ').trim())
    .filter(Boolean).join('\n');
}function poorPdfText(text){
  const clean=String(text||'').trim();
  if(clean.replace(/\s/g,'').length<80)return true;
  const tokens=clean.split(/\s+/).filter(Boolean);
  if(tokens.length<12)return true;
  const singles=tokens.filter(x=>/^\p{L}$/u.test(x)).length;
  const normal=tokens.filter(x=>/^\p{L}[\p{L}\p{N}.,;:/()#+-]{2,}$/u.test(x)).length;
  const singleRatio=singles/Math.max(1,tokens.length);
  const normalRatio=normal/Math.max(1,tokens.length);
  return singleRatio>0.22 || normalRatio<0.32;
}
async function readPdf(file){
  const data=new Uint8Array(fs.readFileSync(file));
  const doc=await pdfjs.getDocument({data,disableWorker:true}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i);
    pages.push(pageTextLines(await page.getTextContent()));
  }
  const text=repairTextEncoding(pages.join('\n'));
  if(!poorPdfText(text)) return text;
  return withOcrWorker(async worker=>{
    const chunks=[];
    for(let i=1;i<=Math.min(doc.numPages,12);i++){
      const page=await doc.getPage(i);
      const viewport=page.getViewport({scale:2.1});
      const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const recognized=(await worker.recognize(canvas.toBuffer('image/png'))).data.text||'';
      chunks.push(recognized);
    }
    const ocr=chunks.join('\n').trim();
    return repairTextEncoding(ocr);
  });
}

async function ocrImage(file){
  return withOcrWorker(async worker=>(await worker.recognize(file)).data.text||'');
}

async function readWordLegacy(file){
  const tmp=path.join(os.tmpdir(),`resume_${Date.now()}_${Math.random().toString(16).slice(2)}.docx`);
  try{await convertToDocx(file,tmp);return (await mammoth.extractRawText({path:tmp})).value;}
  finally{fs.rmSync(tmp,{force:true});}
}async function extractZip(file){
  const zip=new AdmZip(file);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cvzip-'));
  zip.extractAllTo(dir,true);
  const chunks=[];
  for(const entry of zip.getEntries()){
    if(entry.isDirectory) continue;
    const target=path.join(dir,entry.entryName);
    try{const txt=await extractText(target);if(txt) chunks.push(txt);}catch{}
  }
  fs.rmSync(dir,{recursive:true,force:true});
  return chunks.join('\n');
}

export async function extractText(file){
  const ext=path.extname(file).toLowerCase();
  if(ext==='.pdf') return readPdf(file);
  if(ext==='.docx') return repairTextEncoding((await mammoth.extractRawText({path:file})).value);
  if(wordExt.has(ext)) return readWordLegacy(file);
  if(ext==='.zip') return extractZip(file);
  if(imageExt.has(ext)) return repairTextEncoding(await ocrImage(file));
  if(textExt.has(ext)) return repairTextEncoding(fs.readFileSync(file,'utf8'));
  return '';
}

export function extractPreferredResumeFromZip(file,destDir){
  const zip=new AdmZip(file);
  const entries=zip.getEntries().filter(e=>!e.isDirectory);
  for(const ext of preferredZipExt){
    const entry=entries.find(e=>path.extname(e.entryName).toLowerCase()===ext && e.header.size>100);
    if(!entry) continue;
    const safe=path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]+/g,'_');
    const out=path.join(destDir,`zip_${Date.now()}_${safe}`);
    fs.writeFileSync(out,entry.getData());
    return out;
  }
  return null;
}const skillWords=[
  'excel','word','powerpoint','photoshop','illustrator','indesign','figma','canva','coreldraw',
  'javascript','typescript','python','java','sql','react','node','marketing','social media','ux','ui','design',
  'vendas','atendimento','customer success','rh','recursos humanos','financeiro','administrativo','inglês','ingles','espanhol'
];

function guessName(text){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const byLine=lines.find(x=>{
    const parts=x.split(/\s+/).filter(Boolean);
    return x.length>=5&&x.length<=80&&parts.length>=2&&parts.length<=7&&!x.includes('@')&&!ignoredNameWords.test(asciiText(x))&&/^[\p{L}' -]+$/u.test(x);
  });
  if(byLine)return byLine;
  const head=String(text||'').slice(0,320);
  const upper=head.match(/\b(\p{Lu}{2,}(?:\s+(?:DA|DE|DO|DAS|DOS|E|\p{Lu}{2,})){1,6})\b/u);
  return upper?.[1]||'';
}

export function inferProfile(text){
  const raw=repairTextEncoding(text);
  const lines=raw.split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const clean=raw.replace(/\s+/g,' ').trim();
  const lower=clean.toLowerCase();
  const emailCandidate=clean.match(/[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\s*\.\s*[A-Z]{2,}/i)?.[0]||'';
  const email=emailCandidate.replace(/\s+/g,'');
  const phone=(()=>{
    for(const line of lines.slice(0,40)){
      let digits=String(line||'').replace(/\D/g,'');
      if((digits.length===12||digits.length===13)&&digits.startsWith('55'))digits=digits.slice(2);
      if(digits.length===10||digits.length===11){
        const ddd=digits.slice(0,2),local=digits.slice(2);
        if(Number(ddd)>=11&&Number(ddd)<=99&&local.length>=8){
          return `(${ddd}) ${local.length===9?local.slice(0,5):local.slice(0,4)}-${local.slice(-4)}`;
        }
      }
    }
    const loose=clean.match(/(?:\+?55\D{0,4})?\(?\s*\d{2}\s*\)?\D{0,6}9?\d{4}\D{0,6}\d{4}/)?.[0]||'';
    const digits=loose.replace(/\D/g,'').replace(/^55(?=\d{10,11}$)/,'');
    if(digits.length===10||digits.length===11){
      const ddd=digits.slice(0,2),local=digits.slice(2);
      return `(${ddd}) ${local.length===9?local.slice(0,5):local.slice(0,4)}-${local.slice(-4)}`;
    }
    return '';
  })();
  const links=[...clean.matchAll(/https?:\/\/[^\s)]+/g)].map(x=>x[0]);
  const normalizeWebUrl=value=>{const v=String(value||'').replace(/[),.;]+$/,'').trim();return v&&!/^https?:\/\//i.test(v)?'https://'+v:v;};
  let linkedin=normalizeWebUrl(clean.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9%._-]+/i)?.[0]||links.find(x=>/linkedin\.com/i.test(x))||'');
  if(!linkedin){
    const idx=lines.findIndex(x=>/(?:www\.)?linkedin\.com\/in\/\s*$/i.test(x));
    if(idx>=0){
      const nearby=lines.slice(idx+1,Math.min(lines.length,idx+3));
      for(const line of nearby){
        const slugs=[...line.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+){1,})\b/ig)].map(x=>x[1]);
        if(slugs.length){linkedin='https://www.linkedin.com/in/'+slugs[slugs.length-1];break;}
      }
    }
  }
  const instagram=normalizeWebUrl(clean.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/i)?.[0]||links.find(x=>/instagram\.com/i.test(x))||'');
  const portfolio=links.find(x=>!/linkedin\.com|instagram\.com/i.test(x))||'';
  const normalizedSkillText=lower.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const escapeRx=value=>String(value||'').replace(/[.*+?^$()|[\]{}\\]/g,'\\$&');
  const matchedSkills=skillWords.filter(x=>{
    const k=asciiText(x).trim();
    if(!k)return false;
    const phrase=escapeRx(k).replace(/\s+/g,'\\s+');
    return new RegExp('(^|[^a-z0-9])'+phrase+'([^a-z0-9]|$)','i').test(normalizedSkillText);
  });
  const skillMap=new Map(); for(const skill of matchedSkills){const key=asciiText(skill);if(!skillMap.has(key))skillMap.set(key,skill);}
  const skills=[...skillMap.values()];
  const labeled=(rx)=>{const line=lines.find(x=>rx.test(x));return line?.replace(rx,'').replace(/^\s*[:\-–—]\s*/,'').trim()||'';};
  const cpf=(labeled(/^(?:cpf)\b/i)||clean.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/)?.[0]||'').trim();
  const cep=(labeled(/^(?:cep)\b/i)||clean.match(/\b\d{5}-?\d{3}\b/)?.[0]||'').trim();
  const birthDate=(labeled(/^(?:data de nascimento|nascimento)\b/i).match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/)?.[0]||'').trim();
  let address=labeled(/^(?:endereço|endereco|logradouro)\b/i);
  if(!address)address=lines.find(x=>/^(?:rua|avenida|av\.?|estrada|travessa|alameda|rodovia|praça|praca)\b/i.test(x))||'';
  let neighborhood=labeled(/^(?:bairro)\b/i),residenceCity='',residenceState='';
  const states='AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';
  for(const line of lines){
    let m=line.match(new RegExp('^('+states+')\\s*[-–—]\\s*([^–—-]+?)(?:\\s*[-–—]\\s*(.+))?$','iu'));
    if(m){residenceState=m[1].toUpperCase();residenceCity=m[2].trim();if(!neighborhood&&m[3])neighborhood=m[3].trim();break;}
    m=line.match(new RegExp('^(.{2,60}?),\\s*('+states+')(?:,\\s*(?:BRASIL|BRAZIL))?$','i'));
    if(m&&!/@|https?:|www\./i.test(line)){residenceCity=m[1].trim();residenceState=m[2].toUpperCase();break;}
    m=line.match(new RegExp('^(.{2,60}?)\\s*[-–—/]\\s*('+states+')(?:,\\s*(?:BRASIL|BRAZIL))?$','iu'));
    if(m&&!/@|https?:|www\./i.test(line)){residenceCity=m[1].trim();residenceState=m[2].toUpperCase();break;}
  }
  return {name:guessName(raw),email,phone,linkedin,portfolio,instagram,skills,rawText:raw,
    cpf,birthDate,cep,address,neighborhood,residenceCity,residenceState,additionalFacts:''};
}