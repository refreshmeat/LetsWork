import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { runtime } from '../runtime.mjs';
import { ensureCandidateDirs } from '../storage.mjs';
import { askAI, parseJsonLoose } from '../services/ai.mjs';

function playwrightChromiumPath(){
  const explicit=process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if(explicit&&fs.existsSync(explicit))return explicit;
  try{
    const bundled=chromium.executablePath();
    if(bundled&&fs.existsSync(bundled))return bundled;
  }catch{}
  const root=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'ms-playwright'):'';
  if(root&&fs.existsSync(root)){
    const candidates=fs.readdirSync(root,{withFileTypes:true})
      .filter(x=>x.isDirectory()&&/^chromium-\d+$/i.test(x.name))
      .sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}))
      .map(x=>path.join(root,x.name,'chrome-win64','chrome.exe'))
      .filter(fs.existsSync);
    if(candidates.length)return candidates[0];
  }
  throw new Error('Chromium do Playwright não encontrado. A candidatura foi bloqueada para não abrir navegador comum.');
}
export async function createApplicationBrowser(){
  return chromium.launch({executablePath:playwrightChromiumPath(),headless:true,args:['--no-sandbox','--disable-gpu','--disable-background-networking','--disable-renderer-backgrounding']});
}
export async function createApplicationContext(browser){
  const context=await browser.newContext();
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(30000);
  await context.route('**/*',route=>{
    const r=route.request(),t=r.resourceType(),u=r.url();
    if(['image','media','font'].includes(t)||/doubleclick|googlesyndication|google-analytics|googletagmanager|facebook\.net|hotjar|clarity\.ms/i.test(u))return route.abort();
    return route.continue();
  });
  return context;
}
const profileDir=id=>id?path.join(ensureCandidateDirs(id).sessions,'chromium-profile'):path.join(runtime.sessions,'chromium-profile');
let loginCandidateId=null;
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
let loginContext=null;

export async function openLoginSession(candidateId=null){
  if(loginContext && loginCandidateId===candidateId) return {ok:true,alreadyOpen:true};
  if(loginContext) await closeLoginSession();
  const dir=profileDir(candidateId); loginCandidateId=candidateId;
  loginContext=await chromium.launchPersistentContext(dir,{executablePath:playwrightChromiumPath(),headless:true,args:['--no-sandbox']});
  const pages=loginContext.pages(); const first=pages[0] || await loginContext.newPage();
  await first.goto('https://portal.gupy.io/',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  const second=await loginContext.newPage();
  await second.goto('https://www.vagas.com.br/',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  loginContext.on('close',()=>{loginContext=null;});
  return {ok:true,profileDir:profileDir(candidateId)};
}

export async function closeLoginSession(){
  if(loginContext){await loginContext.close().catch(()=>{}); loginContext=null;} loginCandidateId=null;
  return {ok:true};
}function resolvedPrefs(job,prefs){
  const advertised=String(job.salary||'').trim();
  const usable=advertised&&!/pretens|a combinar|não informado|nao informado/i.test(advertised);
  return {...prefs,salaryExpectation:(prefs.salaryFromJob&&usable)?advertised:(prefs.salaryExpectation||'A combinar')};
}

function lineMatch(text,rx){
  return String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).find(x=>rx.test(x)&&x.length<=220)||null;
}
function ageFromBirth(value){
  const m=String(value||'').match(/(\d{1,2})\D(\d{1,2})\D(\d{4})/); if(!m) return null;
  const birth=new Date(Number(m[3]),Number(m[2])-1,Number(m[1])); if(Number.isNaN(birth.getTime())) return null;
  const now=new Date(); let age=now.getFullYear()-birth.getFullYear();
  if(now.getMonth()<birth.getMonth()||(now.getMonth()===birth.getMonth()&&now.getDate()<birth.getDate())) age--;
  return age>=14&&age<100?String(age):null;
}
function inferredNeighborhood(profile){
  if(String(profile?.neighborhood||'').trim())return String(profile.neighborhood).trim();
  const raw=String(profile?.rawText||'');
  return raw.match(/(?:RJ\s*[-–—]\s*Rio de Janeiro\s*[-–—]\s*)([^\n,;|]{2,60})/i)?.[1]?.trim()
    ||raw.match(/(?:bairro\s*[:\-]\s*)([^\n,;|]{2,60})/i)?.[1]?.trim()
    ||'';
}
export function knownAnswer(label,profile,prefs,job=null){
  const q=norm(label),raw=String(profile.rawText||''),neighborhood=inferredNeighborhood(profile);
  if(/nome/.test(q)) return profile.name||null;
  if(/e-?mail/.test(q)) return profile.email||null;
  if(/telefone|celular|whatsapp/.test(q)) return profile.phone||null;
  if(/\bcpf\b/.test(q)) return profile.cpf||null;
  if(/data.*nascimento|nascimento/.test(q)) return profile.birthDate||null;
  if(/idade/.test(q)) return ageFromBirth(profile.birthDate);
  if(/\bcep\b/.test(q)) return profile.cep||null;
  if(/(?:tempo|demora|desloc|minut)/.test(q)&&/(?:bairro|resid|mora)/.test(q)) return null;
  if(/(?:em que|qual).*bairro|bairro.*resid|bairro.*mora/.test(q)&&neighborhood) return neighborhood;
  if(/reside em bairros|voce reside em|mora em (?:algum|um) dos/.test(q)&&neighborhood) return q.includes(norm(neighborhood))?'Sim':'Não';
  if(/bairro/.test(q)&&neighborhood) return neighborhood;
  if(/endere[cç]o|logradouro/.test(q)&&profile.address) return profile.address;
  if(/pretens.*salar|salario/.test(q)) return prefs.salaryExpectation||'A combinar';
  if(/cidade|municipio/.test(q)&&(profile.residenceCity||prefs.city)) return profile.residenceCity||prefs.city;
  if(/estado|\buf\b/.test(q)&&(profile.residenceState||prefs.state)) return profile.residenceState||prefs.state;
  if(/linkedin/.test(q)&&profile.linkedin) return profile.linkedin;
  if(/instagram|@/.test(q)&&profile.instagram) return profile.instagram;
  if(/portfolio/.test(q)&&profile.portfolio) return profile.portfolio;
  if(/semestre|periodo.*faculdade/.test(q)) return raw.match(/\b\d{1,2}\s*[º°o]?\s*semestre\b/i)?.[0]||null;
  if(/curso|graduacao|faculdade|formacao/.test(q)) return lineMatch(raw,/bacharel|gradua|faculdade|universidade|curso superior/i);
  if(/ingles/.test(q)) return lineMatch(raw,/ingl[eê]s|english/i);
  if(/pcd|deficiencia/.test(q)) return profile.pcd===true?'Sim':profile.pcd===false?'Não':null;
  if(/contratacao.*pj|aceita.*pj/.test(q)) return (prefs.contractTypes||[]).includes('PJ')?'Sim':'Não';
  if(/disponibilidade/.test(q)&&prefs.availability===true) return 'Sim';
  return null;
}


const travelCache=new Map();
let geoQueue=Promise.resolve(),lastGeoAt=0;
async function geoPoint(query){
  const q=String(query||'').trim(); if(!q)return null;
  const key='g:'+norm(q); if(travelCache.has(key))return travelCache.get(key);
  const work=geoQueue.then(async()=>{
    const gap=Date.now()-lastGeoAt;if(gap<1100)await new Promise(r=>setTimeout(r,1100-gap));
    lastGeoAt=Date.now();
    try{
      const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q),{headers:{'user-agent':'LetsWork/0.1 job-application-assistant'},signal:AbortSignal.timeout(6000)});
      const rows=await r.json();const x=rows?.[0];const pt=x?{lat:Number(x.lat),lon:Number(x.lon)}:null;
      if(pt)travelCache.set(key,pt);
      return pt;
    }catch{return null;}
  });
  geoQueue=work.catch(()=>null);
  return work;
}
async function travelEstimate(profile,prefs,job){
  const origin=[profile.address,inferredNeighborhood(profile),profile.residenceCity||prefs.city,profile.residenceState||prefs.state,'Brasil'].filter(Boolean).join(', ');
  const dest=[job?.location,prefs.city,prefs.state,'Brasil'].filter(Boolean).join(', ');
  if(!origin||!job?.location)return null;
  const key='r:'+norm(origin)+'>'+norm(dest); if(travelCache.has(key))return travelCache.get(key);
  const a=await geoPoint(origin),b=await geoPoint(dest); if(!a||!b)return null;
  try{
    const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`,{signal:AbortSignal.timeout(7000)});
    const route=(await r.json())?.routes?.[0]; if(!route)return null;
    const minutes=Math.max(1,Math.round(Number(route.duration||0)/60));
    const km=Math.round((Number(route.distance||0)/1000)*10)/10;
    const out={minutes,km,near:minutes<=45,origin,destination:dest}; travelCache.set(key,out); return out;
  }catch{return null;}
}
function safeFallbackAnswer(question,options=[],profile={},prefs={},job=null){
  const q=norm(question), opts=(options||[]).map(String).filter(Boolean);
  if(/experien|vivencia|ja trabalhou|ja atuou|possui experiencia|tem experiencia/.test(q)){
    if(opts.length){const no=opts.find(x=>/^(nao|não)$/i.test(x.trim())||/nao possuo|não possuo/i.test(x));if(no)return no;}
    return 'Não';
  }
  if(/disponibilidade/.test(q)) return prefs.availability===false?'Não':'Sim';
  if(/pretens.*salar|salario/.test(q)) return prefs.salaryExpectation||'A combinar';
  if(/motiva|porque.*vaga|por que.*vaga|interesse.*vaga/.test(q)) return `Tenho interesse na oportunidade de ${job?.title||'trabalho'} por ser compatível com minha formação, conhecimentos e objetivos profissionais descritos no currículo.`;
  if(/apresent|fale sobre voce|conte sobre voce|resumo profissional/.test(q)) return `Sou ${String(profile.rawText||'').match(/(?:estudante|cursando|graduand[oa])[^.\n]{0,100}/i)?.[0]||'candidato(a) em desenvolvimento profissional'}, com foco nas competências e projetos apresentados no currículo.`;
  if(opts.length){
    const safe=opts.find(x=>/não se aplica|nao se aplica|sem experi|a combinar|^0$|^(nao|não)$/i.test(x.trim())); if(safe)return safe;
    return null;
  }
  return 'Não informado no currículo';
}

export async function aiAnswers(questions,profile,prefs,job=null){
  if(!questions.length)return new Map();
  const needsTravel=questions.some(q=>/(proxim|perto|distancia|desloc|trajeto|demora|minut|tempo.*(?:local|vaga|trabalho))/i.test(norm(q?.question||'')));
  const travel=needsTravel?await travelEstimate(profile,prefs,job).catch(()=>null):null;
  const out=new Map(),remaining=[];
  const raw=norm(String(profile.rawText||'')+' '+(profile.skills||[]).join(' '));
  const skillNames=(profile.skills||[]).map(String).filter(Boolean);
  const knownTools=['canva','photoshop','figma','indesign','illustrator','illustration','excel','power bi','after effects','premiere','corel','autocad','sketchup','word','wordpress','html','css','javascript','python'];
  for(const q of questions){
    const id=String(q?.id??''),label=String(q?.question||''),n=norm(label),options=(q?.options||[]).map(String);
    let answer=knownAnswer(label,profile,prefs,job)||null;
    if(!answer&&travel&&/(proxim|perto|distancia|desloc|trajeto|demora|minut|tempo)/.test(n)){
      if(/proxim|perto|mora.*local|reside.*local/.test(n)){
        const wanted=travel.near?'sim':'nao';
        answer=options.find(x=>norm(x)===wanted)||options.find(x=>norm(x).includes(wanted))||(travel.near?'Sim':'Não');
      }else if(/tempo|demora|minut|desloc|trajeto/.test(n)){
        const estimated=/onibus|ônibus|transporte public|transporte público/.test(n)?Math.round(travel.minutes*1.45+8):travel.minutes;
        answer=String(estimated);
        if(!options.length&&!/numero|quantos|minutos?\b/.test(n))answer+=' minutos aproximadamente';
      }
    }
    if(!answer&&/(quantos?.*anos|anos?.*experi|tempo.*experi)/.test(n)){
      const m=raw.match(/(\d+(?:[.,]\d+)?)\s*anos?[^\n]{0,80}/);answer=m?.[1]||'0';
    }
    if(!answer&&/(experien|vivencia|conhec|domina|sabe usar|utiliza|familiaridade)/.test(n)){
      const mentioned=knownTools.filter(t=>n.includes(norm(t)));
      const evidenced=mentioned.some(t=>raw.includes(norm(t)))||skillNames.some(k=>n.includes(norm(k))&&raw.includes(norm(k)));
      if(mentioned.length||skillNames.some(k=>n.includes(norm(k)))) {
        const wanted=evidenced?'sim':'nao';
        answer=options.find(x=>norm(x)===wanted)||options.find(x=>norm(x).includes(wanted))||(evidenced?'Sim':'Não');
      }
    }
    if(!answer&&/disponibilidade/.test(n))answer=prefs.availability===false?'Não':'Sim';
    if(!answer&&/(motiva|porque.*vaga|por que.*vaga|interesse.*vaga)/.test(n))answer=safeFallbackAnswer(label,options,profile,prefs,job);
    if(!answer&&/(apresent|fale sobre voce|conte sobre voce|resumo profissional)/.test(n))answer=safeFallbackAnswer(label,options,profile,prefs,job);
    if(answer)out.set(id,String(answer));else remaining.push(q);
  }
  if(remaining.length){
    const system='Responda perguntas de formulário de candidatura usando somente fatos do currículo, dados confirmados da pessoa candidata, preferências e informações da vaga. Nunca invente experiência, habilidade, formação, endereço, disponibilidade ou credenciais. Se uma experiência ou habilidade não estiver comprovada, responda negativamente. Para opções, devolva exatamente uma opção existente. Para perguntas abertas, redija resposta curta e profissional baseada somente nos fatos fornecidos. Retorne apenas JSON válido.';
    const facts={curriculo:String(profile.rawText||'').slice(0,12000),dadosAdicionais:String(profile.additionalFacts||'').slice(0,3000),origemBairro:inferredNeighborhood(profile)||'',deslocamento:travel||null,vaga:{titulo:job?.title||'',empresa:job?.company||'',local:job?.location||'',descricao:String(job?.description||'').slice(0,7000)},preferencias:{availability:prefs.availability,contractTypes:prefs.contractTypes,pcdMode:prefs.pcdMode,salaryExpectation:prefs.salaryExpectation,city:prefs.city,state:prefs.state}};
    const prompt='CONTEXTO:\n'+JSON.stringify(facts)+'\n\nPERGUNTAS:\n'+JSON.stringify(remaining)+'\n\nRetorne exatamente {"answers":[{"id":"...","answer":"..."}]}. Responda todas. Não use null. Se faltar comprovação de experiência, responda de forma negativa e verdadeira, sem inventar.';
    try{
      const parsed=parseJsonLoose(await askAI(system,prompt,{candidateId:profile.candidateId}))||{};
      for(const item of Array.isArray(parsed.answers)?parsed.answers:[]){
        const id=String(item?.id??''),answer=item?.answer==null?'':String(item.answer).trim();if(answer)out.set(id,answer);
      }
    }catch{}
  }
  for(const q of questions){const id=String(q?.id??'');if(!out.get(id))out.set(id,safeFallbackAnswer(q?.question,q?.options,profile,prefs,job));}
  return out;
}
async function fieldLabel(el){
  return el.evaluate(e=>{
    const id=e.id; const explicit=id?document.querySelector(`label[for="${CSS.escape(id)}"]`):null;
    const wrap=e.closest('label,fieldset,.form-group,.field,.question,div');
    return [explicit?.innerText,wrap?.innerText,e.getAttribute('placeholder'),e.getAttribute('name'),e.getAttribute('aria-label')]
      .filter(Boolean).join(' ').replace(/\s+/g,' ').trim().slice(0,900);
  });
}

async function collectGenericAiAnswers(page,profile,prefs,job){
  const pending=[];
  const add=(label,options=[])=>{
    const clean=String(label||'').replace(/\s+/g,' ').trim();
    if(!clean||knownAnswer(clean,profile,prefs,job))return;
    const key=norm(clean);
    if(pending.some(x=>x.key===key))return;
    pending.push({key,label:clean,options});
  };
  const textFields=page.locator('input:visible, textarea:visible');
  for(let i=0;i<await textFields.count();i++){
    const el=textFields.nth(i),type=(await el.getAttribute('type')||'text').toLowerCase();
    if(['hidden','submit','button','file','checkbox','radio','password'].includes(type))continue;
    if(await el.isDisabled().catch(()=>false))continue;
    const required=(await el.getAttribute('required'))!==null||(await el.getAttribute('aria-required'))==='true';
    if(!required||(await el.inputValue().catch(()=>''))?.trim())continue;
    add(await fieldLabel(el));
  }
  const sels=page.locator('select:visible');
  for(let i=0;i<await sels.count();i++){
    const el=sels.nth(i);if(await el.isDisabled().catch(()=>false))continue;
    const required=(await el.getAttribute('required'))!==null||(await el.getAttribute('aria-required'))==='true';
    if(!required||(await el.inputValue().catch(()=>'')))continue;
    const options=await el.locator('option').evaluateAll(os=>os.filter(o=>o.value).map(o=>(o.textContent||'').trim()));
    add(await fieldLabel(el),options);
  }
  const names=await page.locator('input[type="radio"]:visible').evaluateAll(es=>[...new Set(es.map(e=>e.name).filter(Boolean))]);
  for(const name of names){
    const safe=name.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const opts=page.locator(`input[type="radio"][name="${safe}"]:visible`);
    if(await opts.first().isChecked().catch(()=>false))continue;
    const required=(await opts.first().getAttribute('required'))!==null||(await opts.first().getAttribute('aria-required'))==='true';
    if(!required)continue;
    const choices=[];for(let i=0;i<await opts.count();i++)choices.push((await fieldLabel(opts.nth(i)))||await opts.nth(i).getAttribute('value')||'');
    add(await fieldLabel(opts.first()),choices);
  }
  if(!pending.length)return new Map();
  const questions=pending.map((x,i)=>({id:String(i),question:x.label,options:x.options}));
  const answers=await aiAnswers(questions,profile,prefs,job);
  const out=new Map();
  for(let i=0;i<pending.length;i++){const v=answers.get(String(i));if(v)out.set(pending[i].key,v);}
  return out;
}

async function fillTextFields(page,profile,prefs,aiMap=new Map(),job=null){
  const fields=page.locator('input:visible, textarea:visible'); const unknown=[];
  for(let i=0;i<await fields.count();i++){
    const el=fields.nth(i), type=(await el.getAttribute('type')||'text').toLowerCase();
    if(['hidden','submit','button','file','checkbox','radio','password'].includes(type)) continue;
    if(await el.isDisabled().catch(()=>false)) continue;
    const required=(await el.getAttribute('required'))!==null || (await el.getAttribute('aria-required'))==='true';
    if((await el.inputValue().catch(()=>''))?.trim()) continue;
    const label=await fieldLabel(el); let answer=knownAnswer(label,profile,prefs,job)||aiMap.get(norm(label))||null;
    if(!answer&&required)answer=safeFallbackAnswer(label,[],profile,prefs,job);
    if(answer) await el.fill(String(answer)).catch(()=>{});
    else if(required) unknown.push(label||`campo ${i+1}`);
  }
  return unknown;
}

function optionMatch(options,answer){
  const a=norm(answer); return options.find(o=>norm(o.text)===a)||options.find(o=>norm(o.text).includes(a)||a.includes(norm(o.text)));
}async function fillSelects(page,profile,prefs,aiMap=new Map(),job=null){
  const sels=page.locator('select:visible'); const unknown=[];
  for(let i=0;i<await sels.count();i++){
    const el=sels.nth(i); if(await el.isDisabled().catch(()=>false)) continue;
    const required=(await el.getAttribute('required'))!==null || (await el.getAttribute('aria-required'))==='true';
    const current=await el.inputValue().catch(()=>''); if(current) continue;
    const label=await fieldLabel(el);
    const options=await el.locator('option').evaluateAll(os=>os.filter(o=>o.value).map(o=>({value:o.value,text:(o.textContent||'').trim()})));
    let answer=knownAnswer(label,profile,prefs,job)||aiMap.get(norm(label))||null;
    let pick=answer?optionMatch(options,answer):null;
    if(!pick&&required){const fallback=safeFallbackAnswer(label,options.map(o=>o.text),profile,prefs,job);pick=optionMatch(options,fallback)||options.find(o=>/^(não|nao)$/i.test(o.text.trim()))||null;}
    if(pick) await el.selectOption(pick.value).catch(()=>{}); else if(required) unknown.push(label||`seleção ${i+1}`);
  }
  return unknown;
}

async function chooseRadios(page,profile,prefs,aiMap=new Map(),job=null){
  const names=await page.locator('input[type="radio"]:visible').evaluateAll(es=>[...new Set(es.map(e=>e.name).filter(Boolean))]);
  const unknown=[];
  for(const name of names){
    const safeName=name.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const opts=page.locator(`input[type="radio"][name="${safeName}"]:visible`);
    if(await opts.first().isChecked().catch(()=>false)) continue;
    const required=(await opts.first().getAttribute('required'))!==null || (await opts.first().getAttribute('aria-required'))==='true';
    const label=await fieldLabel(opts.first());
    const choices=[];
    for(let i=0;i<await opts.count();i++) choices.push({el:opts.nth(i),text:await fieldLabel(opts.nth(i)),value:await opts.nth(i).getAttribute('value')||''});
    let answer=knownAnswer(label,profile,prefs,job)||aiMap.get(norm(label))||null;
    if(!answer&&required)answer=safeFallbackAnswer(label,choices.map(x=>x.text||x.value),profile,prefs,job);
    if(answer){const pick=choices.find(x=>norm(`${x.text} ${x.value}`).includes(norm(answer)))||choices.find(x=>/^(não|nao)$/i.test(String(x.value).trim()))||null; if(pick) await pick.el.check().catch(()=>{}); else if(required) unknown.push(label);}
    else if(required) unknown.push(label);
  }
  return unknown;
}async function chooseCheckboxes(page,profile,prefs,aiMap=new Map(),job=null){
  const boxes=page.locator('input[type="checkbox"]:visible'); const unknown=[];
  for(let i=0;i<await boxes.count();i++){
    const el=boxes.nth(i); if(await el.isChecked().catch(()=>false)) continue;
    const required=(await el.getAttribute('required'))!==null || (await el.getAttribute('aria-required'))==='true';
    const label=await fieldLabel(el), q=norm(label);
    if(/politica.*privacidade|privacidade|termos de uso|tratamento de dados|lgpd|declaro|atesto|certifico|responsabil|veracidade|dados corretos/.test(q)){
      if(required)await el.check().catch(()=>{});
      continue;
    }
    const answer=knownAnswer(label,profile,prefs,job)||aiMap.get(norm(label))||null;
    if(answer && /^sim$/i.test(answer)) await el.check().catch(()=>{});
    else if(required && !/possuo|tenho|sou elegivel|atendo.*requisito|experiencia obrigatoria/.test(q)) await el.check().catch(()=>{});
    else if(required) unknown.push(label||('checkbox '+(i+1)));
  }
  return unknown;
}

async function uploadResume(page,resumeFile,profile){
  const inputs=page.locator('input[type="file"]'); let used=false;
  const docs=Array.isArray(profile?.supportDocuments)?profile.supportDocuments:[];
  for(let i=0;i<await inputs.count();i++){
    const el=inputs.nth(i); if(await el.isDisabled().catch(()=>false)) continue;
    const label=norm(await fieldLabel(el));
    let chosen=resumeFile;
    if(/portfolio|portifolio|book/.test(label)){
      continue;
    }else if(/certif|diploma|comprovante/.test(label)){
      chosen=docs.find(d=>d.kind==='certificate')?.stored_path||resumeFile;
    }
    await el.setInputFiles(chosen).then(()=>{used=true;}).catch(()=>{});
  }
  return used;
}

async function findApplicationPage(page,job){
  const isRio=job.source==='RioVagas'||/riovagas\.com\.br/i.test(String(job.url||''));
  await page.goto(job.url,{waitUntil:isRio?'commit':'domcontentloaded',timeout:isRio?20000:30000});
  if(isRio){
    const directForm=await page.locator('#btn-proceed,form.form-candidato,#anexo,#curriculo_candidato').count().catch(()=>0);
    if(!directForm){
      const link=page.locator('a:has-text("QUERO ME CANDIDATAR")').first();
      await link.waitFor({state:'attached',timeout:10000}).catch(()=>{});
      const href=await link.getAttribute('href').catch(()=>null);
      if(href)await page.goto(new URL(href,page.url()).toString(),{waitUntil:'commit',timeout:20000});
    }
    await page.locator('#btn-proceed,form.form-candidato,#anexo,#curriculo_candidato').first().waitFor({state:'attached',timeout:10000}).catch(()=>{});
    return;
  }
  if(job.source==='LinkedIn'||/linkedin\.com/i.test(page.url())){
    const external=await page.locator('a[href^="http"]:visible').evaluateAll(as=>{const x=as.find(a=>/candidat|apply|empresa|company/i.test((a.innerText||a.textContent||''))&&!/linkedin\.com/i.test(a.href));return x?.href||'';}).catch(()=>'');
    if(external){await page.goto(external,{waitUntil:'domcontentloaded',timeout:30000});return;}
    const gated=page.locator('button[data-tracking-control-name*="sign-in-modal"]:visible').first();
    if(await gated.count())throw new Error('LOGIN_REQUIRED: LinkedIn exige login antes de liberar esta candidatura');
    const offsite=page.locator('button:has(icon[data-svg-class-name="apply-button__offsite-apply-icon-svg"]):visible').first();
    if(await offsite.count()){await offsite.click().catch(()=>{});await page.waitForTimeout(350);if(!/linkedin\.com/i.test(page.url()))return;throw new Error('LOGIN_REQUIRED: LinkedIn não liberou candidatura externa sem login');}
    throw new Error('LOGIN_REQUIRED: candidatura do LinkedIn exige autenticação');
  }
  const link=page.getByRole('link',{name:/candidat|apply|inscreva|quero a vaga|enviar curr[ií]culo/i}).first();
  if(await link.count()){
    const href=await link.getAttribute('href').catch(()=>null);
    if(href){try{await page.goto(new URL(href,page.url()).toString(),{waitUntil:'domcontentloaded',timeout:30000});return;}catch{}}
    await link.click().catch(()=>{});
  }else{
    const btn=page.getByRole('button',{name:/candidat|apply|inscreva|quero a vaga|enviar curr[ií]culo/i}).first();
    if(await btn.count())await btn.click().catch(()=>{});
  }
  await page.waitForTimeout(350);
}
function blocker(body,url){
  const text=norm(String(body||'')+' '+String(url||''));
  let pathname='';try{pathname=new URL(String(url||'')).pathname.toLowerCase();}catch{}
  if(/captcha|recaptcha|hcaptcha/.test(text)) return 'Site exige CAPTCHA';
  if(/codigo de verificacao|autenticacao de dois fatores|two-factor|2fa/.test(text)) return 'Login necessário: site exige código ou autenticação adicional';
  if(/\/(?:login|signin|sign-in|auth)(?:\/|$)/.test(pathname)||/\/candidates\/signin(?:\/|$)/.test(pathname)||/faca login para continuar|entre na sua conta para continuar|sign in to apply|log in to apply/.test(text)) return 'Login necessário; candidatura descartada';
  return '';
}

async function applicationSurfaceEvidence(page){
  const url=page.url();
  if(/riovagas\.com\.br/i.test(url)&&await page.locator('form.form-candidato,#anexo,#curriculo_candidato').count().catch(()=>0))return true;
  const fileInputs=await page.locator('input[type="file"]').count().catch(()=>0);
  if(fileInputs>0)return true;
  const forms=page.locator('form:visible');
  const count=Math.min(await forms.count().catch(()=>0),20);
  for(let i=0;i<count;i++){
    const ok=await forms.nth(i).evaluate(f=>{
      const txt=((f.innerText||'')+' '+(f.getAttribute('action')||'')+' '+(f.id||'')+' '+(f.className||'')).toLowerCase();
      const inputs=[...f.querySelectorAll('input,textarea,select')];
      const email=inputs.some(e=>/email/.test((e.getAttribute('type')||'')+' '+(e.getAttribute('name')||'')+' '+(e.id||'')));
      const phone=inputs.some(e=>/tel|phone|telefone|celular|whatsapp/.test((e.getAttribute('type')||'')+' '+(e.getAttribute('name')||'')+' '+(e.id||'')));
      const name=inputs.some(e=>/nome|name/.test((e.getAttribute('name')||'')+' '+(e.id||'')));
      const submit=!!f.querySelector('button[type="submit"],input[type="submit"]')||/candidat|apply|inscrev|enviar|finalizar|concluir/.test(txt);
      const application=/candidat|apply|application|inscrev|vaga|curriculo|resume|cv/.test(txt);
      return application&&submit&&[email,phone,name].filter(Boolean).length>=2;
    }).catch(()=>false);
    if(ok)return true;
  }
  return false;
}

function deferred(){
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};
}

export function createJobContextCollector(jobs,{concurrency=6}={}){
  const slots=new Map(jobs.map(job=>[job.id,deferred()]));
  const done=(async()=>{
    let browser=null,context=null,cursor=0;
    try{
      browser=await chromium.launch({executablePath:playwrightChromiumPath(),headless:true,args:['--no-sandbox','--disable-gpu']});
      context=await browser.newContext();
      async function worker(){
        const page=await context.newPage();
        try{
          while(cursor<jobs.length){
            const job=jobs[cursor++];
            try{
              await findApplicationPage(page,job);
              await page.waitForTimeout(80);
              const body=(await page.locator('body').innerText().catch(()=>'' )).slice(0,50000);
              const blocked=blocker(body,page.url());
              const ready=blocked?false:await applicationSurfaceEvidence(page);
              slots.get(job.id)?.resolve({text:body,url:page.url(),blocked,ready,reason:ready?'':'NO_APPLICATION_FORM'});
            }catch(e){
              const message=String(e?.message||e);
              const blocked=/^LOGIN_REQUIRED:/i.test(message)?'Login necessário; candidatura não liberada sem autenticação':'';
              slots.get(job.id)?.resolve({text:'',url:job.url,error:message,blocked});
            }
          }
        }finally{await page.close().catch(()=>{});}
      }
      await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,jobs.length||1))},()=>worker()));
    }finally{
      for(const slot of slots.values()) slot.resolve({text:'',url:'',error:'collector_closed'});
      if(context) await context.close().catch(()=>{});
      if(browser) await browser.close().catch(()=>{});
    }
  })();
  return {get:jobId=>slots.get(jobId)?.promise||Promise.resolve({text:'',url:''}),done};
}

function intro(job,profile){
  const skills=(profile.skills||[]).slice(0,8).join(', ');
  return `Tenho interesse na oportunidade de ${job.title}. Meu currículo apresenta minha formação, projetos e experiências verificadas${skills?`, incluindo conhecimentos em ${skills}`:''}. Estou à disposição para as etapas do processo seletivo.`;
}

async function setDomValue(el,value){
  await el.evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
}
async function fillRioQuestions(page,job,profile,prefs){
  const qs=await page.locator('input[name^="perguntas"]').evaluateAll(es=>es.map(e=>({name:e.name,question:e.value||''})));
  const rows=[];
  for(const q of qs){
    const id=(q.name.match(/\[(\d+)\]/)||[])[1]; if(!id) continue;
    const fields=page.locator(`[name="respostas[${id}]"]`); if(!await fields.count()) continue;
    const first=fields.first(),tag=await first.evaluate(e=>e.tagName),type=(await first.getAttribute('type')||'').toLowerCase();
    let options=[];
    if(tag==='SELECT') options=await first.locator('option').evaluateAll(os=>os.filter(o=>o.value).map(o=>(o.textContent||'').trim()));
    else if(type==='radio') options=await fields.evaluateAll(es=>es.map(e=>({value:e.value,text:(e.parentElement?.innerText||e.value||'').trim()})));
    rows.push({id,question:q.question||`pergunta ${id}`,fields,first,tag,type,options,answer:knownAnswer(q.question,profile,prefs,job)});
  }
  const unresolved=rows.filter(x=>!x.answer).map(x=>({id:x.id,question:x.question,options:x.options.map?.(o=>typeof o==='string'?o:(o.text||o.value))||[]}));
  if(unresolved.length){
    const ai=await aiAnswers(unresolved,profile,prefs,job).catch(()=>new Map());
    for(const row of rows)if(!row.answer&&ai.has(String(row.id)))row.answer=ai.get(String(row.id));
  }
  for(const row of rows)if(!row.answer)row.answer=safeFallbackAnswer(row.question,row.options.map?.(o=>typeof o==='string'?o:(o.text||o.value))||[],profile,prefs,job);
  const missing=[];
  for(const row of rows){
    const {fields,first,tag,type,question}=row,answer=row.answer;
    if(!answer){missing.push(question);continue;}
    if(tag==='TEXTAREA'||(tag==='INPUT'&&!['radio','checkbox'].includes(type))) await setDomValue(first,answer);
    else if(tag==='SELECT'){const opts=await first.locator('option').evaluateAll(os=>os.filter(o=>o.value).map(o=>({v:o.value,t:(o.textContent||'').trim()})));const matched=optionMatch(opts.map(o=>({value:o.v,text:o.t})),answer);const pick=matched?opts.find(o=>o.v===matched.value):(opts.find(o=>/^(não|nao)$/i.test(o.t))||null);if(pick)await first.evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));},pick.v);else missing.push(question);}
    else if(type==='radio'){const arr=[];for(let i=0;i<await fields.count();i++){const el=fields.nth(i);arr.push({el,value:await el.getAttribute('value')||'',text:await fieldLabel(el)});}const pick=arr.find(x=>norm(`${x.value} ${x.text}`).includes(norm(answer)))||arr.find(x=>/^(não|nao)$/i.test(String(x.value).trim()))||null;if(pick)await pick.el.evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});else missing.push(question);}
    else missing.push(question);
  }
  return missing;
}

async function invalidVisibleFields(page){
  return page.locator('input:invalid,textarea:invalid,select:invalid').evaluateAll(es=>es.filter(e=>{
    const t=(e.getAttribute('type')||'').toLowerCase();
    return t!=='hidden' && (e.offsetParent!==null || t==='file');
  }).map(e=>{
    const id=e.id||'', label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]')?.innerText:'';
    return String(label||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')||id||e.tagName).replace(/\s+/g,' ').trim().slice(0,160);
  }).filter(Boolean)).catch(()=>[]);
}

function htmlDecode(s){
  return String(s||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#0*39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function tagAttr(tag,name){
  const m=String(tag||'').match(new RegExp('\\b'+name+'\\s*=\\s*(["\\\'])(.*?)\\1','i'));
  return m?htmlDecode(m[2]):'';
}
async function resolveRioApplyForm(job){
  let applyUrl=/\/enviar-curriculo-gratis\//i.test(String(job.url||''))?String(job.url):'';
  if(!applyUrl){
    const r=await fetch(job.url,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(10000)});
    const html=await r.text();
    const m=html.match(/href=["']([^"']*enviar-curriculo-gratis\/?\?vaga=[^"'#]+)["']/i);
    if(!m?.[1])throw new Error('RioVagas: link de candidatura não encontrado na vaga');
    applyUrl=new URL(htmlDecode(m[1]),r.url||job.url).toString();
  }
  const r=await fetch(applyUrl,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(10000)});
  const html=await r.text();
  if(!r.ok)throw new Error('RioVagas: formulário respondeu HTTP '+r.status);
  const tags=[...html.matchAll(/<input\b[^>]*>/gi)].map(x=>x[0]);
  const nonceTag=tags.find(t=>tagAttr(t,'name')==='candidato_vaga_nonce_field')||'';
  const postTag=tags.find(t=>tagAttr(t,'name')==='post_id')||'';
  const refTag=tags.find(t=>tagAttr(t,'name')==='_wp_http_referer')||'';
  const questions=[];
  for(const t of tags){
    const name=tagAttr(t,'name'),m=name.match(/^perguntas\[(\d+)\]$/);
    if(!m)continue;
    const id=m[1],question=tagAttr(t,'value');
    const answerTags=tags.filter(x=>tagAttr(x,'name')===('respostas['+id+']'));
    const options=answerTags.map(x=>tagAttr(x,'value')).filter(Boolean);
    questions.push({id,question,options});
  }
  return {applyUrl,html,nonce:tagAttr(nonceTag,'value'),postId:tagAttr(postTag,'value')||new URL(applyUrl).searchParams.get('vaga')||'',referer:tagAttr(refTag,'value')||new URL(applyUrl).pathname+new URL(applyUrl).search,questions};
}
async function applyRioVagasHttp(job,resumeFile,profile,prefs,dryRun){
  const bytes=fs.statSync(resumeFile).size;
  if(bytes>2*1024*1024)return {status:'ERROR',error:'Currículo excede o limite de 2 MB do RioVagas: '+(bytes/1024/1024).toFixed(2)+' MB'};
  let form;
  try{form=await resolveRioApplyForm(job);}catch(e){return {status:'ERROR',error:String(e?.message||e)};}
  const questions=form.questions.map(q=>({id:String(q.id),question:q.question,options:q.options}));
  const answers=questions.length?await aiAnswers(questions,profile,prefs,job).catch(()=>new Map()):new Map();
  const resolved=[];
  for(const q of questions){
    const answer=answers.get(String(q.id))||safeFallbackAnswer(q.question,q.options,profile,prefs,job);
    if(!answer)return {status:'ERROR',error:'RioVagas: pergunta sem resposta segura: '+q.question};
    let value=String(answer);
    if(q.options.length){
      const exact=q.options.find(x=>norm(x)===norm(value))||q.options.find(x=>norm(x).includes(norm(value))||norm(value).includes(norm(x)));
      if(!exact)return {status:'ERROR',error:'RioVagas: resposta não corresponde às opções de "'+q.question+'"'};
      value=exact;
    }
    resolved.push({id:q.id,question:q.question,value});
  }
  if(dryRun)return {status:'READY',error:''};
  if(!profile.name||!profile.email||!profile.phone)return {status:'ERROR',error:'RioVagas: nome, email ou celular ausente no perfil'};
  const data=new FormData();
  data.set('ciente','on');
  data.set('ciente_email','on');
  data.set('candidato_vaga_nonce_field',form.nonce);
  data.set('_wp_http_referer',form.referer);
  data.set('post_id',form.postId);
  data.set('nome_candidato',String(profile.name));
  data.set('email_candidato',String(profile.email));
  data.set('celular_candidato',String(profile.phone));
  data.set('telefone_candidato','');
  data.set('forma_envio','anexo');
  if(/name=['"]pretensao_salarial['"]/i.test(form.html))data.set('pretensao_salarial',String(prefs.salaryExpectation||'A combinar'));
  if(/name=['"]apresentacao_candidato['"]/i.test(form.html))data.set('apresentacao_candidato',intro(job,profile));
  for(const q of resolved){data.set('perguntas['+q.id+']',q.question);data.set('respostas['+q.id+']',q.value);}
  const blob=new Blob([fs.readFileSync(resumeFile)],{type:'application/pdf'});
  data.set('anexo',blob,path.basename(resumeFile));
  data.set('curriculo_candidato','');
  data.set('form_submit','confirm');
  let r,body='';
  try{
    r=await fetch(form.applyUrl,{method:'POST',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','accept-language':'pt-BR,pt;q=0.9','referer':form.applyUrl},body:data,redirect:'follow',signal:AbortSignal.timeout(25000)});
    body=await r.text();
  }catch(e){return {status:'ERROR',error:'RioVagas: falha no POST: '+String(e?.message||e)};}
  const normalized=norm(body+' '+(r?.url||''));
  if(/ja\s+(?:se\s+)?candidat|candidatura\s+ja\s+(?:foi\s+)?realizada|candidatura\s+ja\s+enviada|curriculo\s+ja\s+(?:foi\s+)?enviado|ja\s+enviou\s+(?:seu\s+)?curriculo|candidato\s+ja\s+cadastrado/.test(normalized))return {status:'ALREADY_APPLIED',error:'Candidatura já registrada anteriormente no RioVagas'};
  if(/curriculo enviado com sucesso|curriculo recebido|candidatura enviada|candidatura realizada|candidatura concluida|obrigado por se candidatar|obrigado pelo envio|recebemos (?:seu|o) curriculo|envio realizado com sucesso|mensagem de confirmacao/.test(normalized))return {status:'SENT',error:''};
  const errors=[...body.matchAll(/<(?:div|span|p)[^>]*class=["'][^"']*(?:error|invalid|danger)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p)>/gi)].map(x=>htmlDecode(x[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())).filter(Boolean).slice(0,5);
  return {status:'ERROR',error:'RioVagas não confirmou o envio. HTTP '+r.status+(errors.length?' · '+errors.join(' | '):'')};
}

async function applyRioVagas(page,job,resumeFile,profile,prefs,dryRun,onProgress=null){
  const progress=async(status,message='')=>{try{if(onProgress)await onProgress(status,message);}catch{}};
  const proceed=page.locator('#btn-proceed:visible').first();
  if(await proceed.count()){
    await page.locator('#ciente').check().catch(()=>{});
    await progress('OPENING','Validando a primeira etapa do RioVagas');
    await proceed.evaluate(b=>{if(b.form?.requestSubmit)b.form.requestSubmit(b);else b.click();}).catch(()=>{});
    await page.locator('#nome_candidato,#email_candidato,#anexo,#curriculo_candidato').first().waitFor({state:'attached',timeout:12000}).catch(()=>{});
    await page.waitForTimeout(180);
  }
  const phaseTwo=await page.locator('#nome_candidato,#email_candidato,#anexo,#curriculo_candidato').count();
  if(!phaseTwo)return {status:'ERROR',error:'RioVagas não abriu a etapa de candidatura após Prosseguir'};
  await progress('FILLING','Preenchendo o formulário do RioVagas');
  await page.evaluate(({profile,prefs})=>{
    const set=(sel,val)=>{const e=document.querySelector(sel);if(e&&val!=null&&val!==''){e.value=String(val);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}};
    const c=document.querySelector('#ciente');if(c)c.checked=true;
    set('#nome_candidato',profile.name);set('#email_candidato',profile.email);set('#celular_candidato',profile.phone);set('#pretensao_salarial',prefs.salaryExpectation||'A combinar');
  },{profile:{name:profile.name,email:profile.email,phone:profile.phone},prefs:{salaryExpectation:prefs.salaryExpectation}});
  let resumeReady=false;
  const file=page.locator('#anexo,input[type="file"]').first();
  if(await file.count()){
    const bytes=fs.statSync(resumeFile).size;
    if(bytes>2*1024*1024)return {status:'ERROR',error:`Currículo excede o limite de 2 MB do RioVagas: ${(bytes/1024/1024).toFixed(2)} MB`};
    const radio=page.locator('input[name="forma_envio"][value="anexo"]');
    if(await radio.count())await radio.evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});
    await file.setInputFiles(resumeFile).then(()=>{resumeReady=true;}).catch(()=>{});
  }
  if(!resumeReady){
    const text=page.locator('#curriculo_candidato,textarea[name*="curriculo"]').first();
    if(await text.count()){
      const radio=page.locator('input[name="forma_envio"][value="curriculo"]');
      if(await radio.count())await radio.evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});
      await setDomValue(text,String(profile.rawText||''));resumeReady=true;
    }
  }
  if(!resumeReady)return {status:'ERROR',error:'Campo de currículo do RioVagas não encontrado'};
  const missing=await fillRioQuestions(page,job,profile,prefs);
  const introField=page.locator('#apresentacao_candidato').first();
  if(await introField.count())await setDomValue(introField,intro(job,profile));
  await page.locator('#ciente').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));}).catch(()=>{});
  if(missing.length)return {status:'ERROR',error:'Perguntas do RioVagas não preenchidas: '+[...new Set(missing)].join(' | ')};
  const invalidBefore=await invalidVisibleFields(page);
  if(invalidBefore.length)return {status:'ERROR',error:'RioVagas ainda possui campos inválidos: '+invalidBefore.join(' | ')};
  if(dryRun)return {status:'READY',error:''};

  const form=page.locator('form.form-candidato').first();
  if(!await form.count())return {status:'ERROR',error:'Formulário RioVagas não encontrado'};
  const submit=page.locator('#btn-confim,button[name="form_submit"][value="confirm"]').first();
  if(!await submit.count())return {status:'ERROR',error:'Botão final do RioVagas não encontrado'};
  await progress('SUBMITTING','Enviando candidatura ao RioVagas');
  const beforeUrl=page.url();
  const postPromise=page.waitForResponse(r=>r.request().method()==='POST'&&/riovagas\.com\.br/i.test(r.url()),{timeout:18000}).catch(()=>null);
  await submit.evaluate(b=>{if(b.form?.requestSubmit)b.form.requestSubmit(b);else b.click();}).catch(()=>{});
  const post=await postPromise;
  await Promise.race([
    page.waitForURL(u=>u.toString()!==beforeUrl,{timeout:12000}),
    page.waitForLoadState('domcontentloaded',{timeout:12000}),
    page.waitForTimeout(2500)
  ]).catch(()=>{});
  await page.waitForTimeout(450);
  const finalText=await page.locator('body').innerText().catch(()=>'');
  const finalUrl=page.url();
  const responseText=post?await post.text().catch(()=>''):'';
  const normalized=norm(finalText+' '+responseText+' '+finalUrl);
  const already=/ja\s+(?:se\s+)?candidat|candidatura\s+ja\s+(?:foi\s+)?realizada|candidatura\s+ja\s+enviada|curriculo\s+ja\s+(?:foi\s+)?enviado|ja\s+enviou\s+(?:seu\s+)?curriculo|voce\s+ja\s+(?:enviou|participou)|candidato\s+ja\s+cadastrado/.test(normalized);
  if(already)return {status:'ALREADY_APPLIED',error:'Candidatura já registrada anteriormente no RioVagas'};
  const success=/curriculo enviado com sucesso|curriculo recebido|candidatura enviada|candidatura realizada|candidatura concluida|obrigado por se candidatar|obrigado pelo envio|recebemos (?:seu|o) curriculo|envio realizado com sucesso/.test(normalized);
  if(success)return {status:'SENT',error:''};
  const invalidAfter=await invalidVisibleFields(page);
  if(invalidAfter.length)return {status:'ERROR',error:'RioVagas recusou campos do formulário: '+invalidAfter.join(' | ')};
  const formStillVisible=await page.locator('form.form-candidato:visible').count().catch(()=>0);
  if(post?.ok()&&!formStillVisible)return {status:'SENT',error:''};
  return {status:'ERROR',error:`RioVagas não confirmou o envio com segurança. HTTP: ${post?.status?.()||'sem POST'} · URL: ${finalUrl.slice(0,180)}`};
}
async function applyGeneric(page,job,resumeFile,profile,prefs,dryRun,onProgress=null){
  const firstBody=await page.locator('body').innerText().catch(()=>'');
  const blocked=blocker(firstBody,page.url());
  if(blocked)return {status:/login necess[aá]rio/i.test(blocked)?'SKIPPED_LOGIN':'ERROR',error:blocked};
  for(let step=0;step<8;step++){
    const aiMap=await collectGenericAiAnswers(page,profile,prefs,job).catch(()=>new Map());
    const stepUnknown=[];
    stepUnknown.push(...await fillTextFields(page,profile,prefs,aiMap,job));
    stepUnknown.push(...await fillSelects(page,profile,prefs,aiMap,job));
    stepUnknown.push(...await chooseRadios(page,profile,prefs,aiMap,job));
    stepUnknown.push(...await chooseCheckboxes(page,profile,prefs,aiMap,job));
    await uploadResume(page,resumeFile,profile);
    if(stepUnknown.length)return {status:'ERROR',error:'Campos obrigatórios sem resposta segura: '+[...new Set(stepUnknown.filter(Boolean))].join(' | ')};
    const next=page.getByRole('button',{name:/pr[oó]ximo|prosseguir|continuar|avan[cç]ar|next/i}).first();
    if(!await next.count())break;
    await next.click().catch(()=>{});
    await page.waitForTimeout(350);
    const b=blocker(await page.locator('body').innerText().catch(()=>''),page.url());
    if(b)return {status:/login necess[aá]rio/i.test(b)?'SKIPPED_LOGIN':'ERROR',error:b};
  }
  const invalid=await invalidVisibleFields(page);
  if(invalid.length)return {status:'ERROR',error:'Formulário ainda possui campos inválidos: '+invalid.join(' | ')};
  if(dryRun)return {status:'READY',error:''};

  const candidates=[
    page.getByRole('button',{name:/enviar candidatura|finalizar candidatura|candidatar|submit application|send application|enviar|finalizar|concluir/i}).first(),
    page.locator('button[type="submit"]:visible').first(),
    page.locator('input[type="submit"]:visible').first()
  ];
  let submit=null;for(const c of candidates)if(await c.count()){submit=c;break;}
  if(!submit)return {status:'ERROR',error:'Botão final de envio não encontrado'};
  const beforeUrl=page.url(),beforeForms=await page.locator('form:visible').count().catch(()=>0);
  const postPromise=page.waitForResponse(r=>r.request().method()==='POST',{timeout:16000}).catch(()=>null);
  await submit.click({timeout:12000}).catch(async()=>{await submit.evaluate(e=>{if(e.form?.requestSubmit)e.form.requestSubmit(e);else e.click();}).catch(()=>{});});
  const post=await postPromise;
  await Promise.race([
    page.waitForURL(u=>u.toString()!==beforeUrl,{timeout:10000}),
    page.waitForLoadState('domcontentloaded',{timeout:10000}),
    page.waitForTimeout(2200)
  ]).catch(()=>{});
  await page.waitForTimeout(400);
  const finalBody=await page.locator('body').innerText().catch(()=>'');
  const final=norm(finalBody+' '+page.url());
  const b=blocker(finalBody,page.url());
  if(b)return {status:/login necess[aá]rio/i.test(b)?'SKIPPED_LOGIN':'ERROR',error:b};
  const success=/enviado com sucesso|candidatura realizada|candidatura enviada|candidatura concluida|inscricao realizada|inscricao concluida|application submitted|application received|thank you for applying|obrigado por se candidatar|recebemos (?:seu|o) curriculo|curriculo recebido/.test(final);
  if(success)return {status:'SENT',error:''};
  const invalidAfter=await invalidVisibleFields(page);
  if(invalidAfter.length)return {status:'ERROR',error:'Site recusou campos do formulário: '+invalidAfter.join(' | ')};
  const afterForms=await page.locator('form:visible').count().catch(()=>0);
  if(post?.ok()&&beforeForms>0&&afterForms===0)return {status:'SENT',error:''};
  return {status:'ERROR',error:'Envio acionado, mas o site não forneceu confirmação segura'};
}
export async function applyToJob(job,resumeFile,profile,prefs,{dryRun=true,prepareResume=null,browser:sharedBrowser=null,context:sharedContext=null}={}){
  if(!fs.existsSync(resumeFile)) return {status:'ERROR',error:'Currículo personalizado não encontrado'};
  const directRio=job.source==='RioVagas'||/riovagas\\.com\\.br/i.test(String(job.url||''));
  if(directRio&&!prepareResume)return applyRioVagasHttp(job,resumeFile,profile,resolvedPrefs(job,prefs),dryRun);
  let browser=sharedBrowser,context=sharedContext||null,page=null,ownsContext=false,ownsBrowser=false;
  const effectivePrefs=resolvedPrefs(job,prefs);
  try{
    if(!browser){browser=await createApplicationBrowser();ownsBrowser=true;}
    if(!context){context=await createApplicationContext(browser);ownsContext=true;}
    page=await context.newPage();
    await findApplicationPage(page,job);
    const body=await page.locator('body').innerText().catch(()=>'');
    const blocked=blocker(body,page.url());
    if(blocked) return {status:/login necess[aá]rio/i.test(blocked)?'SKIPPED_LOGIN':'ERROR',error:blocked};
    if(prepareResume){
      const enrichedJob={...job,description:[job.description||'',body||''].filter(Boolean).join('\n\n').slice(0,50000)};
      const prepared=await prepareResume(enrichedJob);
      if(prepared?.file) resumeFile=prepared.file;
    }
    if(/riovagas\.com\.br/i.test(page.url())){ const rioForm=await page.locator('form.form-candidato,#anexo,#curriculo_candidato').count(); if(rioForm) return await applyRioVagas(page,job,resumeFile,profile,effectivePrefs,dryRun); }
    return await applyGeneric(page,job,resumeFile,profile,effectivePrefs,dryRun);
  }catch(err){
    const msg=String(err?.message||err).slice(0,600);
    return /^LOGIN_REQUIRED:/i.test(msg)?{status:'SKIPPED_LOGIN',error:msg.replace(/^LOGIN_REQUIRED:\s*/i,'Ignorada: ')}:{status:'ERROR',error:msg};
  }finally{
    if(page) await page.close().catch(()=>{});
    if(ownsContext&&context) await context.close().catch(()=>{});
    if(ownsBrowser&&browser) await browser.close().catch(()=>{});
  }
}
