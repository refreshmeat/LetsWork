import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { storage } from '../storage.mjs';
import { searchGupy } from '../sources/gupy.mjs';
import { searchVagasCom } from '../sources/vagascom.mjs';
import { searchAdzuna } from '../sources/adzuna.mjs';
import { searchLinkVagas } from '../sources/linkvagas.mjs';
import { searchLinkedIn } from '../sources/linkedin.mjs';
import { searchTramper, searchHuanna, searchEmpregoDaqui, searchBeaVagas } from '../sources/directsites.mjs';
import { askAI, parseJsonLoose } from './ai.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const delay = ms => new Promise(r => setTimeout(r, ms));
const uniqByUrl = rows => [...new Map(rows.filter(x => x.url).map(x => [x.url, x])).values()];
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

const searchTaxonomy = {
  design:['designer','design gráfico','designer júnior','assistente de design','auxiliar de design','estágio design','assistente de criação','auxiliar de criação','produção gráfica','comunicação visual','social media','mídias sociais','assistente de social media','assistente de comunicação','estágio comunicação','marketing digital','assistente de marketing','auxiliar de marketing','estágio marketing','estágio publicidade','conteúdo digital','assistente de conteúdo','produção de conteúdo','publicidade','audiovisual','editor de vídeo','videomaker','motion designer','visual merchandising','assistente de visual merchandising','e-commerce','assistente de e-commerce','branding','web designer','ux ui','ux designer','ui designer','product designer','design digital','direção de arte','arte finalista'],
  marketing:['marketing','marketing digital','social media','redes sociais','conteúdo digital','content creator','publicidade','comunicação','assistente de marketing','auxiliar de marketing','analista de marketing','mídia','copywriter','tráfego pago','estágio marketing','estágio publicidade'],
  admin:['assistente administrativo','auxiliar administrativo','administrativo','recepcionista','secretária','backoffice','office assistant'],
  sales:['assistente comercial','vendedor','vendas','atendimento','customer success','inside sales','consultor comercial'],
  teaching:['professor','professora','docente','instrutor','educador','monitor'],
  tech:['desenvolvedor júnior','programador','frontend','backend','full stack','software','qa','tester','suporte técnico'],
  finance:['assistente financeiro','auxiliar financeiro','financeiro','faturamento','contábil','fiscal'],
  hr:['assistente de RH','recursos humanos','recrutamento','departamento pessoal','people']
};
const domainRx={
  design:/design|designer|figma|photoshop|illustrator|indesign|\bux\b|\bui\b|canva|audiovisual|motion/,
  marketing:/marketing|social media|redes sociais|publicidade|conte[uú]do digital|m[ií]dias sociais|copywriter|tr[aá]fego pago/,
  admin:/administrativ|secretari|recepcion|backoffice/,
  sales:/vendas|comercial|vendedor|atendimento ao cliente|customer success|inside sales|consultor comercial/,
  teaching:/professor|professora|docente|pedagog|licenciatura|educador|instrutor/,
  tech:/javascript|typescript|python|react|node|java|programa[cç][aã]o|desenvolvedor|software|frontend|backend|\bqa\b/,
  finance:/financeir|cont[aá]b|contabil|tesouraria|faturamento|fiscal/,
  hr:/recursos humanos|\brh\b|recrutamento|departamento pessoal|people/
};
function relatedTerms(text){
  const t=norm(text), out=[];
  for(const [domain,rx] of Object.entries(domainRx)) if(rx.test(t)) out.push(...searchTaxonomy[domain]);
  return out;
}
function inferredTerms(profile) {
  const source=`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`;
  return [...new Set(relatedTerms(source))];
}
function genericProfileTerms(profile){
  const primary=String(profile.rawText||'').split(/\n=== DOCUMENTO DE APOIO:/i)[0];
  const lines=primary.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const inferredName=!profile.name&&lines[0]&&/^[A-Za-zÀ-ÿ' -]{4,60}$/.test(lines[0])&&lines[0].split(/\s+/).length>=2&&lines[0].split(/\s+/).length<=5?lines[0]:'';
  const name=norm(profile.name||inferredName);
  const bad=/^(sobre mim|perfil|objetivo|formac|educa|skills?|habilidades?|telefone|e-?mail|linkedin|portfolio|cursos?|ensino m[eé]dio|gradua[cç][aã]o)\b/i;
  const roles=lines.filter(x=>{
    const n=norm(x); if(!n||n===name||bad.test(x))return false;
    if(/@|https?:|www\.|\+?\d{2}.*\d{4}|\b(?:rj|sp|mg|es|pr|sc|rs|ba|pe|ce|df)\b.*-/.test(n))return false;
    if(x.length>55||x.split(/\s+/).length>6)return false;
    if(/\b(meu|minha|sou|tenho|busco|procuro|gosto|cursando|formado|formada)\b/i.test(x))return false;
    return true;
  }).slice(0,4);
  const found=[];
  const rx=/(?:experi[eê]ncia|trabalh(?:o|ei)|atu(?:o|ei)|atua[cç][aã]o)\s+(?:como|em)\s+([^.;,\n]{3,70})/gi;
  let m; while((m=rx.exec(primary))){const v=String(m[1]||'').split(/\s+e\s+|\s+-\s+|\//i)[0].trim();if(v)found.push(v);}
  return [...new Set([...roles,...found])].slice(0,6);
}
function compactProfessionalText(profile){
  const primary=String(profile.rawText||'').split(/\n=== DOCUMENTO DE APOIO:/i)[0];
  const lines=primary.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>!/(?:e-?mail|telefone|linkedin|instagram|cpf|cep|www\.|https?:)/i.test(x));
  const extras=[];
  if((profile.skills||[]).length) extras.push('Skills: '+(profile.skills||[]).join(', '));
  if(profile.additionalFacts) extras.push('Informações adicionais: '+profile.additionalFacts);
  return [...lines.slice(0,70),...extras].filter(Boolean).join('\n').slice(0,3200);
}
function obviousUnsafeTerm(term,sourceText){
  const t=norm(term),src=norm(sourceText);
  const elevated=/\b(senior|sr\.?|pleno|coordenador|coordenadora|gerente|supervisor|supervisora|head|diretor|diretora|lead|especialista)\b/;
  if(elevated.test(t)&&!elevated.test(src)) return true;
  const credentialRoots=['tecnic','enfermeir','medic','advogad','engenheir','arquitet','psicolog','fisioterapeut','farmaceut','dentist','odontolog','nutricion','contador','contabilista'];
  if(credentialRoots.some(root=>t.includes(root)&&!src.includes(root))) return true;
  return false;
}
export async function buildSearchTerms(profile, filters) {
  const typed=String(filters.area||'').split(/[,;/]/).map(x=>x.trim()).filter(Boolean);
  const curriculum=compactProfessionalText(profile);
  const basis=typed.length?`ÁREA PRETENDIDA: ${typed.join(', ')}\nCURRÍCULO: ${curriculum}`:curriculum;
  const entryFallback=(filters.experienceLevel||'entry')==='entry'?['assistente administrativo','auxiliar administrativo','recepcionista','atendimento ao cliente','assistente comercial','customer success','inside sales','assistente de atendimento']:[];
  const fallback=[...new Set([...relatedTerms(basis),...(typed.length?[]:inferredTerms(profile)),...entryFallback,...genericProfileTerms(profile)])];
  const system='Você é o planejador de busca do LetsWork. Em UMA ÚNICA RESPOSTA, gere e revise uma família ampla de cargos plausíveis para o candidato. Use somente fatos profissionais comprovados e a área pretendida. Não invente formação, licença, registro, experiência ou senioridade. Não eleve credenciais. Use nomes curtos de cargos realmente usados em anúncios no Brasil. Antes de responder, elimine internamente duplicatas, variações cosméticas e funções incompatíveis. Retorne somente JSON.';
  const prompt=`DADOS VERIFICADOS:\n${String(basis).slice(0,3600)}\n\nNÍVEL DE EXPERIÊNCIA: ${filters.experienceLevel||'entry'}\nGere de 24 a 32 cargos distintos, misturando funções diretas, adjacentes e de entrada compatíveis. Cada termo deve ter no máximo 5 palavras. Também liste até 8 títulos claramente incompatíveis. Retorne exatamente {"terms":[...],"exclude":[...]}.`;
  const text=await askAI(system,prompt,{candidateId:profile.candidateId});
  const parsed=parseJsonLoose(text);
  const raw=Array.isArray(parsed?.terms)?parsed.terms.map(x=>String(x).trim()).filter(Boolean):[];
  const generated=[...new Set(raw.filter(x=>!obviousUnsafeTerm(x,basis)).filter(x=>!/^(?:estudante|tecn[oó]logo|bacharel|graduando|graduanda|formado|formada|curso de)\b/i.test(x)))];
  if(generated.length<12)throw new Error('ChatGPT não gerou termos de busca suficientes');
  const exclusions=Array.isArray(parsed?.exclude)?[...new Set(parsed.exclude.map(x=>String(x).trim()).filter(x=>x.length>=3))].slice(0,8):[];
  const final=[...new Set([...typed,...generated.slice(0,8),...fallback,...generated.slice(8)].map(x=>String(x).trim()).filter(Boolean))].slice(0,60);
  final.exclusions=exclusions;
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
async function searchRioVagasRecent(terms,filters,max=2200){
  const out=new Map(), cutoff=new Date(Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000).toISOString();
  const deadline=Date.now()+45000;
  let page=1,totalPages=1;
  while(page<=totalPages&&page<=30&&out.size<max&&Date.now()<deadline){
    const qs=new URLSearchParams({
      categories:'1',per_page:'100',page:String(page),orderby:'date',order:'desc',
      after:cutoff,_fields:'id,date,link,title,excerpt'
    });
    try{
      const r=await fetch(`https://riovagas.com.br/wp-json/wp/v2/posts?${qs}`,{
        headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(8000)
      });
      if(r.status===429){console.log(`[RioVagas] HTTP 429 na página ${page}; preservando ${out.size} vagas já coletadas`);break;}
      if(!r.ok)break;
      totalPages=Math.min(30,Math.max(1,Number(r.headers.get('x-wp-totalpages')||1)));
      const rows=await r.json();if(!Array.isArray(rows)||!rows.length)break;
      for(const row of rows){
        if(!String(row.link||'').includes('/riovagas/'))continue;
        const title=decodeHtml(row.title?.rendered||''),description=decodeHtml(row.excerpt?.rendered||'');
        if(!title||!row.link)continue;
        out.set(row.link,{source:'RioVagas',title,url:row.link,description,company:'',salary:titleSalary(title),
          location:titleLocation(title),publishedAt:row.date?`${row.date}-03:00`:'',loginFreeCandidate:true,broadCollection:true});
        if(out.size>=max)break;
      }
      if(rows.length<100||page>=totalPages)break;
      page++;
      await delay(180);
    }catch{break;}
  }
  console.log(`[RioVagas] feed recente amplo: ${out.size} vagas em ${page} página(s)`);
  return [...out.values()].slice(0,max);
}

function labeledValue(text, labels) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (let i=0;i<lines.length;i++) {
    const line = lines[i];
    for (const label of labels) {
      const rx = new RegExp(`^${label}\\s*:?\\s*(.*)$`,'i');
      const m = line.match(rx);
      if (m) return (m[1] || lines[i+1] || '').trim();
    }
  }
  return '';
}

function parseDetails(text, title) {
  const salary = labeledValue(text,['sal[aá]rio','remunera[cç][aã]o','bolsa(?: auxílio)?']) || titleSalary(title);
  const city = labeledValue(text,['cidade','munic[ií]pio']);
  const neighborhood = labeledValue(text,['bairro','local de trabalho','localiza[cç][aã]o','local']);
  const location = [neighborhood,city].filter(Boolean).join(' - ') || titleLocation(title);
  const contract = labeledValue(text,['regime de contrata[cç][aã]o','tipo de contrato','contrata[cç][aã]o']);
  return { salary, location, contractType:contract };
}
async function blockNoise(page) {
  await page.route('**/*', route => {
    const r = route.request();
    const u = r.url();
    const type = r.resourceType();
    if (/doubleclick|googlesyndication|google-analytics|googletagmanager|criteo|adnxs|smartadserver|amazon-adsystem/i.test(u)) return route.abort();
    if (['media','font','image','stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });
}

async function wordpressSearch(base, source, terms, max, filters={}) {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true, args:['--no-sandbox'] });
  const out=[], seen=new Set(), queue=terms.slice(0,source==='EmpregosRJ'?1:12);
  const deadline=Date.now()+(source==='EmpregosRJ'?3500:45000);
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000;
  let cursor=0;
  const parsePublished=value=>{
    const s=String(value||'').trim(); if(!s)return null;
    const m=s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
    if(m)return Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]),12);
    const d=Date.parse(s); return Number.isNaN(d)?null:d;
  };
  async function worker(){
    const page=await browser.newPage(); await blockNoise(page);
    try{
      while(cursor<queue.length&&out.length<max&&Date.now()<deadline){
        const term=queue[cursor++];
        const maxPages=source==='EmpregosRJ'?1:8;
        for(let n=1;n<=maxPages&&out.length<max&&Date.now()<deadline;n++){
          const prefix=n===1?base:`${base.replace(/\/$/,'')}/page/${n}/`;
          const url=`${prefix}?s=${encodeURIComponent(term)}`;
          try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:source==='EmpregosRJ'?3000:7000});}catch{break;}
          const rows=await page.locator('article').evaluateAll(arts=>arts.map(a=>{
            const l=a.querySelector('h1 a,h2 a,h3 a,.entry-title a');
            const excerpt=a.querySelector('.entry-summary,.entry-content,.excerpt')?.textContent?.trim()||'';
            const time=a.querySelector('time');
            const publishedAt=time?.getAttribute('datetime')||time?.textContent?.trim()||'';
            return l?{title:l.textContent.trim(),url:l.href,excerpt,publishedAt}:null;
          }).filter(Boolean));
          if(!rows.length)break;
          let allDatedOld=true;
          for(const r of rows){
            const ms=parsePublished(r.publishedAt); if(!ms||ms>=cutoff)allDatedOld=false;
            if(seen.has(r.url))continue; seen.add(r.url);
            out.push({...r,source,description:r.excerpt||'',company:'',salary:titleSalary(r.title),location:titleLocation(r.title),publishedAt:r.publishedAt||'',loginFreeCandidate:source==='RioVagas',broadCollection:true});
            if(out.length>=max)break;
          }
          if(allDatedOld)break;
          await delay(25);
        }
      }
    }finally{await page.close();}
  }
  try{await Promise.all(Array.from({length:Math.min(source==='EmpregosRJ'?1:2,queue.length)},()=>worker()));}
  finally{await browser.close();}
  return uniqByUrl(out).slice(0,max);
}
async function enrichWordpressJobs(rows, maxWorkers=6) {
  if (!rows.length) return rows;
  const browser = await chromium.launch({ executablePath:CHROME, headless:true, args:['--no-sandbox'] });
  let cursor = 0;
  async function worker() {
    const page = await browser.newPage();
    await blockNoise(page);
    try {
      while (cursor < rows.length) {
        const idx = cursor++;
        const job = rows[idx];
        try {
          await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:28000});
          const text = await page.locator('article, main').first().innerText({timeout:5000}).catch(async()=>await page.locator('body').innerText());
          const parsed = parseDetails(text,job.title);
          rows[idx] = { ...job, description:String(text||'').slice(0,24000),
            salary:parsed.salary || job.salary, location:parsed.location || job.location,
            contractType:parsed.contractType || '' };
        } catch {}
      }
    } finally { await page.close(); }
  }
  try { await Promise.all(Array.from({length:Math.min(maxWorkers,rows.length)},()=>worker())); }
  finally { await browser.close(); }
  return rows;
}
async function searchJooble(terms, filters, max) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return [];
  const out = [];
  const deadline=Date.now()+30000;
  for (const term of terms.slice(0,10)) {
    if (out.length >= max || Date.now()>=deadline) break;
    const body = { keywords:term, location:[filters.city,filters.state].filter(Boolean).join(', '), page:1 };
    try {
      const res = await fetch(`https://br.jooble.org/api/${key}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) out.push({
        source:'Jooble', title:j.title||'', company:j.company||'', salary:j.salary||'',
        location:j.location||'', url:j.link||'', description:j.snippet||'', contractType:j.type||'', publishedAt:j.updated||j.date||''
      });
    } catch {}
  }
  return uniqByUrl(out).slice(0,max);
}

async function searchRemotive(terms, max) {
  const out = [];
  const deadline=Date.now()+35000;
  for (const term of terms.slice(0,8)) {
    if (out.length >= max || Date.now()>=deadline) break;
    try {
      const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=${Math.min(100,max)}`,{signal:AbortSignal.timeout(7000)});
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) out.push({
        source:'Remotive', title:j.title||'', company:j.company_name||'', salary:j.salary||'',
        location:j.candidate_required_location||'Remoto', url:j.url||'', description:j.description||'',
        contractType:j.job_type||'', remote:true, publishedAt:j.publication_date||''
      });
    } catch {}
  }
  return uniqByUrl(out).slice(0,max);
}
function interleave(...lists) {
  const out = [];
  const maxLen = Math.max(0,...lists.map(x=>x.length));
  for (let i=0;i<maxLen;i++) {
    for (const list of lists) if (list[i]) out.push(list[i]);
  }
  return out;
}
const sourceCacheDir=path.join(storage.data,'source-cache');
fs.mkdirSync(sourceCacheDir,{recursive:true});
function sourceCachePath(name,terms,filters){
  const basis=JSON.stringify({
    name,
    strategy:name==='RioVagas'?'wp_api_recent_v3':'default_v1',
    terms:name==='RioVagas'?[]:terms.slice(0,12).map(norm),
    city:name==='RioVagas'?'':norm(filters.city),
    state:name==='RioVagas'?'RJ':norm(filters.state),
    nationwide:Boolean(filters.nationwide),
    recencyDays:Number(filters.recencyDays||15)
  });
  const hash=createHash('sha1').update(basis).digest('hex').slice(0,16);
  return path.join(sourceCacheDir,`${name.replace(/[^a-z0-9]+/gi,'_')}_${hash}.json`);
}
function recentCachedRows(rows,days=15){
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(days)||15))*86400000;
  return (Array.isArray(rows)?rows:[]).filter(job=>{
    const ms=Date.parse(String(job?.publishedAt||''));
    return Number.isFinite(ms)&&ms>=cutoff&&ms<=Date.now()+86400000;
  });
}
function loadSourceCache(name,terms,filters){
  try{
    const file=sourceCachePath(name,terms,filters);
    if(!fs.existsSync(file)) return [];
    return recentCachedRows(JSON.parse(fs.readFileSync(file,'utf8')),filters.recencyDays||15);
  }catch{return [];}
}
function saveSourceCache(name,terms,filters,rows){
  if(!rows?.length) return;
  try{
    fs.writeFileSync(sourceCachePath(name,terms,filters),JSON.stringify(rows),'utf8');
  }catch{}
}
async function prioritySource(name,promise,terms,filters,max=Infinity){
  const rows=await promise.catch(e=>{console.log(`[busca] ${name} falhou: ${String(e?.message||e)}`);return [];});
  const cached=loadSourceCache(name,terms,filters);
  if(rows.length){
    const merged=dedupeJobs([...rows,...cached]).slice(0,max);
    saveSourceCache(name,terms,filters,merged);
    if(cached.length&&merged.length>rows.length) console.log(`[busca] ${name}: preservando ${merged.length-rows.length} vagas recentes do cache`);
    return merged;
  }
  const fallback=cached.slice(0,max);
  if(fallback.length) console.log(`[busca] ${name}: usando fallback persistente com ${fallback.length} vagas recentes`);
  return fallback;
}
function canonicalJobUrl(value){
  try{
    const u=new URL(value);u.hash='';
    for(const k of [...u.searchParams.keys()]) if(/^utm_|^(ref|source|src|fbclid|gclid|trackingId|position|pageNum|refId)$/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/,'');
  }catch{return String(value||'').trim().replace(/\/$/,'');}
}
function dedupeJobs(rows){
  const out=[],seenUrl=new Set(),seenSemantic=new Set();
  for(const job of rows){
    if(!job?.url||!job?.title) continue;
    const urlKey=canonicalJobUrl(job.url);
    const day=String(job.publishedAt||'').slice(0,10);
    const semantic=[norm(job.title),norm(job.company),norm(job.location),day].join('|');
    const semanticStrong=norm(job.title).length>4&&norm(job.company).length>2&&day;
    if(seenUrl.has(urlKey)||(semanticStrong&&seenSemantic.has(semantic))) continue;
    seenUrl.add(urlKey);if(semanticStrong)seenSemantic.add(semantic);out.push(job);
  }
  return out;
}

export async function searchJobs(profile, filters, suppliedTerms=null) {
  const terms=Array.isArray(suppliedTerms)&&suppliedTerms.length?suppliedTerms:await buildSearchTerms(profile,filters);
  console.log('[busca] termos:',terms.slice(0,18));
  if(!terms.length) throw new Error('Não foi possível inferir uma área; use o filtro opcional de área.');
  const perSource=Math.min(3000,Math.max(1200,Number(filters.sourceLimit||2200)));
  const poolCap=Math.min(10000,Math.max(3000,Number(filters.poolLimit||7500)));
  const wantsRemote=(filters.workMode||'include_remote')!=='onsite_only';
  const region=norm([...(filters.states||[]),filters.state,...(filters.cities||[]),filters.city].filter(Boolean).join(' '));
  const wantsRj=filters.nationwide||!region||/\brj\b|rio de janeiro|niteroi|nova iguacu|duque de caxias|sao goncalo/.test(region);
  const safe=p=>p.catch(e=>{console.log('[busca] fonte falhou:',String(e?.message||e));return [];});
  const timed=(name,p,timeoutMs=65000)=>{const t=Date.now();return new Promise(resolve=>{let done=false;const timer=setTimeout(()=>{if(done)return;done=true;console.log(`[busca] ${name}: timeout após ${(timeoutMs/1000).toFixed(0)}s; seguindo com as demais fontes`);resolve([]);},timeoutMs);safe(p).then(rows=>{if(done)return;done=true;clearTimeout(timer);console.log(`[busca] ${name}: ${rows.length} vagas em ${((Date.now()-t)/1000).toFixed(1)}s`);resolve(rows);});});};
  // Fontes primárias entram primeiro e têm fallback persistente próprio.
  // Um pequeno head start evita que navegadores secundários disputem CPU/rede logo no início.
  const primaryWork=Promise.all([
    timed('Vagas.com',prioritySource('Vagas.com',searchVagasCom(terms,filters,Math.min(1800,perSource)),terms,filters,Math.min(1800,perSource))),
    wantsRj?timed('RioVagas',prioritySource('RioVagas',searchRioVagasRecent(terms,filters,Math.min(2200,perSource)),terms,filters,Math.min(2200,perSource))):Promise.resolve([])
  ]);
  await delay(1000);
  const secondaryWork=Promise.all([
    timed('LinkedIn',searchLinkedIn(terms,filters,Math.min(1600,perSource))),
    timed('Gupy',searchGupy(terms,filters,Math.min(1200,perSource))),
    timed('Tramper',prioritySource('Tramper',searchTramper(terms,filters,Math.min(800,perSource)),terms,filters,Math.min(800,perSource))),
    timed('Huanna',prioritySource('Huanna',searchHuanna(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource))),
    timed('BeaVagas',prioritySource('BeaVagas',searchBeaVagas(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource))),
    timed('EmpregoDaqui',prioritySource('EmpregoDaqui',searchEmpregoDaqui(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource))),
    wantsRemote?timed('Remotive',searchRemotive(terms,Math.min(300,perSource))):Promise.resolve([]),
    timed('Jooble',searchJooble(terms,filters,Math.min(900,perSource))),
    timed('Adzuna',searchAdzuna(terms,filters,Math.min(900,perSource)))
  ]);
  const [[vagas,rio],[linkedin,gupy,tramper,huanna,beavagas,empregodaqui,remotive,jooble,adzuna]]=await Promise.all([primaryWork,secondaryWork]);
  const [empregos,linkvagas]=await Promise.all([
    wantsRj?timed('EmpregosRJ',wordpressSearch('https://empregosrj.com.br/','EmpregosRJ',terms,Math.min(600,perSource),filters)):Promise.resolve([]),
    timed('Link Vagas',searchLinkVagas(terms,filters,Math.min(700,perSource)))
  ]);
  // Coleta ampla só com listagens/cards. A página completa continua reservada
  // para o processamento da vaga; não existe mais teto de 500 na coleta.
  const wordpress=interleave(rio,empregos).slice(0,perSource);
  const pooled=dedupeJobs(interleave(wordpress,vagas,tramper,huanna,beavagas,empregodaqui,linkedin,gupy,linkvagas,jooble,adzuna,remotive));
  console.log(`[busca] pool deduplicado: ${pooled.length}`);
  return pooled.slice(0,poolCap);
}
