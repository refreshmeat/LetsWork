const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const decode=s=>String(s||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const strip=s=>clean(decode(String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')));
const slug=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const uniq=rows=>[...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];
const abs=(href,base)=>{try{return new URL(decode(href),base).toString();}catch{return '';}};
async function get(url,timeout=9000){try{const r=await fetch(url,{headers:{'user-agent':UA,'accept-language':'pt-BR,pt;q=0.9,en;q=0.7'},redirect:'follow',signal:AbortSignal.timeout(timeout)});return r.ok?await r.text():'';}catch{return '';}}

function infoCard(block,base,cutoff){
  const href=block.match(/data-href="([^"]+__\d+\.aspx)"/i)?.[1]||block.match(/href="([^"]+__\d+\.aspx)"/i)?.[1]||'';
  const title=strip(block.match(/class="[^"]*js_vacancyTitle[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||'');
  const d=block.match(/class="js_date"[^>]*data-value="(\d{4})\/(\d{2})\/(\d{2})/i);
  if(!href||!title||!d)return null;
  const publishedAt=d[1]+'-'+d[2]+'-'+d[3],ms=Date.parse(publishedAt+'T12:00:00-03:00');
  if(!Number.isFinite(ms)||ms<cutoff)return null;
  const text=strip(block);
  const lm=text.match(/([A-Za-zÀ-ÿ .'-]{3,60})\s*-\s*([A-Z]{2})\b/);
  const salary=text.match(/R\$\s*[\d.]+(?:,\d{2})?(?:\s+a\s+R\$\s*[\d.]+(?:,\d{2})?)?/i)?.[0]||'';
  return {source:'InfoJobs',title,company:'',salary,location:lm?clean(lm[1])+' - '+lm[2]:'',url:abs(href,base),description:text.slice(0,9000),contractType:'',publishedAt,loginFreeCandidate:false};
}
export async function searchInfoJobs(terms,filters,max=1200){
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000;
  const place=slug(filters.city||filters.state||'');
  const queue=[...new Set((terms||[]).map(x=>String(x||'').trim()).filter(Boolean))].slice(0,45);
  const out=new Map(),deadline=Date.now()+70000;let cursor=0;
  async function worker(){
    while(cursor<queue.length&&out.size<max&&Date.now()<deadline){
      const term=queue[cursor++],ts=slug(term);
      const url='https://www.infojobs.com.br/vagas-de-emprego-'+ts+(place?'-em-'+place:'')+'.aspx';
      const html=await get(url,10000); if(!html)continue;
      const cards=html.match(/<div data-typesimilar=[\s\S]*?class="card card-shadow[\s\S]*?(?=<div data-typesimilar=|$)/gi)||[];
      for(const card of cards){const j=infoCard(card,url,cutoff);if(j&&!out.has(j.url)){out.set(j.url,j);if(out.size>=max)break;}}
    }
  }
  await Promise.all(Array.from({length:Math.min(5,queue.length||1)},()=>worker()));
  const rows=[...out.values()].slice(0,max);
  console.log('[InfoJobs] '+rows.length+' vagas recentes');
  return rows;
}

function tbCards(html,base){
  const out=[];
  for(const block of String(html||'').match(/<article class="job-card"[\s\S]*?<\/article>/gi)||[]){
    const href=block.match(/data-job-url="([^"]+)"/i)?.[1]||block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*job-link/i)?.[1]||'';
    const title=strip(block.match(/class="job-title"[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||'').replace(/^Vaga de\s+/i,'');
    if(!href||!title)continue;
    const company=strip(block.match(/class="job-company"[^>]*>([\s\S]*?)<\/p>/i)?.[1]||'');
    const location=strip(block.match(/class="job-location"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]||'');
    const salary=strip(block.match(/class="job-salary"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]||'');
    const contractType=strip(block.match(/class="employment-type"[^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
    out.push({source:'Trabalha Brasil',title,company,salary,location,url:abs(href,base),description:strip(block).slice(0,5000),contractType,loginFreeCandidate:false});
  }
  return out;
}
function jobPosting(html){
  for(const m of String(html||'').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){
    try{const data=JSON.parse(m[1].trim());const arr=Array.isArray(data)?data:[data];const hit=arr.find(x=>String(x?.['@type']||'').toLowerCase()==='jobposting');if(hit)return hit;}catch{}
  }
  return null;
}
function salaryText(base){
  const v=base?.value;if(!v)return '';
  const fmt=n=>Number.isFinite(Number(n))?'R$ '+Number(n).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}):'';
  const lo=fmt(v.minValue),hi=fmt(v.maxValue),one=fmt(v.value);
  return lo&&hi?lo+' a '+hi:(one||lo||hi);
}
function locationText(j){
  if(String(j?.jobLocationType||'').toUpperCase()==='TELECOMMUTE')return 'Remoto';
  const loc=Array.isArray(j?.jobLocation)?j.jobLocation[0]:j?.jobLocation;
  const a=loc?.address||{}; return [a.addressLocality,a.addressRegion].filter(Boolean).join(' - ');
}
async function enrichTb(rows,filters,max){
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000;
  const source=rows.slice(0,Math.min(max,500)),out=[];let cursor=0;const deadline=Date.now()+75000;
  async function worker(){
    while(cursor<source.length&&Date.now()<deadline){
      const j=source[cursor++],html=await get(j.url,10000);if(!html)continue;
      const p=jobPosting(html);if(!p?.datePosted)continue;
      const ms=Date.parse(p.datePosted);if(!Number.isFinite(ms)||ms<cutoff||ms>Date.now()+86400000)continue;
      out.push({...j,title:clean(p.title||j.title),company:clean(p.hiringOrganization?.name||j.company),salary:salaryText(p.baseSalary)||j.salary,location:locationText(p)||j.location,description:strip(p.description||j.description).slice(0,24000),contractType:clean(p.employmentType||j.contractType),publishedAt:new Date(ms).toISOString(),remote:String(p.jobLocationType||'').toUpperCase()==='TELECOMMUTE'});
    }
  }
  await Promise.all(Array.from({length:Math.min(10,source.length||1)},()=>worker()));
  return uniq(out).slice(0,max);
}
export async function searchTrabalhaBrasil(terms,filters,max=900){
  const city=slug(filters.city||''),uf=String(filters.state||filters.states?.[0]||'').trim().toLowerCase();
  if(!city||!uf)return [];
  const queue=[...new Set((terms||[]).map(x=>String(x||'').trim()).filter(Boolean))].slice(0,40);
  const raw=new Map(),deadline=Date.now()+45000;let cursor=0;
  async function worker(){
    while(cursor<queue.length&&raw.size<max&&Date.now()<deadline){
      const term=queue[cursor++],url='https://www.trabalhabrasil.com.br/vagas-de-emprego-em-'+city+'-'+uf+'/'+slug(term);
      const html=await get(url,10000);if(!html)continue;
      for(const j of tbCards(html,url)){if(!raw.has(j.url)){raw.set(j.url,j);if(raw.size>=max)break;}}
    }
  }
  await Promise.all(Array.from({length:Math.min(5,queue.length||1)},()=>worker()));
  const rows=await enrichTb([...raw.values()],filters,max);
  console.log('[Trabalha Brasil] '+rows.length+' vagas recentes');
  return rows;
}
