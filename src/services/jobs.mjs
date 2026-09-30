import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { storage } from '../storage.mjs';
import { db } from '../db.mjs';
import { queryRioInventory, queryInventorySources } from './inventory.mjs';
import { syncJobbolInventory, getJobbolInventoryStatus } from './jobbol.mjs';
import { askAI, parseJsonLoose } from './ai.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const uniqByUrl = rows => [...new Map(rows.filter(x => x.url).map(x => [x.url, x])).values()];
function fixMojibake(value){
  return String(value||'')
    .replace(/á/g,'á').replace(/à /g,'à').replace(/ã/g,'ã').replace(/â/g,'â')
    .replace(/é/g,'é').replace(/ê/g,'ê').replace(/í/g,'í')
    .replace(/ó/g,'ó').replace(/ô/g,'ô').replace(/õ/g,'õ').replace(/ú/g,'ú')
    .replace(/ç/g,'ç').replace(/Á/g,'Á').replace(/À/g,'À').replace(/Ã/g,'Ã')
    .replace(/É/g,'É').replace(/Ê/g,'Ê').replace(/Í/g,'Í').replace(/Ó/g,'Ó')
    .replace(/Ô/g,'Ô').replace(/Õ/g,'Õ').replace(/Ú/g,'Ú').replace(/Ç/g,'Ç')
    .replace(/–|—/g,'-').replace(/"|"/g,'"').replace(/'/g,"'").replace(/Â/g,'');
}
const norm = s => fixMojibake(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function cleanSearchCareerTerm(value){
  let v=fixMojibake(String(value||'')).replace(/\s+/g,' ').trim();
  v=v.replace(/^(?:curso\s+(?:complementar\s+)?(?:de\s+)?|bacharelado\s+(?:em\s+)?|graduacao\s+(?:em\s+)?|licenciatura\s+(?:em\s+)?|tecnologo\s+(?:em\s+)?)/i,'').trim();
  v=v.replace(/\s+(?:bacharelado|graduacao|licenciatura|tecnologo)$/i,'').trim();
  v=v.replace(/\s+(?:experiencia\s+do\s+usuario|user\s+experience|interfaces?\s+com\s+ia|inteligencia\s+artificial)\b.*$/i,'').trim();
  v=v.replace(/\s*[:|]\s*(?:experiencia\s+do\s+usuario|user\s+experience|interfaces?|inteligencia\s+artificial)\b.*$/i,'').trim();
  return v.replace(/[;,.]+$/,'').trim();
}

function inferredTerms(profile){
  return genericProfileTerms(profile);
}
function genericProfileTerms(profile){
  const primary=fixMojibake(String(profile.rawText||'').split(/\n=== DOCUMENTO DE APOIO:/i)[0]);
  const lines=primary.split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const out=[];
  const headings=/^(?:sobre mim|objetivo|perfil|resumo(?: de qualificacoes)?|formacoes?|formacao academica|formacao|educacao|experiencias? profissionais?|experiencias?|skills|habilidades?|competencias?|idiomas?|certificacoes?|informacoes adicionais)$/i;
  const roleWord=/\b(?:professor[ae]?|auxiliar|assistente|analista|tecnic[oa]|mediador[ae]?|monitor[ae]?|cuidador[ae]?|secretari[oa]|recepcionista|atendente|vendedor[ae]?|operador[ae]?|motorista|design(?:er)?|desenvolvedor[ae]?|programador[ae]?|engenheir[oa]|advogad[oa]|enfermeir[oa]|farmaceutic[oa]|contador[ae]?|consultor[ae]?|supervisor[ae]?|coordenador[ae]?|gerente|estagiari[oa]|redator[ae]?|copywriter|editor[ae]?|fotograf[oa]|arquiteto|psicolog[oa]|fisioterapeut[ae]?|nutricionist[ae]?|pedagog[oa]|revisor[ae]?|diagramador[ae]?|marketing|publicidade)\b/i;
  const genericOnly=/^(?:auxiliar|assistente|analista|designer|professor|professora|monitor|monitora|mediador|mediadora|secretaria|secretario|atendente|agente|operador|operadora|estagiario|estagiaria|tecnico|tecnica|especialista|consultor|consultora)$/i;
  const clean=value=>{
    let v=fixMojibake(String(value||''));
    v=v.replace(/\s*\|\s*(?:19|20)\d{2}.*$/,'').trim();
    v=v.split(/\s+(?:-|–|—)\s+/)[0].split(/\.\s+/)[0];
    v=v.replace(/^[•·*+\-–—/]+\s*/,'').replace(/^(?:área|area)\s+de\s+/i,'').replace(/[;,.]+$/,'').replace(/\s+/g,' ').trim();
    return v;
  };
  const add=value=>{
    const v=cleanSearchCareerTerm(clean(value));
    if(v.length<3||v.length>80)return;
    const n=norm(v);
    if(headings.test(n)||genericOnly.test(n))return;
    if(/@|https?:|www\.|\b\d{2,3}\s*anos?\b|\bsemestre\b|\bandamento\b|\bconcluido\b|\bcompleto\b|\b(?:19|20)\d{2}\b|\b(?:rj|sp|mg|es|pr|sc|rs|ba|pe|ce|df),?\s*brasil\b/.test(n))return;
    if(!out.some(x=>norm(x)===n))out.push(v);
  };
  const push=value=>{
    const raw=fixMojibake(String(value||'')).replace(/\s*\|.*$/,'').trim();
    add(raw);
    for(const part of raw.split(/\s*\/\s*/).map(x=>x.trim()).filter(Boolean))add(part);
  };

  // Objetivo profissional explícito também vira base de descoberta.
  for(const line of lines){
    const cleanLine=fixMojibake(line);
    const normalizedLine=norm(cleanLine);
    const m=normalizedLine.match(/(?:atuar|trabalhar|busco(?: uma)? oportunidade|crescer profissionalmente).*?(?:areas? de|area de)\s*([^.;]+)/i);
    if(m){
      for(const part of m[1].split(/,|\bou\b|\be\b/i).map(x=>x.trim()).filter(Boolean))push(part);
    }
    const area=normalizedLine.match(/\barea de\s+([^.;,]{3,60})/i);
    if(area)push(area[1]);
  }
  // Frases explícitas de experiência.
  for(const line of lines){
    const m=line.match(/\b(?:experiencia\s+como|experiência\s+como|trabalhad[oa]\s+como|atuacao\s+como|atuação\s+como|cargo(?: de)?|funcao(?: de)?|função(?: de)?)\s+([^,.;]{3,70})/i);
    if(m)push(m[1]);
  }

  // Formação declarada nos dois formatos mais comuns: 'Design Bacharelado' e 'Licenciatura em Pedagogia'.
  for(const line of lines){
    let m=line.match(/^(.{3,60}?)\s+(?:bacharelado|licenciatura|tecnologo|tecnólogo)\b/i);
    if(m)push(m[1]);
    m=line.match(/\b(?:licenciatura(?:\s+plena)?|bacharelado|tecnologo|tecnólogo|graduacao|graduação)\s+(?:em\s+)?([^|,(\-]{3,60})/i);
    if(m)push(m[1]);
  }

  // Cargos/cursos curtos que aparecem como linhas próprias. Remove instituição/sufixo depois do travessão.
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const first=clean(line);
    const firstNorm=norm(first);
    const taskSentence=/^(?:desenvolver|contribuir|apoiar|organizar|atender|realizar|elaborar|revisar|formatar|facilitar|potencializar|produzir|criar|acompanhar|prestar|controlar|auxiliar na|auxiliar em)\b/.test(firstNorm);
    if(first.length<=70&&roleWord.test(first)&&!headings.test(firstNorm)&&!taskSentence)push(first);
    if(/(?:19|20)\d{2}/.test(line)){
      for(const nearby of [lines[i-1],lines[i+1],lines[i+2]]){
        const v=clean(nearby);
        if(v&&v.length<=70&&roleWord.test(v))push(v);
      }
    }
  }

  // Skills só ajudam se já forem nomes profissionais, nunca ferramenta/idioma isolado.
  const ignoredSkills=/^(?:ingles|inglês|espanhol|frances|francês|word|powerpoint|canva|photoshop|figma|indesign|illustrator|excel)$/i;
  for(const skill of Array.isArray(profile.skills)?profile.skills:[]){
    if(!ignoredSkills.test(String(skill||'').trim())&&roleWord.test(String(skill||'')))push(skill);
  }
  return out.slice(0,24);
}
function compactProfessionalText(profile){
  const raw=String(profile.rawText||'');
  const parts=raw.split(/\n=== DOCUMENTO DE APOIO:/i);
  const primary=parts[0]||'';
  const support=parts.slice(1).join('\n');
  const cleanLines=text=>String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>!/(?:e-?mail|telefone|linkedin|instagram|cpf|cep|www\.|https?:)/i.test(x));
  const primaryLines=cleanLines(primary).slice(0,55);
  const supportLines=cleanLines(support).slice(0,90);
  const extras=[];
  if((profile.skills||[]).length) extras.push('COMPETÊNCIAS EXTRAÍDAS: '+(profile.skills||[]).join(', '));
  if(profile.additionalFacts) extras.push('INFORMAÇÕES ADICIONAIS: '+profile.additionalFacts);
  const blocks=['CURRÍCULO PRINCIPAL:',...primaryLines];
  if(supportLines.length)blocks.push('PORTFÓLIO / DOCUMENTOS DE APOIO:',...supportLines);
  blocks.push(...extras);
  return blocks.filter(Boolean).join('\n').slice(0,8500);
}
async function semanticSupportContext(profile){
  const raw=String(profile?.rawText||'');
  const parts=raw.split(/\n=== DOCUMENTO DE APOIO:/i);
  const support=parts.slice(1).join('\n').trim();
  if(support.length<80)return '';
  const dir=path.join(storage.data,'career-plan-cache');
  fs.mkdirSync(dir,{recursive:true});
  const hash=createHash('sha1').update(JSON.stringify({v:'support-semantic-v2',candidateId:profile?.candidateId||0,support})).digest('hex').slice(0,20);
  const file=path.join(dir,'support_'+hash+'.json');
  let data=null;
  try{if(fs.existsSync(file))data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const meaningfulSupport=x=>x&&typeof x==='object'&&(String(x.summary||'').trim()||['projectTypes','deliverables','areas','methods','toolsExplicit'].some(k=>Array.isArray(x[k])&&x[k].length));
  if(!meaningfulSupport(data)){
    const system='Extraia sinais profissionais factuais de documentos de apoio/portfolio com OCR ruidoso. Normalize o sentido do que esta explicitamente descrito, sem inventar ferramenta, experiencia, emprego, resultado ou habilidade. Um projeto de interface/prototipo pode ser classificado semanticamente como interface/UX/UI; uma revista/capa pode ser classificada como editorial/projeto grafico; use somente inferencias semanticas diretamente sustentadas pelo texto. Retorne somente JSON.';
    const prompt='OCR DO DOCUMENTO DE APOIO:\n'+support.slice(0,9000)+'\n\nRetorne exatamente {"summary":"resumo factual curto","projectTypes":[],"deliverables":[],"areas":[],"methods":[],"toolsExplicit":[]}. Seja abrangente nos tipos de projeto e entregaveis, mas conservador com ferramentas e experiencia profissional.';
    try{
      const text=await askAI(system,prompt,{candidateId:profile?.candidateId,timeoutMs:18000,maxAttempts:1,lane:0});
      const parsed=parseJsonLoose(text)||{};
      data=meaningfulSupport(parsed)?parsed:null;
      if(data)fs.writeFileSync(file,JSON.stringify(data),'utf8');
    }catch{data=null;}
  }
  if(!meaningfulSupport(data))return '';
  const lines=[];
  if(data.summary)lines.push('RESUMO DE PROJETOS: '+String(data.summary));
  for(const [label,key] of [['TIPOS DE PROJETO','projectTypes'],['ENTREGAVEIS','deliverables'],['AREAS SUSTENTADAS','areas'],['METODOS','methods'],['FERRAMENTAS EXPLICITAS','toolsExplicit']]){
    const arr=Array.isArray(data[key])?data[key].map(x=>String(x).trim()).filter(Boolean):[];
    if(arr.length)lines.push(label+': '+arr.slice(0,30).join(', '));
  }
  return lines.join('\n').slice(0,3500);
}
function obviousUnsafeTerm(term,sourceText){
  const t=norm(term),src=norm(sourceText);
  const elevated=/\b(senior|sr\.?|pleno|coordenador|coordenadora|gerente|supervisor|supervisora|head|diretor|diretora|lead|especialista)\b/;
  if(elevated.test(t)&&!elevated.test(src)) return true;
  const credentialRoots=['tecnic','enfermeir','medic','advogad','engenheir','arquitet','psicolog','fisioterapeut','farmaceut','dentist','odontolog','nutricion','contador','contabilista'];
  if(credentialRoots.some(root=>t.includes(root)&&!src.includes(root))) return true;
  return false;
}
function searchAliases(approved){
  const out=[];
  const genericSingles=new Set(['estagio','estagiario','estagiaria','assistente','auxiliar','analista','designer','tecnico','tecnica','junior','jr','trainee','senior','pleno','especialista','area','vaga']);
  for(const raw of approved){
    const term=String(raw||'').trim();if(!term)continue;
    out.push(term);
    let base=term
      .replace(/^(?:estagi[aá]ri[oa]|est[aá]gio|assistente|auxiliar|analista|designer|t[eé]cnic[oa])\s+(?:de|em|para)\s+/i,'')
      .replace(/^(?:estagi[aá]ri[oa]|est[aá]gio|assistente|auxiliar|analista|designer|t[eé]cnic[oa])\s+/i,'')
      .replace(/\s+(?:j[uú]nior|jr\.?|trainee|s[eê]nior|sr\.?)$/i,'')
      .trim();
    const tokens=norm(base).split(/\s+/).filter(Boolean);
    const single=tokens.length===1&&tokens[0].length>=4&&!genericSingles.has(tokens[0]);
    if(base.length>=2&&base.toLowerCase()!==term.toLowerCase()&&(tokens.length>=2||single))out.push(base);
  }
  return [...new Set(out)];
}
const SEARCH_TERM_TARGET=18;
const SEARCH_TERM_MIN=8;
const SEARCH_TERM_MAX=24;

function safeDeterministicQueryVariants(terms,experienceLevel='entry'){
  const out=[];
  const add=value=>{
    const v=String(value||'').replace(/\s+/g,' ').trim();
    if(v.length<3||v.length>90)return;
    if(!out.some(x=>norm(x)===norm(v)))out.push(v);
  };
  const baseTerms=[];
  for(const raw of terms||[]){
    const term=cleanSearchCareerTerm(raw);
    if(!term)continue;
    add(term);
    for(const alias of searchAliases([term]))add(alias);
    for(const family of deriveDiscoveryFamilies([term])){
      if(!baseTerms.some(x=>norm(x)===norm(family)))baseTerms.push(family);
      add(family);
    }
    const replacements=[
      [/\bprofessor\b/i,'Professora'],[/\bprofessora\b/i,'Professor'],
      [/\bmediador\b/i,'Mediadora'],[/\bmediadora\b/i,'Mediador'],
      [/\bcuidador\b/i,'Cuidadora'],[/\bcuidadora\b/i,'Cuidador'],
      [/\bvendedor\b/i,'Vendedora'],[/\bvendedora\b/i,'Vendedor'],
      [/\bconsultor\b/i,'Consultora'],[/\bconsultora\b/i,'Consultor'],
      [/\boperador\b/i,'Operadora'],[/\boperadora\b/i,'Operador'],
      [/\bredator\b/i,'Redatora'],[/\bredatora\b/i,'Redator'],
      [/\bjúnior\b/i,'Junior'],[/\bjunior\b/i,'Júnior']
    ];
    for(const [rx,to] of replacements)if(rx.test(term))add(term.replace(rx,to));
  }

  const mode=String(experienceLevel||'entry').toLowerCase();
  const alreadyRole=/^(?:estagio|estagiario|estagiaria|assistente|auxiliar|aprendiz|jovem aprendiz|trainee|atendente|recepcionista|operador|operadora|caixa|vendedor|vendedora)\b/i;
  for(const family of baseTerms.slice(0,8)){
    const n=norm(family);
    if(alreadyRole.test(n))continue;
    const variants=mode==='none'
      ? ['Estágio '+family,'Jovem Aprendiz '+family]
      : ['Assistente de '+family,'Auxiliar de '+family,'Estágio em '+family];
    for(const v of variants){add(v);if(out.length>=SEARCH_TERM_MAX)break;}
    if(out.length>=SEARCH_TERM_MAX)break;
  }
  return out.slice(0,SEARCH_TERM_MAX);
}
function validExpansionRows(rows,allowed,basis,sanitize){
  const allowedMap=new Map((allowed||[]).map(x=>[norm(x),x]));
  const out=[];
  for(const row of Array.isArray(rows)?rows:[]){
    const query=String(row?.query||'').trim();
    const basedOn=String(row?.basedOn||'').trim();
    if(!query||!basedOn||!allowedMap.has(norm(basedOn)))continue;
    const clean=sanitize([query])[0];
    if(!clean||obviousUnsafeTerm(clean,basis))continue;
    if(!out.some(x=>norm(x)===norm(clean)))out.push(clean);
  }
  return out;
}
function deriveDiscoveryFamilies(terms){
  const out=[];
  const levelTail=/\s+(?:junior|júnior|jr\.?|trainee|pleno|senior|sênior|sr\.?)$/i;
  const genericOnly=new Set('estagio estagiario estagiaria assistente auxiliar analista designer professor professora monitor monitora mediador mediadora inspetor inspetora secretario secretaria recepcionista atendente agente operador operadora especialista consultor consultora coordenador coordenadora supervisor supervisora gerente diretor diretora orientador orientadora'.split(' ').map(norm));
  const rolePrefix=/^(?:estagiario|estagiaria|estagio|assistente|auxiliar|analista|designer|professor|professora|monitor|monitora|mediador|mediadora|inspetor|inspetora|secretario|secretaria|recepcionista|atendente|agente|operador|operadora|especialista|consultor|consultora|coordenador|coordenadora|supervisor|supervisora|gerente|diretor|diretora|orientador|orientadora)\s+(?:de|em|para)\s+/i;
  const add=value=>{
    let v=fixMojibake(String(value||'')).split(/\s+(?:-|–|—)\s+/)[0].replace(/[;,.]+$/,'').trim();
    if(!v||/\b(?:semestre|andamento|concluido|concluído|completo)\b/i.test(norm(v)))return;
    v=v.replace(levelTail,'').trim();
    if(!v)return;
    const before=v;
    const ascii=norm(v);
    const m=ascii.match(rolePrefix);
    if(m){
      const prefixLen=m[0].length;
      v=v.slice(prefixLen).trim();
    }else{
      v=before;
    }
    if(!v)return;
    const n=norm(v),parts=n.split(/\s+/).filter(Boolean);
    if(genericOnly.has(n))return;
    if(parts.length===1&&parts[0].length<6&&!/^(?:ux|ui|ti|rh)$/i.test(parts[0]))return;
    if(!out.some(x=>norm(x)===n))out.push(v);
  };
  for(const term of terms||[])add(term);
  return out.slice(0,32);
}
function deterministicCareerPlan(profile,typed=[],filters={}){
  const primary=fixMojibake(String(profile?.rawText||'').split(/\n=== DOCUMENTO DE APOIO:/i)[0]);
  const lines=primary.split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const objective=[],experience=[],education=[],educationExtras=[],courses=[],links=[];
  const add=(arr,value,basedOn=value)=>{
    let v=fixMojibake(String(value||'')).replace(/^[•·*+\-–—]+\s*/,'').replace(/[;,.]+$/,'').replace(/\s+/g,' ').trim();
    if(v.length<3||v.length>90)return;
    if(/@|https?:|www\.|telefone|cpf|cep/i.test(v))return;
    const n=norm(v);
    if(/^(?:concluido|concluida|nao concluido|não concluído|em andamento|atualmente|presente)$/.test(n))return;
    if(!arr.some(x=>norm(x)===n)){arr.push(v);links.push({term:v,basedOn:fixMojibake(String(basedOn||v)).slice(0,180)});}
  };
  const splitRole=value=>{
    const raw=String(value||'').replace(/\s*\|\s*(?:19|20)\d{2}.*$/,'').trim();
    add(experience,raw,value);
    for(const part of raw.split(/\s*\/\s*/).map(x=>x.trim()).filter(Boolean)){
      const pn=norm(part),words=pn.split(/\s+/).filter(Boolean);
      if(words.length>=2||(words.length===1&&pn.length>=6))add(experience,part,value);
    }
  };
  const headingKind=value=>{
    const n=norm(value).replace(/[:\-–—]+$/,'').trim();
    if(/^(?:objetivo|objetivo profissional|sobre mim|perfil|resumo|resumo profissional|resumo de qualificacoes)$/.test(n))return 'objective';
    if(/^(?:experiencia|experiencias|experiencia profissional|experiencias profissionais|historico profissional)$/.test(n))return 'experience';
    if(/^(?:formacao|formacoes|formacao academica|educacao|escolaridade)$/.test(n))return 'education';
    if(/^(?:certificacoes|certificacao|cursos|cursos complementares|curso complementar|qualificacoes|formacao complementar)$/.test(n))return 'course';
    if(/^(?:habilidades|habilidades e competencias|competencias|skills|idiomas|informacoes adicionais)$/.test(n))return 'other';
    return '';
  };
  const cleanCourse=value=>{
    const v=String(value||'').replace(/^[•·*+\-–—]+\s*/,'').replace(/[;,.]+$/,'').trim();
    return v.split(/\s+[–—-]\s+[A-Z0-9][A-Za-z0-9 .&]{1,40}$/)[0].trim();
  };
  const occupationalPrefix=/^(?:assistente|auxiliar|tecnic[oa]|analista|operador[ae]?|recepcionista|atendente|cuidador[ae]?|monitor[ae]?|mediador[ae]?|inspetor[ae]?|secretari[oa]|professor[ae]?|designer|desenvolvedor[ae]?|programador[ae]?|consultor[ae]?|revisor[ae]?|redator[ae]?|editor[ae]?|diagramador[ae]?)\b/i;

  // Explicit objective/summary role statements work across resume layouts.
  const joined=lines.join(' ');
  for(const m of joined.matchAll(/\b(?:experiencia\s+como|experiência\s+como|trabalhad[oa]\s+como|atuacao\s+como|atuação\s+como)\s+([^,.;]{3,80})/gi))splitRole(m[1]);
  for(const m of joined.matchAll(/\b(?:areas?|áreas?)\s+de\s+([^.;]{3,180})/gi)){
    for(const part of m[1].split(/,|\s+ou\s+/i).map(x=>x.trim()).filter(Boolean))add(objective,part,m[0]);
  }
  for(const m of joined.matchAll(/\b(?:area|área)\s+de\s+([^.;,]{3,80})/gi))add(objective,m[1],m[0]);

  let section='other';
  for(let idx=0;idx<lines.length;idx++){
    const line=lines[idx],hk=headingKind(line);
    if(hk){section=hk;continue;}
    const n=norm(line);
    const next=lines[idx+1]||'',next2=lines[idx+2]||'';
    const isBullet=/^[•·*+\-–—]/.test(line);

    if(section==='objective'){
      if(line.length<=220&&!isBullet){
        const m=line.match(/(?:atuar|trabalhar|oportunidade).*?(?:areas?|áreas?)\s+de\s+(.+)/i);
        if(m)for(const part of m[1].split(/,|\s+ou\s+/i).map(x=>x.trim()).filter(Boolean))add(objective,part,line);
      }
    }

    if(section==='experience'&&!isBullet){
      const roleLike=value=>{
        const v=String(value||'').trim(),vn=norm(v);
        if(!v||v.length>80||!/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(v))return false;
        if(/[.;:]$/.test(v))return false;
        if(/^(?:desenvolver|contribuir|apoiar|organizar|atender|realizar|elaborar|revisar|formatar|facilitar|potencializar|produzir|criar|acompanhar|prestar|controlar|auxiliar\s+(?:na|no|em)|mesmos?\b|alunos?\b|clientes?\b)/.test(vn))return false;
        return true;
      };
      const pipe=line.match(/^(.{3,90}?)\s*\|\s*(?:19|20)\d{2}/);
      if(pipe&&roleLike(pipe[1]))splitRole(pipe[1]);
      else if(roleLike(line)&&/^[•·*+\-–—]/.test(next))splitRole(line);
      else if(/(?:19|20)\d{2}/.test(line)&&roleLike(next)&&/^[•·*+\-–—]/.test(next2))splitRole(next);
    }

    if(section==='education'||/\b(?:bacharelado|licenciatura|tecnologo|tecnólogo|graduacao|graduação)\b/i.test(line)){
      let subject='';
      let m=line.match(/^(.{3,60}?)\s+(?:bacharelado|licenciatura|tecnologo|tecnólogo)\b/i);
      if(m)subject=m[1];
      if(!subject){m=line.match(/\b(?:licenciatura(?:\s+plena)?|bacharelado|tecnologo|tecnólogo|graduacao|graduação)\s+(?:em\s+)?([^|,(–—-]{3,60})/i);if(m)subject=m[1];}
      if(subject){
        const nearby=norm([line,next,next2].join(' '));
        add(education,subject,line);
        if(/\b(?:cursando|em andamento|semestre|periodo|período|previsao de conclusao|previsão de conclusão)\b/.test(nearby)&&!/\b(?:nao concluido|não concluído|trancad[oa]|interrompido)\b/.test(nearby))add(objective,subject,line);
      }else if(section==='education'&&!isBullet&&line.length>=4&&line.length<=90){
        const nn=norm(line);
        if(!/\b(?:ensino medio|ensino médio|colegio|colégio|universidade|faculdade|instituto|concluido|concluído|andamento|semestre|periodo|período|senac|ibmr)\b/.test(nn))educationExtras.push({term:line,basedOn:line});
      }
    }

    if(section==='course'&&!isBullet){
      const course=cleanCourse(line);
      if(course.length>=4&&course.length<=90)courses.push({term:course,basedOn:line});
    }
  }

  // Explicit area supplied by the user always leads the plan.
  for(const area of typed||[])add(objective,area,'Área pretendida informada: '+area);

  const uniq=list=>[...new Map(list.map(x=>[norm(x),x])).values()];
  let core=uniq([...objective,...experience]);
  const edu=uniq(education);
  const coreTokens=new Set(core.flatMap(x=>norm(x).split(/[^a-z0-9]+/).filter(t=>t.length>=4)));
  const adjacent=[];
  for(const row of [...educationExtras,...courses]){
    const clean=row.term?cleanCourse(row.term):'';
    const t=norm(clean),tokens=t.split(/[^a-z0-9]+/).filter(x=>x.length>=4);
    const related=tokens.some(x=>coreTokens.has(x));
    if(clean&&(occupationalPrefix.test(clean)||related))add(adjacent,clean,row.basedOn||row.term);
  }
  if(!core.length){
    core=edu.slice(0,12);
    if(!core.length)core=uniq(adjacent).slice(0,12);
  }
  const literal=uniq([...objective,...experience,...edu,...adjacent]);
  const singleAllowed=new Set(literal.map(norm));
  const keepTerm=value=>{
    const n=norm(value).trim(),parts=n.split(/\s+/).filter(Boolean);
    return parts.length>=2||singleAllowed.has(n);
  };
  const derived=deriveDiscoveryFamilies([...core,...edu,...adjacent]).filter(keepTerm);
  const families=uniq([...edu,...core,...adjacent,...derived]).filter(keepTerm).slice(0,36);
  const adj=uniq(adjacent).filter(x=>!core.some(y=>norm(y)===norm(x))).slice(0,30);
  const queries=uniq([...families,...core,...adj]).filter(keepTerm).slice(0,70);
  const focus=(typed.length?typed:objective.length?objective:experience.length?experience:edu.length?edu:core).slice(0,4).join(', ');
  const final=[...queries];
  final.focus=focus;
  final.literal=literal.slice(0,30);
  final.families=families;
  final.core=core.slice(0,30);
  final.adjacent=adj;
  final.queries=queries;
  final.targets=uniq([...families,...core,...adj,...queries]).slice(0,180);
  final.exclusions=[];
  final.links=links.filter(x=>final.targets.some(t=>norm(t)===norm(x.term))).slice(0,100);
  final.evidenceVersion=2;
  final.planVersion='quality-agent-v18-deterministic-base';
  final.searchTermTarget=70;
  final.searchTermCount=queries.length;
  return final;
}

export async function buildSearchTerms(profile, filters) {
  const typed=String(filters.area||'').split(/[,;/]/).map(x=>x.trim()).filter(Boolean);
  const rioOnly=filters.publicSourcesOnly===true&&Array.isArray(filters.publicSourceKeys)&&filters.publicSourceKeys.length===1&&filters.publicSourceKeys[0]==='rio';
  const curriculum=compactProfessionalText(profile);
  // Um único passe: o texto extraído dos documentos de apoio já faz parte do contexto profissional.
  // Evita uma segunda chamada de IA antes do planejamento de carreira.
  const evidence=curriculum;
  const basis=typed.length?`ÁREA PRETENDIDA: ${typed.join(', ')}\nCURRÍCULO E APOIO: ${evidence}`:evidence;
  const system='Voce e o planejador de carreira e busca do LetsWork. Construa uma arvore profissional INDIVIDUAL para o candidato. Se houver AREA PRETENDIDA explicita, ela tem prioridade maxima. Caso contrario, derive o foco da formacao, cursos, experiencias relevantes, portfolio/documentos de apoio e competencias comprovadas. Nao existe profissao globalmente proibida: qualquer area pode ser core se o perfil sustentar isso. Nao abra uma segunda carreira so porque uma vaga e de entrada. Expanda apenas para areas adjacentes sustentadas pelos mesmos conhecimentos, formacao, ferramentas ou entregaveis. Nao invente formacao, licenca, experiencia, ferramenta ou senioridade. Retorne somente JSON.';
  const prompt=`DADOS VERIFICADOS:\n${String(basis).slice(0,6000)}\n\nNIVEL DE EXPERIENCIA: ${filters.experienceLevel||'entry'}\n\nMonte a arvore profissional individual. core = cargos diretamente ligados ao foco. adjacent = cargos de areas realmente adjacentes que aproveitam a MESMA formacao, experiencia, cursos, portfolio, ferramentas ou entregaveis. families = nomes amplos das familias profissionais para DESCOBERTA, sem senioridade. Inclua tambem familias guarda-chuva em que os entregaveis do candidato aparecem com frequencia, mesmo quando o titulo da vaga nao traz o cargo principal; a vaga individual sera validada depois. queries = termos de pesquisa de alto recall dentro dessa arvore, com nomes de cargos, sinonimos e especialidades usados no Brasil. exclude = profissoes, especializacoes ou colisoes de palavra-chave incompatíveis COM ESTE CANDIDATO, e nunca uma lista global fixa. O plano serve para descoberta, nao para aprovacao final: uma family ampla pode encontrar vagas ambiguas que serao lidas depois. Nao exclua uma familia inteira apenas porque uma ferramenta especifica nao aparece; requisitos obrigatorios sao verificados na vaga individual. Para qualquer area, aplique o mesmo principio: descobrir amplo dentro da carreira factual e endurecer na decisao individual. Gere 3-8 families, 4-12 core, 0-8 adjacent e 6-18 queries quando houver base factual. As queries devem cobrir sinonimos, titulos equivalentes e nomes usados em anuncios no Brasil, sem abrir outra carreira. Para cada item de families/core/adjacent, inclua em links um basedOn que seja uma CITAÇÃO CURTA E LITERAL existente em DADOS VERIFICADOS e que justifique o termo. Ferramenta, software ou idioma isolado não basta como basedOn para abrir uma carreira. Retorne exatamente {"focus":"...","families":[...],"core":[...],"adjacent":[...],"queries":[...],"exclude":[...],"links":[{"term":"termo exato de families/core/adjacent","basedOn":"trecho literal dos dados verificados"}]}.`;
  const planDir=path.join(storage.data,'career-plan-cache');
  fs.mkdirSync(planDir,{recursive:true});
  const planHash=createHash('sha1').update(JSON.stringify({plannerVersion:'quality-agent-v22-compact-queries',candidateId:profile.candidateId||0,basis,experienceLevel:filters.experienceLevel||'entry'})).digest('hex').slice(0,20);
  const planFile=path.join(planDir,`plan_${planHash}.json`);
  let parsed=null;
  const literalSeeds=genericProfileTerms(profile);
  const skillSet=new Set((profile.skills||[]).map(x=>norm(x).trim()).filter(Boolean));
  const deterministicFallback=deterministicCareerPlan(profile,typed,filters);
  const baselinePlan={
    focus:String(deterministicFallback.focus||typed.join(', ')||literalSeeds.slice(0,3).join(', ')),
    families:Array.isArray(deterministicFallback.families)?deterministicFallback.families:literalSeeds.slice(0,12),
    core:Array.isArray(deterministicFallback.core)?deterministicFallback.core:literalSeeds.slice(0,18),
    adjacent:Array.isArray(deterministicFallback.adjacent)?deterministicFallback.adjacent:[],
    queries:Array.isArray(deterministicFallback.queries)?deterministicFallback.queries:literalSeeds.slice(0,24),
    exclude:Array.isArray(deterministicFallback.exclusions)?deterministicFallback.exclusions:[],
    links:Array.isArray(deterministicFallback.links)?deterministicFallback.links:[]
  };
  const prior=(!typed.length&&filters.priorCareerPlan&&typeof filters.priorCareerPlan==='object'&&Number(filters.priorCareerPlan.evidenceVersion||0)>=1&&String(filters.priorCareerPlan.planVersion||'')==='quality-agent-v22-compact-queries')?filters.priorCareerPlan:null;
  if(prior&&String(prior.focus||'').trim()&&Array.isArray(prior.core)&&prior.core.length>=2){
    parsed={
      focus:String(prior.focus||'').trim(),
      families:Array.isArray(prior.families)?prior.families:[],
      core:prior.core,
      adjacent:Array.isArray(prior.adjacent)?prior.adjacent:[],
      queries:Array.isArray(prior.queries)?prior.queries:[],
      exclude:Array.isArray(prior.exclude)?prior.exclude:[],
      links:Array.isArray(prior.links)?prior.links:[],
      evidenceVersion:Number(prior.evidenceVersion||0),
      planVersion:String(prior.planVersion||'')
    };
  }
  if(!parsed)try{if(fs.existsSync(planFile))parsed=JSON.parse(fs.readFileSync(planFile,'utf8'));}catch{}
  if(!parsed&&process.env.LETSWORK_SEARCH_AI_ENRICH==='1'){
    try{
      const text=await askAI(system,prompt,{candidateId:profile.candidateId,timeoutMs:12000,queueTimeoutMs:12000,maxAttempts:1,lane:0,numCtx:4096,numPredict:700,temperature:0.1});
      parsed=parseJsonLoose(text)||{};
      if(!Object.keys(parsed).length)console.warn('[career-plan-ai-invalid]',String(text||'').slice(0,1800));
      if(parsed&&Object.keys(parsed).length)try{fs.writeFileSync(planFile,JSON.stringify(parsed),'utf8');}catch{}
    }catch(e){console.warn('[career-plan-ai]',String(e?.message||e));}
  }
  if(!parsed)parsed=baselinePlan;
  const sanitize=list=>[...new Set((Array.isArray(list)?list:[]).map(x=>cleanSearchCareerTerm(x)).filter(Boolean).filter(x=>!obviousUnsafeTerm(x,basis)).filter(x=>!/^(?:estudante|tecnologo|bacharel|graduando|graduanda|formado|formada|curso de)\b/i.test(norm(x))))];

  const basisNorm=norm(basis);
  const typedNorm=typed.map(norm);
  const literalNorm=literalSeeds.map(norm);
  const linkRows=()=>Array.isArray(parsed?.links)?parsed.links:[];
  const canonicalCareerTerm=value=>{
    let n=norm(value).trim();
    n=n.replace(/^(?:estagiario|estagiaria|estagio|assistente|auxiliar|analista|tecnico|tecnica|trainee|aprendiz|jovem aprendiz)\\s+(?:de|em|para)\\s+/,'');
    n=n.replace(/\\s+(?:junior|jr\\.?|trainee|pleno|senior|sr\\.?)$/,'');
    n=n.replace(/\\s+(?:bacharelado|licenciatura|tecnologo)$/,'');
    return n.trim();
  };
  const directCareerAnchor=(term,anchors)=>{
    const tn=norm(term).trim(),tc=canonicalCareerTerm(term);
    if(!tn||!tc)return false;
    return anchors.some(raw=>{
      const an=norm(raw).trim(),ac=canonicalCareerTerm(raw);
      return an===tn||(ac&&ac===tc);
    });
  };
  const skillTokens=new Set([...skillSet].flatMap(x=>x.split(/[^a-z0-9+#]+/)).filter(x=>x.length>=2));
  const toolOnlyEvidence=value=>{
    const tokens=norm(value).split(/[^a-z0-9+#]+/).filter(x=>x.length>=2);
    return tokens.length>0&&tokens.every(x=>skillTokens.has(x));
  };
  const validEvidenceLink=(term,links=linkRows())=>{
    const tn=norm(term).trim();
    if(!tn)return false;
    if(directCareerAnchor(term,typed))return true;
    // Direct literal variants are valid; new specialties need an explicit evidence link.
    if(directCareerAnchor(term,literalSeeds))return true;
    const row=links.find(x=>norm(x?.term||'').trim()===tn);
    if(!row)return false;
    const based=norm(row.basedOn||'').trim();
    if(based.length<6||!basisNorm.includes(based))return false;
    if((skillSet.has(based)||toolOnlyEvidence(based))&&!directCareerAnchor(row.basedOn,literalSeeds)&&!directCareerAnchor(row.basedOn,typed))return false;
    return true;
  };
  const validateLinkedPlan=value=>{
    const obj=value&&typeof value==='object'?value:{};
    const links=Array.isArray(obj.links)?obj.links:[];
    const filterTerms=list=>[...new Set((Array.isArray(list)?list:[]).map(x=>String(x).trim()).filter(Boolean).filter(x=>validEvidenceLink(x,links)))];
    const core=filterTerms(obj.core);
    const adjacent=filterTerms(obj.adjacent);
    const families=filterTerms(obj.families);
    const focus=String(obj.focus||'').trim();
    const focusValid=typed.length>0||core.length>0||families.length>0;
    return {ok:focusValid&&core.length>=1&&(core.length+adjacent.length+families.length)>=3,focus,families,core,adjacent,links};
  };

  const planQuality=value=>{
    const obj=value&&typeof value==='object'?value:{};
    const linked=validateLinkedPlan(obj);
    const terms=[...(Array.isArray(obj.families)?obj.families:[]),...(Array.isArray(obj.core)?obj.core:[]),...(Array.isArray(obj.adjacent)?obj.adjacent:[]),...(Array.isArray(obj.queries)?obj.queries:[])].map(x=>String(x).trim()).filter(Boolean);
    const focus=String(obj.focus||'').trim();
    // Segurança vem da âncora profissional validada, não de proibir termos que também aparecem em skills.
    // Assim "Design" pode ser carreira, enquanto uma ferramenta solta como "Canva" continua sem âncora profissional.
    return {ok:linked.ok&&terms.length>=2,focus,linked};
  };
  let quality=planQuality(parsed);
  if(!quality.ok){
    if(!literalSeeds.length)throw new Error('Não foi possível inferir uma árvore profissional segura para este currículo');
    parsed=baselinePlan;
    quality=planQuality(parsed);
    if(!quality.ok)throw new Error('Currículo sem evidência profissional suficiente para busca automática segura');
  }
  const linkedPlan=validateLinkedPlan(parsed);
  let core=sanitize(linkedPlan.core);

  let adjacent=sanitize(linkedPlan.adjacent).filter(x=>!core.includes(x));
  let generated=[...core,...adjacent];
  const aiFamilies=sanitize(linkedPlan.families).slice(0,24);
  const derivedFamilies=deriveDiscoveryFamilies([...core,...adjacent,...literalSeeds]);
  const literalOrTypedSingle=new Set([...typed,...literalSeeds].map(x=>norm(x).trim()).filter(Boolean));
  const keepDiscoveryTerm=value=>{
    const n=norm(value).trim(),parts=n.split(/\s+/).filter(Boolean);
    return parts.length>=2||literalOrTypedSingle.has(n);
  };
  const families=[...new Set([...aiFamilies,...derivedFamilies].map(x=>String(x).trim()).filter(Boolean))]
    .filter(keepDiscoveryTerm).slice(0,36);
  const plannedQueries=sanitize(parsed.queries).filter(keepDiscoveryTerm);
  if(generated.length<5){
    const fallbackSeeds=sanitize([...genericProfileTerms(profile),...inferredTerms(profile)]);
    const extras=fallbackSeeds.filter(x=>!generated.includes(x)).slice(0,24);
    core=[...new Set([...core,...extras.slice(0,18)])];
    adjacent=[...new Set([...adjacent,...extras.slice(18)])].filter(x=>!core.includes(x));
    generated=[...core,...adjacent];
  }
  if(!generated.length&&!plannedQueries.length)throw new Error('Não foi possível inferir uma árvore profissional suficiente para este currículo');
  const roleSeeds=generated.length?generated:plannedQueries.slice(0,40);
  const allowedBases=sanitize([...typed,...families,...core,...adjacent,...plannedQueries,...literalSeeds]).slice(0,90);
  const deterministic=safeDeterministicQueryVariants(allowedBases,filters.experienceLevel||'entry');
  let queries=[...new Set([...families,...plannedQueries,...deterministic])].filter(Boolean).filter(keepDiscoveryTerm);
  if(!rioOnly&&queries.length<SEARCH_TERM_MIN){
    const expansionFile=path.join(planDir,'terms_'+planHash+'.json');
    let expansionRows=null;
    try{if(fs.existsSync(expansionFile)){const cached=JSON.parse(fs.readFileSync(expansionFile,'utf8'));expansionRows=Array.isArray(cached)&&cached.length?cached:null;}}catch{}
    if(!Array.isArray(expansionRows)){
      try{
        const expansionSystem='Expanda termos de busca de vagas SEM abrir nova carreira. Cada termo novo deve ser apenas sinonimo, titulo equivalente, grafia alternativa ou nome usado em anuncios para uma ocupacao/familia ja aprovada. Nao invente formacao, ferramenta, senioridade, licenca ou area nova. Retorne somente JSON.';
        const expansionPrompt='FOCO: '+String(parsed.focus||typed.join(', ')||'')+'\nBASES PERMITIDAS:\n'+JSON.stringify(allowedBases)+'\n\nTERMOS JA EXISTENTES:\n'+JSON.stringify(queries.slice(0,120))+'\n\nCrie apenas termos adicionais realmente distintos, sem ultrapassar 24 termos unicos no total. Para CADA item informe basedOn usando exatamente uma string de BASES PERMITIDAS. Retorne exatamente {"queries":[{"query":"termo de busca","basedOn":"base exata"}]}.';
        const expanded=parseJsonLoose(await askAI(expansionSystem,expansionPrompt,{candidateId:profile.candidateId,timeoutMs:9000,maxAttempts:1}))||{};
        expansionRows=Array.isArray(expanded.queries)?expanded.queries:[];
        if(expansionRows.length)try{fs.writeFileSync(expansionFile,JSON.stringify(expansionRows),'utf8');}catch{}
      }catch{expansionRows=[];}
    }
    queries=[...new Set([...queries,...validExpansionRows(expansionRows,allowedBases,basis,sanitize)])];
  }

  queries=queries.slice(0,SEARCH_TERM_MAX);
  const exclusions=Array.isArray(parsed.exclude)?[...new Set(parsed.exclude.map(x=>String(x).trim()).filter(x=>x.length>=3))].slice(0,24):[];
  const final=[...new Set([...typed,...queries])].slice(0,SEARCH_TERM_MAX);
  final.focus=String(parsed.focus||typed.join(', ')||'').trim();
  final.literal=genericProfileTerms(profile).slice(0,24);
  final.families=families;
  final.core=[...new Set([...typed,...core])].slice(0,30);
  final.adjacent=adjacent.slice(0,30);
  final.queries=queries;
  final.targets=[...new Set([...families,...core,...adjacent,...queries])].slice(0,48);
  final.exclusions=exclusions;
  final.links=Array.isArray(parsed.links)?parsed.links:[];
  final.evidenceVersion=2;
  final.planVersion='quality-agent-v22-compact-queries';
  final.searchTermTarget=SEARCH_TERM_TARGET;
  final.searchTermCount=queries.length;
  return final;
}
function titleSalary(title) {
  const m = String(title || '').match(/R\$\s*[\d.]+(?:,\d{2})?(?:\s*(?:a|até)\s*R\$\s*[\d.]+(?:,\d{2})?)?/i);
  if (m) return m[0].replace(/\s+/g,' ').trim();
  if (/pretens[aã]o salarial/i.test(title || '')) return 'Pretensão salarial';
  return '';
}

function titleLocation(title) {
  const parts = String(title || '').split(/\s+[–—]\s+/).map(x => x.trim()).filter(Boolean);
  while (parts.length && /\d+\s*vagas?$/i.test(parts.at(-1))) parts.pop();
  if (parts.length >= 3) {
    const last = parts.at(-1);
    if (!/R\$|pretens[aã]o salarial/i.test(last)) return last;
  }
  return '';
}
function rioStructuredField(description,label){
  const text=String(description||'').replace(/\s+/g,' ').trim();
  if(!text)return '';
  const next='Bairro|Cidade|Benefícios|Beneficios|Horário(?: de Expediente)?|Horario(?: de Expediente)?|Salário|Salario|Bolsa Auxílio|Bolsa Auxilio|Informações(?: Adicionais)?|Informacoes(?: Adicionais)?|Forma de Trabalho|Forma de trabalho|Regime de Contratação|Regime de Contratacao|Número de Vagas|Numero de Vagas|Atividades|Oferecemos|Cargo|Empresa|Formação(?: e experiências desejáveis)?|Formacao(?: e experiencias desejaveis)?';
  const rx=new RegExp('\\b'+label+'\\s*:\\s*(.+?)(?=\\s+(?:'+next+')\\s*:|$)','ig');
  const matches=[...text.matchAll(rx)];
  return String(matches.at(-1)?.[1]||'').replace(/[.;,:\-–—\s]+$/g,'').trim();
}
export function rioLocation(title,description){
  const city=rioStructuredField(description,'Cidade');
  const neighborhood=rioStructuredField(description,'Bairro');
  if(city&&neighborhood&&norm(city)!==norm(neighborhood))return neighborhood+' - '+city;
  if(neighborhood)return neighborhood;
  if(city)return city;
  const fromTitle=titleLocation(title);
  if(/^(?:sem experiencia|sem experi[eê]ncia|\d+\s*vagas?)$/i.test(fromTitle))return '';
  return fromTitle;
}

function decodeHtml(value){
  return String(value||'')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&ndash;|&#8211;/gi,'–')
    .replace(/&mdash;|&#8212;/gi,'—')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/\s+/g,' ').trim();
}
async function searchRioVagasRecent(terms,filters,max=8000,{pageLimit=0}={}){
  const out=new Map(),seenIds=new Set();
  const cutoff=new Date(Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000).toISOString();
  const snapshotBefore=new Date().toISOString();
  const base='https://riovagas.com.br/wp-json/wp/v2/posts';
  const headers={'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9'};
  const fetchPage=async page=>{
    const qs=new URLSearchParams({
      categories:'1',per_page:'100',page:String(page),orderby:'id',order:'desc',
      after:cutoff,before:snapshotBefore,_fields:'id,date,link,title,excerpt,content'
    });
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const r=await fetch(base+'?'+qs,{headers,signal:AbortSignal.timeout(10000)});
        if(r.status===429){
          await delay(700*(attempt+1));
          continue;
        }
        if(!r.ok)return {page,rows:[],pages:0,status:r.status};
        const rows=await r.json();
        return {page,rows:Array.isArray(rows)?rows:[],pages:Number(r.headers.get('x-wp-totalpages')||1),total:Number(r.headers.get('x-wp-total')||0),status:r.status};
      }catch(e){
        lastError=e;
        if(attempt<2)await delay(450*(attempt+1));
      }
    }
    return {page,rows:[],pages:0,error:String(lastError?.message||lastError||'fetch failed')};
  };
  const addRows=rows=>{
    for(const row of rows||[]){
      if(row?.id!==undefined&&row?.id!==null)seenIds.add(String(row.id));
      if(!String(row.link||'').includes('/riovagas/'))continue;
      const title=decodeHtml(row.title?.rendered||''),description=decodeHtml(row.content?.rendered||row.excerpt?.rendered||'');
      if(!title||!row.link)continue;
      out.set(row.link,{source:'RioVagas',title,url:row.link,description,company:'',salary:titleSalary(title),
        location:rioLocation(title,description),publishedAt:row.date?row.date+'-03:00':'',externalId:String(row.id||''),loginFreeCandidate:true,broadCollection:true});
      if(out.size>=max)break;
    }
  };

  const first=await fetchPage(1);
  addRows(first.rows);
  const totalPages=Math.min(250,Math.max(1,Number(first.pages||1)));
  const lastPage=Math.min(totalPages,Math.ceil(max/100),pageLimit>0?Math.max(1,Number(pageLimit)):totalPages);
  let cursor=2;
  const workers=Math.min(6,Math.max(0,lastPage-1));
  const failed=[];
  async function worker(){
    while(cursor<=lastPage&&out.size<max){
      const page=cursor++;
      const result=await fetchPage(page);
      if(result.error||(!result.rows?.length&&result.status&&result.status!==200))failed.push({page,status:result.status||0,error:result.error||''});
      addRows(result.rows);
    }
  }
  if(workers)await Promise.all(Array.from({length:workers},()=>worker()));
  if(failed.length)console.log('[RioVagas] paginas com falha:',failed.slice(0,8));
  const expectedTotal=Math.max(0,Number(first.total||0));
  const syncOk=first.status===200&&!first.error&&failed.length===0;
  const exactSnapshot=lastPage===totalPages&&(expectedTotal===0||seenIds.size===expectedTotal);
  console.log(`[RioVagas] snapshot ${snapshotBefore}: ${out.size} vagas diretas; ${seenIds.size}/${expectedTotal||seenIds.size} posts lidos em ${lastPage}/${totalPages} pagina(s)`);
  const result=[...out.values()].slice(0,max);
  Object.defineProperty(result,'_syncOk',{value:syncOk,enumerable:false});
  Object.defineProperty(result,'_syncComplete',{value:syncOk&&exactSnapshot,enumerable:false});
  Object.defineProperty(result,'_expectedTotal',{value:expectedTotal,enumerable:false});
  Object.defineProperty(result,'_seenTotal',{value:seenIds.size,enumerable:false});
  Object.defineProperty(result,'_snapshotBefore',{value:snapshotBefore,enumerable:false});
  return result;
}

const RIO_INVENTORY_DAYS=30;
function rioInventoryCutoff(days=RIO_INVENTORY_DAYS){
  const safe=Math.max(1,Math.min(RIO_INVENTORY_DAYS,Number(days)||RIO_INVENTORY_DAYS));
  return new Date(Date.now()-safe*86400000).toISOString();
}
function pruneRioInventory(){
  db.prepare("UPDATE job_inventory SET active=0 WHERE source='RioVagas' AND active=1 AND datetime(published_at)<datetime(?)").run(rioInventoryCutoff());
}
function rioInventoryRows(days=15,max=25000,terms=[]){
  return queryRioInventory(days,terms,max);
}

function rioInventoryState(){
  return db.prepare("SELECT source,last_sync_at,last_full_sync_at,coverage_days,last_count FROM source_sync_state WHERE source='RioVagas'").get()||{};
}
function rioInventorySyncAge(){
  const ms=Date.parse(String(rioInventoryState().last_sync_at||''));
  return Number.isFinite(ms)?Date.now()-ms:Infinity;
}
function saveRioSyncState({full=false,count=0}={}){
  const existing=rioInventoryState(),now=new Date().toISOString();
  db.prepare(`INSERT INTO source_sync_state(source,last_sync_at,last_full_sync_at,coverage_days,last_count)
    VALUES('RioVagas',?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET
      last_sync_at=excluded.last_sync_at,last_full_sync_at=excluded.last_full_sync_at,
      coverage_days=excluded.coverage_days,last_count=excluded.last_count`)
    .run(now,full?now:String(existing.last_full_sync_at||''),full?RIO_INVENTORY_DAYS:Number(existing.coverage_days||0),Number(count)||0);
}

function saveRioInventory(rows,{fullSnapshot=false}={}){
  if(!rows?.length)return;
  const upsert=db.prepare(`INSERT INTO job_inventory
    (source,external_id,url,canonical_url,title,company,salary,location,description,contract_type,published_at,content_hash,active,apply_mode,last_seen_at)
    VALUES('RioVagas',?,?,?,?,?,?,?,?,?,?,?,1,'DIRECT_HTTP',CURRENT_TIMESTAMP)
    ON CONFLICT DO UPDATE SET
      external_id=excluded.external_id,url=excluded.url,canonical_url=excluded.canonical_url,
      title=excluded.title,company=excluded.company,salary=excluded.salary,location=excluded.location,
      description=excluded.description,contract_type=excluded.contract_type,published_at=excluded.published_at,
      content_hash=excluded.content_hash,active=1,apply_mode='DIRECT_HTTP',last_seen_at=CURRENT_TIMESTAMP`);
  db.exec('BEGIN');
  try{
    // A full snapshot is authoritative: jobs no longer present are closed/inactive.
    if(fullSnapshot)db.prepare("UPDATE job_inventory SET active=0 WHERE source='RioVagas'").run();
    for(const j of rows){
      const canonical=canonicalJobUrl(j.url||'');
      const contentHash=createHash('sha1').update([j.title||'',j.description||'',j.publishedAt||''].join('\n')).digest('hex');
      upsert.run(j.externalId||'',j.url||'',canonical,j.title||'',j.company||'',j.salary||'',j.location||'',j.description||'',j.contractType||'',j.publishedAt||'',contentHash);
    }
    // Mantém registros inativos para preservar histórico/referências de execuções antigas.
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}
let rioInventorySyncPromise=null;
async function refreshRioInventory(max=25000,{incremental=true,recordState=true}={}){
  const inventoryFilters={recencyDays:RIO_INVENTORY_DAYS};
  const rows=await searchRioVagasRecent([],inventoryFilters,max,{pageLimit:incremental?10:0}).catch(e=>{
    console.log('[RioVagas] sincronizacao falhou:',String(e?.message||e));return [];
  });
  const fullSnapshot=!incremental&&rows._syncComplete===true;
  if(rows.length)saveRioInventory(rows,{fullSnapshot});
  pruneRioInventory();
  if(recordState&&rows._syncOk)saveRioSyncState({full:fullSnapshot,count:rows.length});
  const active=Number(db.prepare("SELECT COUNT(*) AS n FROM job_inventory WHERE source='RioVagas' AND active=1").get()?.n||0);
  return {fetched:rows.length,active,fullSnapshot,ok:rows._syncOk===true,complete:rows._syncComplete===true,
    expectedTotal:Number(rows._expectedTotal||0),seenTotal:Number(rows._seenTotal||0),snapshotBefore:String(rows._snapshotBefore||'')};
}
function rioFullSyncDue(maxAgeMs=24*60*60*1000){
  const ms=Date.parse(String(rioInventoryState().last_full_sync_at||''));
  return !Number.isFinite(ms)||Date.now()-ms>=maxAgeMs;
}
export function getRioVagasInventoryStatus(){
  pruneRioInventory();
  const counts=db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN active=0 THEN 1 ELSE 0 END) AS inactive,
    MIN(CASE WHEN active=1 THEN published_at END) AS oldest,
    MAX(CASE WHEN active=1 THEN published_at END) AS newest
    FROM job_inventory WHERE source='RioVagas'`).get()||{};
  return {...rioInventoryState(),...counts,fullSyncDue:rioFullSyncDue()};
}
export async function syncRioVagasInventory({full=false,force=false}={}){
  pruneRioInventory();
  if(rioInventorySyncPromise)return rioInventorySyncPromise;
  const state=rioInventoryState();
  const age=rioInventorySyncAge();
  if(!force){
    if(full&&!rioFullSyncDue())return {...getRioVagasInventoryStatus(),skipped:true,reason:'FULL_SYNC_FRESH'};
    if(!full&&age<30*60*1000)return {...getRioVagasInventoryStatus(),skipped:true,reason:'INCREMENTAL_SYNC_FRESH'};
  }
  rioInventorySyncPromise=(async()=>{
    const result=await refreshRioInventory(full?25000:1000,{incremental:!full});
    let tailFetched=0;
    if(full&&result.fullSnapshot){
      const tail=await refreshRioInventory(1000,{incremental:true,recordState:false});
      tailFetched=Number(tail.fetched||0);
    }
    return {...result,...getRioVagasInventoryStatus(),tailFetched,skipped:false};
  })();
  try{return await rioInventorySyncPromise;}finally{rioInventorySyncPromise=null;}
}
export async function maintainRioVagasInventory(){
  return syncRioVagasInventory({full:rioFullSyncDue(),force:true});
}

async function cachedRioVagasSource(terms,filters,max=25000){
  pruneRioInventory();
  const requestedDays=[7,15,30].includes(Number(filters.recencyDays))?Number(filters.recencyDays):15;
  const inventoryCount=Number(db.prepare("SELECT COUNT(*) AS n FROM job_inventory WHERE source='RioVagas'").get()?.n||0);
  const state=rioInventoryState();
  if(Number(state.coverage_days||0)<RIO_INVENTORY_DAYS){
    const sync=await syncRioVagasInventory({full:true,force:true});
    const rows=rioInventoryRows(requestedDays,max,terms);
    console.log(`[busca] RioVagas: janela global de 30 dias sincronizada com ${sync.active||0} vagas ativas; ${rows.length} vagas no filtro de ${requestedDays} dias`);
    return rows;
  }
  if(inventoryCount&&rioInventorySyncAge()<5*60*1000){
    const rows=rioInventoryRows(requestedDays,max,terms);
    console.log(`[busca] RioVagas: inventario local fresco com ${rows.length} vagas (${requestedDays} dias; ${inventoryCount} em ate 30 dias)`);
    return rows;
  }
  const sync=await syncRioVagasInventory({full:false,force:true});
  const rows=rioInventoryRows(requestedDays,max,terms);
  console.log(`[busca] RioVagas: sincronizacao incremental ${sync.fetched||0} registros lidos; ${rows.length} vagas na janela de ${requestedDays} dias`);
  return rows;
}

async function cachedJobbolSource(terms,filters,max=25000){
  const requestedDays=[7,15,30].includes(Number(filters.recencyDays))?Number(filters.recencyDays):15;
  let st=getJobbolInventoryStatus();
  const ageMs=Date.now()-Date.parse(String(st.last_sync_at||''));
  if(Number(st.coverage_days||0)<30||st.fullSyncDue||!Number.isFinite(ageMs)){
    st=await syncJobbolInventory({full:true,force:true});
    console.log(`[busca] Jobbol: inventario sincronizado com ${st.active||0} vagas internas ativas`);
  }
  const rows=queryInventorySources(['Jobbol'],requestedDays,terms,max);
  console.log(`[busca] Jobbol: ${rows.length} vagas no filtro de ${requestedDays} dias`);
  return rows;
}

function canonicalJobUrl(value){
  try{
    const u=new URL(value);u.hash='';
    for(const k of [...u.searchParams.keys()]) if(/^utm_|^(ref|source|src|fbclid|gclid|trackingId|position|pageNum|refId)$/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/,'');
  }catch{return String(value||'').trim().replace(/\/$/,'');}
}
function likelyJobDetail(job){
  const title=norm(job?.title),url=String(job?.url||'');
  if(!title||!url)return false;
  if(/^(?:\d+\s+)?vagas?\s+(?:de|para)\b|^vagas? de emprego\b|\bvagas? dispon[ií]veis?\b/.test(title))return false;
  if(/linkedin\.com\/jobs\/(?!view\/)[^?]*vagas/i.test(url))return false;
  if(/indeed\.com\/(?:q-|jobs\?)/i.test(url))return false;
  if(/glassdoor\.com\.br\/Vaga\/.*SRCH_/i.test(url))return false;
  if(/catho\.com\.br\/vagas\/[^/]+\/(?:rio-de-janeiro-rj|sao-paulo-sp|[^/]+-[a-z]{2})\/?(?:\?|$)/i.test(url))return false;
  if(/talent\.com\/jobs(?:\/|\?|$)/i.test(url)&&!/talent\.com\/view\?id=\d+/i.test(url))return false;
  return true;
}
export function dedupeJobs(rows){
  const out=[],seenUrl=new Set(),seenSemantic=new Set();
  for(const job of rows){
    if(!job?.url||!job?.title||!likelyJobDetail(job)) continue;
    const urlKey=canonicalJobUrl(job.url);
    const day=String(job.publishedAt||'').slice(0,10);
    const semantic=[norm(job.title),norm(job.company),norm(job.location),norm(job.salary),day].join('|');
    const rio=/^RioVagas$/i.test(String(job.source||''))||/riovagas\.com\.br/i.test(String(job.url||''));
    const semanticStrong=norm(job.title).length>4&&Boolean(day)&&(norm(job.company).length>2||rio);
    if(seenUrl.has(urlKey)||(semanticStrong&&seenSemantic.has(semantic))) continue;
    seenUrl.add(urlKey);if(semanticStrong)seenSemantic.add(semantic);out.push(job);
  }
  return out;
}

export async function searchJobs(profile, filters, suppliedTerms=null) {
  const terms=Array.isArray(suppliedTerms)&&suppliedTerms.length
    ? suppliedTerms
    : await buildSearchTerms(profile,filters);
  console.log('[busca] termos:',terms.slice(0,18));
  if(!terms.length) throw new Error('Não foi possível inferir uma área; use o filtro opcional de área.');
  const poolCap=Math.min(25000,Math.max(5000,Number(filters.poolLimit||15000)));
  const sourceFilters={...filters,publicSourcesOnly:true,publicSourceKeys:['rio','jobbol'],nationwide:false};
  const [rio,jobbol]=await Promise.all([
    cachedRioVagasSource(terms,{...sourceFilters,publicSourceKeys:['rio']},poolCap),
    cachedJobbolSource(terms,{...sourceFilters,publicSourceKeys:['jobbol']},poolCap)
  ]);
  return [...rio,...jobbol].slice(0,poolCap);
}
