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
import { searchWebJobs } from '../sources/webjobs.mjs';
import { searchInfoJobs, searchTrabalhaBrasil } from '../sources/jobboards.mjs';
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
  const raw=String(profile.rawText||'');
  const parts=raw.split(/\n=== DOCUMENTO DE APOIO:/i);
  const primary=parts[0]||'';
  const support=parts.slice(1).join('\n');
  const cleanLines=text=>String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>!/(?:e-?mail|telefone|linkedin|instagram|cpf|cep|www\.|https?:)/i.test(x));
  const primaryLines=cleanLines(primary).slice(0,55);
  const supportLines=cleanLines(support).slice(0,45);
  const extras=[];
  if((profile.skills||[]).length) extras.push('COMPETÊNCIAS EXTRAÍDAS: '+(profile.skills||[]).join(', '));
  if(profile.additionalFacts) extras.push('INFORMAÇÕES ADICIONAIS: '+profile.additionalFacts);
  const blocks=['CURRÍCULO PRINCIPAL:',...primaryLines];
  if(supportLines.length)blocks.push('PORTFÓLIO / DOCUMENTOS DE APOIO:',...supportLines);
  blocks.push(...extras);
  return blocks.filter(Boolean).join('\n').slice(0,5600);
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
  const strongSingles=new Set(['design','ux','ui','marketing','branding','conteudo','content','audiovisual','publicidade','comunicacao','midia','motion']);
  for(const raw of approved){
    const term=String(raw||'').trim();if(!term)continue;
    out.push(term);
    let base=term
      .replace(/^(?:estagi[aá]ri[oa]|est[aá]gio|assistente|auxiliar|analista|designer)\s+(?:de|em|para)\s+/i,'')
      .replace(/^(?:estagi[aá]ri[oa]|est[aá]gio|assistente|auxiliar|analista|designer)\s+/i,'')
      .replace(/\s+(?:j[uú]nior|jr\.?|trainee)$/i,'')
      .replace(/\s+designer$/i,'')
      .trim();
    const tokens=norm(base).split(/\s+/).filter(Boolean);
    if(base.length>=2&&base.toLowerCase()!==term.toLowerCase()&&(tokens.length>=2||strongSingles.has(tokens[0])))out.push(base);
  }
  return [...new Set(out)];
}
export async function buildSearchTerms(profile, filters) {
  const typed=String(filters.area||'').split(/[,;/]/).map(x=>x.trim()).filter(Boolean);
  const curriculum=compactProfessionalText(profile);
  const basis=typed.length?`ÁREA PRETENDIDA: ${typed.join(', ')}\nCURRÍCULO: ${curriculum}`:curriculum;
  const system='Você é o planejador de carreira e busca do LetsWork. Primeiro determine UMA árvore profissional-alvo para o candidato. Se houver ÁREA PRETENDIDA explícita, ela é a prioridade máxima. Caso contrário, derive o foco principalmente de graduação/formação em andamento ou concluída, cursos diretamente relacionados, portfólio e competências técnicas. Experiências antigas ou genéricas fora desse foco NÃO devem abrir uma segunda carreira. Expanda apenas para áreas profissionais adjacentes que usem a mesma formação/competências. Nível de entrada altera apenas senioridade dentro da mesma árvore: estágio, assistente ou júnior da área; nunca recepção, administrativo, vendas ou atendimento só por serem vagas de entrada. Não invente formação, licença, experiência ou senioridade. Retorne somente JSON.';
  const prompt=`DADOS VERIFICADOS:\n${String(basis).slice(0,6000)}\n\nNÍVEL DE EXPERIÊNCIA: ${filters.experienceLevel||'entry'}\n\nMonte a árvore profissional e o plano de busca. core = cargos diretamente ligados ao foco. adjacent = cargos de áreas realmente adjacentes que aproveitam a MESMA formação, cursos, portfólio, ferramentas ou entregáveis profissionais. queries = termos de pesquisa com alto recall dentro EXATAMENTE dessa árvore: use nomes amplos da profissão, especialidades e sinônimos em português e inglês que sejam comuns em anúncios no Brasil. queries não são autorização para outra carreira. Exemplo: para Design visual/digital, queries podem conter Design Gráfico, Graphic Designer, UX, UI, Social Media, Content Designer, Motion Design, Branding, Audiovisual etc., se sustentados pelo currículo. Para Design visual/digital, trate também como adjacent cargos de Marketing, Publicidade, Comunicação, Social Media, Conteúdo e Mídias Digitais quando as atividades usarem criação visual, peças, redes sociais, identidade, edição de imagem/vídeo ou outros entregáveis sustentados pelo currículo/portfólio. Não exclua uma família inteira apenas porque uma ferramenta específica não aparece; a verificação posterior rejeitará a vaga se essa ferramenta for requisito obrigatório. Para outras formações, faça expansão análoga. exclude deve incluir tanto profissões incompatíveis quanto colisões de palavra-chave e especializações parecidas mas sem suporte factual no currículo; por exemplo, um currículo de design visual não deve aceitar automaticamente Design Educacional, Design de Interiores ou Designer de Sobrancelhas. Não inclua recepção, administrativo, vendas, atendimento, serviços gerais ou outra profissão apenas por ser vaga de entrada. Cada item deve ser curto. Gere 12–30 core, 10–30 adjacent e 12–40 queries quando houver base factual. Retorne exatamente {"focus":"...","core":[...],"adjacent":[...],"queries":[...],"exclude":[...]}.`;
  const planDir=path.join(storage.data,'career-plan-cache');
  fs.mkdirSync(planDir,{recursive:true});
  const planHash=createHash('sha1').update(JSON.stringify({plannerVersion:'quality-agent-v4-role-tree',candidateId:profile.candidateId||0,basis,experienceLevel:filters.experienceLevel||'entry'})).digest('hex').slice(0,20);
  const planFile=path.join(planDir,`plan_${planHash}.json`);
  let parsed=null;
  try{if(fs.existsSync(planFile))parsed=JSON.parse(fs.readFileSync(planFile,'utf8'));}catch{}
  if(!parsed){
    const text=await askAI(system,prompt,{candidateId:profile.candidateId});
    parsed=parseJsonLoose(text)||{};
    try{fs.writeFileSync(planFile,JSON.stringify(parsed),'utf8');}catch{}
  }
  const sanitize=list=>[...new Set((Array.isArray(list)?list:[]).map(x=>String(x).trim()).filter(Boolean).filter(x=>!obviousUnsafeTerm(x,basis)).filter(x=>!/^(?:estudante|tecn[oó]logo|bacharel|graduando|graduanda|formado|formada|curso de)\b/i.test(x)))];
  let core=sanitize(parsed.core);
  let adjacent=sanitize(parsed.adjacent).filter(x=>!core.includes(x));
  let generated=[...core,...adjacent];
  const plannedQueries=sanitize(parsed.queries);
  if(generated.length<5){
    const fallbackSeeds=sanitize([...genericProfileTerms(profile),...inferredTerms(profile)]);
    const extras=fallbackSeeds.filter(x=>!generated.includes(x)).slice(0,24);
    core=[...new Set([...core,...extras.slice(0,18)])];
    adjacent=[...new Set([...adjacent,...extras.slice(18)])].filter(x=>!core.includes(x));
    generated=[...core,...adjacent];
  }
  if(!generated.length&&!plannedQueries.length)throw new Error('Não foi possível inferir uma árvore profissional suficiente para este currículo');
  const roleSeeds=generated.length?generated:plannedQueries.slice(0,24);
  const derivedQueries=searchAliases([...typed,...roleSeeds,...plannedQueries.slice(0,24)]);
  const queries=[...new Set([...plannedQueries,...derivedQueries])].slice(0,60);
  const exclusions=Array.isArray(parsed.exclude)?[...new Set(parsed.exclude.map(x=>String(x).trim()).filter(x=>x.length>=3))].slice(0,24):[];
  const final=[...new Set([...typed,...queries])].slice(0,60);
  final.focus=String(parsed.focus||typed.join(', ')||'').trim();
  final.core=[...new Set([...typed,...core])].slice(0,30);
  final.adjacent=adjacent.slice(0,30);
  final.queries=queries;
  final.targets=[...new Set([...core,...adjacent,...plannedQueries,...derivedQueries])].slice(0,120);
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
      after:cutoff,_fields:'id,date,link,title,excerpt,content'
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
        const title=decodeHtml(row.title?.rendered||''),description=decodeHtml(row.content?.rendered||row.excerpt?.rendered||'');
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
  const out=[], seen=new Set(), queue=[...new Set(terms)].slice(0,60);
  const deadline=Date.now()+60000;
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
        const maxPages=20;
        for(let n=1;n<=maxPages&&out.length<max&&Date.now()<deadline;n++){
          const prefix=n===1?base:`${base.replace(/\/$/,'')}/page/${n}/`;
          const url=`${prefix}?s=${encodeURIComponent(term)}`;
          try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:7000});}catch{break;}
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
  try{await Promise.all(Array.from({length:Math.min(4,queue.length||1)},()=>worker()));}
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
  const deadline=Date.now()+60000;
  for (const term of [...new Set(terms)].slice(0,60)) {
    if (out.length >= max || Date.now()>=deadline) break;
    for(let page=1;page<=10&&out.length<max&&Date.now()<deadline;page++){
      const body = { keywords:term, location:[filters.city,filters.state].filter(Boolean).join(', '), page };
      try {
        const res = await fetch(`https://br.jooble.org/api/${key}`,{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)
        });
        if (!res.ok) break;
        const data = await res.json(); const rows=data.jobs||[]; if(!rows.length)break;
        for (const j of rows) out.push({
          source:'Jooble', title:j.title||'', company:j.company||'', salary:j.salary||'',
          location:j.location||'', url:j.link||'', description:j.snippet||'', contractType:j.type||'', publishedAt:j.updated||j.date||''
        });
      } catch { break; }
    }
  }
  return uniqByUrl(out).slice(0,max);
}

async function searchRemotive(terms, max) {
  const out = [];
  const deadline=Date.now()+60000;
  for (const term of [...new Set(terms)].slice(0,60)) {
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
    terms:name==='RioVagas'?[]:terms.slice(0,60).map(norm),
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
function likelyJobDetail(job){
  const title=norm(job?.title),url=String(job?.url||'');
  if(!title||!url)return false;
  if(/^(?:\d+\s+)?vagas?\s+(?:de|para)\b|^vagas? de emprego\b|\bvagas? dispon[ií]veis?\b/.test(title))return false;
  if(/linkedin\.com\/jobs\/(?!view\/)[^?]*vagas/i.test(url))return false;
  if(/indeed\.com\/(?:q-|jobs\?)/i.test(url))return false;
  if(/glassdoor\.com\.br\/Vaga\/.*SRCH_/i.test(url))return false;
  if(/catho\.com\.br\/vagas\/[^/]+\/(?:rio-de-janeiro-rj|sao-paulo-sp|[^/]+-[a-z]{2})\/?(?:\?|$)/i.test(url))return false;
  if(/talent\.com\/(?:view|jobs)?\/?(?:\?|$)/i.test(url)&&!/job\//i.test(url))return false;
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
  async function runSourceQueue(tasks,limit=4){
    const results={};let cursor=0;
    async function worker(){
      while(cursor<tasks.length){
        const index=cursor++,task=tasks[index];
        try{results[task.key]=await task.run();}catch(e){console.log('[busca] fonte falhou:',task.key,String(e?.message||e));results[task.key]=[];}
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,tasks.length)},()=>worker()));
    return results;
  }
  const sourceResults=await runSourceQueue([
    {key:'vagas',run:()=>timed('Vagas.com',prioritySource('Vagas.com',searchVagasCom(terms,filters,Math.min(1800,perSource)),terms,filters,Math.min(1800,perSource)),75000)},
    {key:'rio',run:()=>wantsRj?timed('RioVagas',prioritySource('RioVagas',searchRioVagasRecent(terms,filters,Math.min(2200,perSource)),terms,filters,Math.min(2200,perSource)),75000):Promise.resolve([])},
    {key:'linkedin',run:()=>timed('LinkedIn',searchLinkedIn(terms,filters,Math.min(1600,perSource)),90000)},
    {key:'gupy',run:()=>timed('Gupy',searchGupy(terms,filters,Math.min(1200,perSource)),90000)},
    {key:'tramper',run:()=>timed('Tramper',prioritySource('Tramper',searchTramper(terms,filters,Math.min(800,perSource)),terms,filters,Math.min(800,perSource)),75000)},
    {key:'huanna',run:()=>timed('Huanna',prioritySource('Huanna',searchHuanna(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource)),75000)},
    {key:'beavagas',run:()=>timed('BeaVagas',prioritySource('BeaVagas',searchBeaVagas(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource)),75000)},
    {key:'empregodaqui',run:()=>timed('EmpregoDaqui',prioritySource('EmpregoDaqui',searchEmpregoDaqui(terms,filters,Math.min(500,perSource)),terms,filters,Math.min(500,perSource)),75000)},
    {key:'remotive',run:()=>wantsRemote?timed('Remotive',searchRemotive(terms,Math.min(300,perSource)),75000):Promise.resolve([])},
    {key:'jooble',run:()=>timed('Jooble',searchJooble(terms,filters,Math.min(900,perSource)),75000)},
    {key:'adzuna',run:()=>timed('Adzuna',searchAdzuna(terms,filters,Math.min(900,perSource)),75000)},
    {key:'empregos',run:()=>wantsRj?timed('EmpregosRJ',wordpressSearch('https://empregosrj.com.br/','EmpregosRJ',terms,Math.min(600,perSource),filters),75000):Promise.resolve([])},
    {key:'linkvagas',run:()=>timed('Link Vagas',searchLinkVagas(terms,filters,Math.min(700,perSource)),75000)},
    {key:'webjobs',run:()=>timed('Web',prioritySource('Web',searchWebJobs(terms,filters,Math.min(1800,perSource)),terms,filters,Math.min(1800,perSource)),90000)},
    {key:'infojobs',run:()=>timed('InfoJobs',prioritySource('InfoJobs',searchInfoJobs(terms,filters,Math.min(1400,perSource)),terms,filters,Math.min(1400,perSource)),90000)},
    {key:'trabalhabrasil',run:()=>timed('Trabalha Brasil',prioritySource('Trabalha Brasil',searchTrabalhaBrasil(terms,filters,Math.min(1000,perSource)),terms,filters,Math.min(1000,perSource)),100000)}
  ],Math.max(2,Math.min(5,Number(process.env.SEARCH_SOURCE_WORKERS||4))));
  const {vagas=[],rio=[],linkedin=[],gupy=[],tramper=[],huanna=[],beavagas=[],empregodaqui=[],remotive=[],jooble=[],adzuna=[],empregos=[],linkvagas=[],webjobs=[],infojobs=[],trabalhabrasil=[]}=sourceResults;

  // Coleta ampla só com listagens/cards. A página completa continua reservada
  // para o processamento da vaga; não existe mais teto de 500 na coleta.
  const wordpress=interleave(rio,empregos).slice(0,perSource);
  const pooled=dedupeJobs(interleave(webjobs,infojobs,trabalhabrasil,wordpress,vagas,tramper,huanna,beavagas,empregodaqui,linkedin,gupy,linkvagas,jooble,adzuna,remotive));
  const cachedPool=loadSourceCache('SearchPool',terms,filters);
  const stablePool=dedupeJobs([...pooled,...cachedPool]).slice(0,poolCap);
  saveSourceCache('SearchPool',terms,filters,stablePool);
  if(cachedPool.length&&stablePool.length>pooled.length)console.log(`[busca] pool: preservando ${stablePool.length-pooled.length} vagas recentes da pesquisa anterior`);
  console.log(`[busca] pool deduplicado estável: ${stablePool.length}`);
  return stablePool;
}
