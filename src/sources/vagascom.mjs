import fs from 'fs';
import path from 'path';
import { storage } from '../storage.mjs';

const normSlug=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const strip=s=>clean(decode(String(s||'').replace(/<[^>]+>/g,' ')));
const dateMs=s=>{const t=clean(s).toLowerCase();let d=new Date();d.setHours(12,0,0,0);if(t==='hoje')return d.getTime();if(t==='ontem'){d.setDate(d.getDate()-1);return d.getTime();}const rel=t.match(/h[aá]\s*(\d+)\s*dias?/);if(rel){d.setDate(d.getDate()-Number(rel[1]));return d.getTime();}const m=t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return Date.UTC(+m[3],+m[2]-1,+m[1],12);const p=Date.parse(t);return Number.isNaN(p)?0:p;};
const normalizedDate=s=>{const ms=dateMs(s);return ms?new Date(ms).toISOString().slice(0,10):'';};
const hosts=['https://cf-www.vagas.com.br','https://nossasvagas.vagas.com.br','https://www.vagas.com.br'];
const stateNames={AC:'Acre',AL:'Alagoas',AP:'Amapá',AM:'Amazonas',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',ES:'Espírito Santo',GO:'Goias',MA:'Maranhão',MT:'Mato Grosso',MS:'Mato Grosso do Sul',MG:'Minas Gerais',PA:'Pará',PB:'Paraíba',PR:'Paraná',PE:'Pernambuco',PI:'Piauí',RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',RS:'Rio Grande do Sul',RO:'Rondônia',RR:'Roraima',SC:'Santa Catarina',SP:'São Paulo',SE:'Sergipe',TO:'Tocantins'};
const stateFile=path.join(storage.data,'source-cache','vagascom_state.json');
const fallbackFile=path.join(storage.data,'source-cache','vagascom_last_good.json');
let lastGood=[];

function readState(){try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return {};}}
function writeState(v){try{fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,JSON.stringify(v),'utf8');}catch{}}
function readFallback(days=15,max=2000){try{const cutoff=Date.now()-Math.max(1,Math.min(60,Number(days)||15))*86400000;return JSON.parse(fs.readFileSync(fallbackFile,'utf8')).filter(j=>{const ms=dateMs(j.publishedAt);return ms&&ms>=cutoff&&ms<=Date.now()+86400000;}).slice(0,max);}catch{return [];}}
function saveFallback(rows){if(!rows?.length)return;try{fs.mkdirSync(path.dirname(fallbackFile),{recursive:true});fs.writeFileSync(fallbackFile,JSON.stringify(rows),'utf8');}catch{}}
function matchesTerms(job,terms){
  const text=clean(`${job.title||''} ${job.description||''}`).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return (terms||[]).some(term=>{const t=clean(term).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();return t.length>=3&&text.includes(t);});
}
function indexedTitle(raw,url){
  const t=strip(raw).replace(/^Vaga\s+/i,'').replace(/\s+\d+\s*\|\s*Vagas\.com.*$/i,'').replace(/\s+-\s+(?:Rio de Janeiro|RJ).*$/i,'').trim();
  if(t)return t;
  const slug=String(url||'').split('/').pop()||'';
  return slug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}
async function searchIndexedVagas(terms,filters,max=400){
  const out=new Map(),cutoff=new Date(Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000).toISOString().slice(0,10);
  const place=!filters.nationwide?(filters.city||filters.state||'Brasil'):'Brasil';
  for(const term of [...new Set(terms)].slice(0,60)){
    if(out.size>=max)break;
    const q=`site:vagas.com.br/vagas "${term}" "${place}" after:${cutoff}`;
    try{
      const r=await fetch('https://search.brave.com/search?q='+encodeURIComponent(q)+'&source=web',{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(8000)});
      if(!r.ok)continue;
      const html=await r.text();
      const blocks=html.split(/<div class="snippet [^"]*"[^>]*data-type="web"[^>]*>/i).slice(1);
      for(const block of blocks){
        const href=decode(block.match(/<a href="(https:\/\/www\.vagas\.com\.br\/vagas\/v\d+\/[^"]+)"/i)?.[1]||'');
        if(!href)continue;
        const rawTitle=decode(block.match(/<div class="title[^"]*"[^>]*title="([^"]+)"/i)?.[1]||'');
        const description=strip(block.match(/<div class="generic-snippet[\s\S]*?<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
        const title=indexedTitle(rawTitle,href); if(!title)continue;
        out.set(href,{source:'Vagas.com',title,company:'',location:place,url:href,publishedAt:'',salary:'',description,contractType:'',remote:/home office|remoto/i.test(`${title} ${description}`),pcd:/\bpcd\b|pessoa.{0,30}defici/i.test(`${title} ${description}`),pcdExclusive:/exclusiva.{0,40}(?:pcd|pessoa.{0,20}defici)/i.test(`${title} ${description}`),loginFreeCandidate:false,requiresLogin:true,indexedRecent:true});
        if(out.size>=max)break;
      }
    }catch{}
    await new Promise(r=>setTimeout(r,180));
  }
  const rows=[...out.values()].slice(0,max);
  if(rows.length)console.log(`[Vagas.com] fallback de índice público: ${rows.length} links individuais`);
  return rows;
}

async function fetchSearch(pathname,params){
  let lastStatus=0;
  for(const host of hosts){
    try{
      const r=await fetch(`${host}${pathname}?${params}`,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(7000)});
      lastStatus=r.status;
      if(r.ok)return {response:r,host,status:r.status};
      if(![403,429,500,502,503,504].includes(r.status))return {response:r,host,status:r.status};
    }catch{}
  }
  return {response:null,host:'',status:lastStatus};
}

function parsePage(html,origin){
  return String(html||'').split(/<li class="vaga[^>]*>/i).slice(1).map(raw=>raw.split(/<\/li>/i)[0]).map(block=>{
    const href=decode(block.match(/<a[^>]*class="[^"]*link-detalhes-vaga[^"]*"[^>]*href="([^"]+)"/i)?.[1]||'');
    const title=decode(block.match(/<a[^>]*class="[^"]*link-detalhes-vaga[^"]*"[^>]*title="([^"]+)"/i)?.[1]||'');
    const company=strip(block.match(/<span[^>]*class="emprVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const level=strip(block.match(/<span[^>]*class="nivelVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const location=strip(block.match(/<div[^>]*class="vaga-local"[^>]*>([\s\S]*?)(?:<div[^>]*class="tooltip-place"|<\/div>)/i)?.[1]);
    const publishedRaw=strip(block.match(/<span[^>]*class="[^"]*data-publicacao[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const publishedAt=normalizedDate(publishedRaw);
    const description=strip(block.match(/<div[^>]*class="detalhes"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const url=href?(href.startsWith('http')?href:`${origin}${href}`):'';
    const pcdExclusive=/exclusiva.{0,40}(?:pcd|pessoa.{0,20}defici)/i.test(`${title} ${description}`);
    return url&&title?{source:'Vagas.com',title,company,location,url,publishedAt,salary:'',description,contractType:/est[aá]gio/i.test(level)?'Estágio':'',remote:/home office|remoto/i.test(`${title} ${description} ${location}`),pcd:/\bpcd\b|pessoa.{0,30}defici/i.test(`${title} ${description}`),pcdExclusive,loginFreeCandidate:false}:null;
  }).filter(Boolean);
}

function decodeDuckUrl(href){
  try{
    const raw=decode(String(href||''));
    const full=raw.startsWith('//')?'https:'+raw:raw;
    const u=new URL(full,'https://duckduckgo.com');
    return decodeURIComponent(u.searchParams.get('uddg')||'');
  }catch{return '';}
}
async function indexedFallback(terms,filters,max=400){
  const out=new Map(),days=Math.max(1,Math.min(60,Number(filters.recencyDays||15)));
  const cutoff=Date.now()-days*86400000;
  const place=!filters.nationwide?(filters.city||filters.state||''):'';
  for(const term of [...new Set(terms)].slice(0,60)){
    if(out.size>=max)break;
    const q=['site:vagas.com.br/vagas/v',term,place].filter(Boolean).join(' ');
    try{
      const r=await fetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(q)+'&kl=br-pt',{headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(7000)});
      if(!r.ok)continue;
      const html=await r.text();
      const blocks=html.split(/<div class="result results_links[^>]*>/i).slice(1);
      for(const block of blocks){
        const href=block.match(/class="result__a"[^>]*href="([^"]+)"/i)?.[1]||'';
        const url=decodeDuckUrl(href);
        if(!/https?:\/\/(?:www\.|api\.|nossasvagas\.)?vagas\.com\.br\/vagas\/v\d+/i.test(url))continue;
        const title=strip(block.match(/class="result__a"[^>]*>[\s\S]*?<\/a>/i)?.[0]||'').replace(/^Vaga\s+/i,'').replace(/\s+\|\s+Vagas\.com.*$/i,'');
        const snippet=strip(block.match(/class="result__snippet"[^>]*>[\s\S]*?<\/a>/i)?.[0]||'');
        const iso=block.match(/(20\d{2}-\d{2}-\d{2})T/i)?.[1]||'';
        const rel=snippet.match(/h[aá]\s*(\d+)\s*dias?/i);
        let publishedAt=iso;
        if(!publishedAt&&rel){const d=new Date();d.setDate(d.getDate()-Number(rel[1]));publishedAt=d.toISOString().slice(0,10);}
        const ms=dateMs(publishedAt); if(!ms||ms<cutoff||ms>Date.now()+86400000)continue;
        out.set(url,{source:'Vagas.com',title:title||term,company:'',location:place,salary:'',url,description:snippet,contractType:'',publishedAt,loginFreeCandidate:false,indexedFallback:true});
      }
      await new Promise(r=>setTimeout(r,250));
    }catch{}
  }
  const rows=[...out.values()].slice(0,max);
  if(rows.length)saveFallback(rows);
  console.log(`[Vagas.com] fallback indexado: ${rows.length} vagas recentes`);
  return rows;
}
export async function searchVagasCom(terms,filters,max=400){
  const state=readState();
  const last429=Date.parse(state.last429At||'')||0;
  if(Number(state.blockedUntil||0)>Date.now()||(last429&&Date.now()-last429<60*60*1000)){
    const cached=readFallback(filters.recencyDays,max).filter(j=>matchesTerms(j,terms));
    if(cached.length>=20){
      console.log(`[Vagas.com] cooldown ativo; usando ${cached.length} vagas recentes do cache`);
      return cached;
    }
    console.log('[Vagas.com] cooldown sem cache útil; tentando host oficial alternativo uma vez');
  }
  const jobs=new Map();
  const deadline=Date.now()+45000;
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000;
  const uf=String(filters.state||filters.states?.[0]||'').toUpperCase();
  const stateValue=!filters.nationwide?(stateNames[uf]||String(filters.state||filters.states?.[0]||'').trim()):'';
  let anySuccess=false,lastBlockedStatus=0;

  const queryTerms=[...new Set(terms)].slice(0,60);let cursor=0;
  async function worker(){
    while(cursor<queryTerms.length&&jobs.size<max&&Date.now()<deadline){
      const term=queryTerms[cursor++],termSlug=normSlug(term),pathname=`/vagas-de-${termSlug}`;
      for(let page=1;page<=20&&jobs.size<max&&Date.now()<deadline;page++){
        const qs=new URLSearchParams({ordenar_por:'mais_recentes'});
        if(stateValue)qs.append('e[]',stateValue);
        if(page>1)qs.set('pagina',String(page));
        const {response,host,status}=await fetchSearch(pathname,qs);
        if(!response){lastBlockedStatus=status||lastBlockedStatus;break;}
        if(!response.ok)break;
        anySuccess=true;
        const rows=parsePage(await response.text(),host);
        if(!rows.length)break;
        let dated=0,old=0,added=0;
        for(const job of rows){
          const ms=dateMs(job.publishedAt);
          if(!ms)continue;
          dated++;
          if(ms<cutoff){old++;continue;}
          if(!jobs.has(job.url))added++;
          jobs.set(job.url,{...(jobs.get(job.url)||{}),...job,broadCollection:false});
        }
        if(jobs.size)saveFallback([...jobs.values()].slice(0,max));
        if((dated&&old===dated)||added===0)break;
        await new Promise(r=>setTimeout(r,180));
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,queryTerms.length||1)},()=>worker()));

  const result=[...jobs.values()].slice(0,max);
  if(result.length){
    lastGood=result;
    saveFallback(result);
    writeState({blockedUntil:0,lastSuccessAt:new Date().toISOString(),host:'alternate'});
    console.log(`[Vagas.com] ${result.length} vagas recentes via hosts alternativos oficiais`);
    return result;
  }

  let fallback=lastGood.length?lastGood.slice(0,max):readFallback(filters.recencyDays,max);
  if(!fallback.length) fallback=await indexedFallback(terms,filters,max);
  if(!fallback.length) fallback=await searchIndexedVagas(terms,filters,max);
  if(!anySuccess&&lastBlockedStatus)writeState({blockedUntil:Date.now()+15*60*1000,last429At:new Date().toISOString(),lastStatus:lastBlockedStatus});
  console.log(`[Vagas.com] sem coleta nova; usando ${fallback.length} vagas de fallback`);
  return fallback;
}
