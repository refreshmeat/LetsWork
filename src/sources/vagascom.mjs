import fs from 'fs';
import path from 'path';
import { storage } from '../storage.mjs';

const normSlug=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const strip=s=>clean(decode(String(s||'').replace(/<[^>]+>/g,' ')));
const dateMs=s=>{const t=clean(s).toLowerCase();let d=new Date();d.setHours(12,0,0,0);if(t==='hoje')return d.getTime();if(t==='ontem'){d.setDate(d.getDate()-1);return d.getTime();}const rel=t.match(/h[aá]\s*(\d+)\s*dias?/);if(rel){d.setDate(d.getDate()-Number(rel[1]));return d.getTime();}const m=t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return Date.UTC(+m[3],+m[2]-1,+m[1],12);const parsed=Date.parse(t);return Number.isNaN(parsed)?0:parsed;};
const normalizedDate=s=>{const ms=dateMs(s);return ms?new Date(ms).toISOString().slice(0,10):'';}
let lastGood=[];
const stateFile=path.join(storage.data,'source-cache','vagascom_state.json');
const fallbackFile=path.join(storage.data,'source-cache','vagascom_last_good.json');
function readState(){try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return {};}}
function writeState(value){try{fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,JSON.stringify(value),'utf8');}catch{}}
function readFallback(days=15,max=2000){try{const cutoff=Date.now()-Math.max(1,Math.min(60,Number(days)||15))*86400000;return JSON.parse(fs.readFileSync(fallbackFile,'utf8')).filter(j=>{const ms=dateMs(j.publishedAt);return ms&&ms>=cutoff&&ms<=Date.now()+86400000;}).slice(0,max);}catch{return [];}}
function saveFallback(rows){if(!rows?.length)return;try{fs.mkdirSync(path.dirname(fallbackFile),{recursive:true});fs.writeFileSync(fallbackFile,JSON.stringify(rows),'utf8');}catch{}}
function parsePage(html){
  return String(html||'').split(/<li class="vaga[^>]*>/i).slice(1).map(raw=>raw.split(/<\/li>/i)[0]).map(block=>{
    const href=decode(block.match(/<a[^>]*class="[^"]*link-detalhes-vaga[^"]*"[^>]*href="([^"]+)"/i)?.[1]||'');
    const title=decode(block.match(/<a[^>]*class="[^"]*link-detalhes-vaga[^"]*"[^>]*title="([^"]+)"/i)?.[1]||'');
    const company=strip(block.match(/<span[^>]*class="emprVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const level=strip(block.match(/<span[^>]*class="nivelVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const location=strip(block.match(/<div[^>]*class="vaga-local"[^>]*>([\s\S]*?)(?:<div[^>]*class="tooltip-place"|<\/div>)/i)?.[1]);
    const publishedRaw=strip(block.match(/<span[^>]*class="[^"]*data-publicacao[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const publishedAt=normalizedDate(publishedRaw);
    const description=strip(block.match(/<div[^>]*class="detalhes"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const url=href?(href.startsWith('http')?href:`https://www.vagas.com.br${href}`):'';
    return url&&title?{source:'Vagas.com',title,company,location,url,publishedAt,salary:'',description,contractType:/est[aá]gio/i.test(level)?'Estágio':'',remote:/home office|remoto/i.test(`${title} ${description} ${location}`),pcd:/exclusiva.*pcd|\bpcd\b|pessoa.{0,30}defici/i.test(title),pcdExclusive:/exclusiva.*pcd|\bpcd\b|pessoa.{0,30}defici/i.test(title),loginFreeCandidate:false}:null;
  }).filter(Boolean);
}
export async function searchVagasCom(terms,filters,max=400){
  const state=readState();
  if(Number(state.blockedUntil||0)>Date.now()){
    const fallback=readFallback(filters.recencyDays,max);
    console.log(`[Vagas.com] cooldown ativo após HTTP 429; usando ${fallback.length} vagas recentes já coletadas`);
    return fallback;
  }
  const jobs=new Map(),deadline=Date.now()+28000,cutoff=Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000;
  const citySlug=!filters.nationwide&&filters.city?normSlug(filters.city):'';
  for(const term of terms.slice(0,12)){
    if(jobs.size>=max||Date.now()>=deadline)break;
    const slug=normSlug(term),bases=[];
    if(citySlug)bases.push(`https://www.vagas.com.br/vagas-de-${slug}-em-${citySlug}`);
    bases.push(`https://www.vagas.com.br/vagas-de-${slug}`);
    for(const base of bases){
      const maxPages=citySlug&&base.includes(`-em-${citySlug}`)?2:1;
      for(let page=1;page<=maxPages&&jobs.size<max&&Date.now()<deadline;page++){
        const qs=new URLSearchParams({ordenar_por:'mais_recentes'});if(page>1)qs.set('pagina',String(page));
        try{
          const r=await fetch(`${base}?${qs}`,{headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(6500)});
          if(r.status===429){
            writeState({blockedUntil:Date.now()+15*60*1000,last429At:new Date().toISOString()});
            const fallback=jobs.size?[...jobs.values()]:(lastGood.length?lastGood:readFallback(filters.recencyDays,max));
            if(fallback.length)saveFallback(fallback);
            console.log(`[Vagas.com] HTTP 429; cooldown de 15 min e preservação de ${fallback.length} vagas já conhecidas`);
            return fallback.slice(0,max);
          }
          if(!r.ok)break;
          if(state.blockedUntil) writeState({blockedUntil:0,lastSuccessAt:new Date().toISOString()});
          const rows=parsePage(await r.text());if(!rows.length)break;let dated=0,old=0;
          for(const job of rows){const ms=dateMs(job.publishedAt);if(ms){dated++;if(ms<cutoff){old++;continue;}}else continue;
            const prev=jobs.get(job.url);if(!prev||(!prev.location&&job.location)||(!prev.description&&job.description))jobs.set(job.url,{...prev,...job});
          }
          if(dated&&old===dated)break;
          await new Promise(r=>setTimeout(r,420));
        }catch{break;}
      }
    }
  }
  const result=[...jobs.values()].slice(0,max);
  if(result.length){lastGood=result;saveFallback(result);}
  return result;
}
