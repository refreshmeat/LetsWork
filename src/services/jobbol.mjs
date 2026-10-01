import { createHash } from 'node:crypto';
import { db } from '../db.mjs';

const BASE='https://candidatos.jobbol.com.br';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156 Safari/537.36';
const DAYS=30;
const CITY='Rio de Janeiro';
const STATE='RJ';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function fixText(value){
  const raw=String(value||'');
  if(!/\u00c3|\u00c2/.test(raw))return raw;
  try{
    const bytes=Uint8Array.from([...raw].map(ch=>ch.codePointAt(0)&255));
    const fixed=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
    const bad=x=>(String(x).match(/\uFFFD/g)||[]).length;
    return bad(fixed)<=bad(raw)?fixed:raw;
  }catch{return raw;}
}
function cleanMeta(value){
  let raw=fixText(value).trim();
  raw=raw.replace(/^\S+\s+(?=(?:Presencial|Remoto|Hibrid|Efetivo|Est|Tempor|PJ|Freelance|Aprendiz|R\$|A combinar|\d|Ensino|Sem|Com))/i,'');
  return raw.trim();
}

function cutoffIso(days=DAYS){
  const safe=Math.max(1,Math.min(DAYS,Number(days)||DAYS));
  return new Date(Date.now()-safe*86400000).toISOString();
}
function state(){
  return db.prepare("SELECT source,last_sync_at,last_full_sync_at,coverage_days,last_count FROM source_sync_state WHERE source='Jobbol'").get()||{};
}
function age(){
  const ms=Date.parse(String(state().last_sync_at||''));
  return Number.isFinite(ms)?Date.now()-ms:Infinity;
}
function fullDue(maxAgeMs=24*60*60*1000){
  const ms=Date.parse(String(state().last_full_sync_at||''));
  return !Number.isFinite(ms)||Date.now()-ms>=maxAgeMs;
}
async function getJson(url,{attempts=3,timeout=10000}={}){
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':UA,'accept':'application/json,text/plain,*/*','referer':BASE+'/pesquisa-vagas','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(timeout)});
      const text=await r.text();
      if(!r.ok)throw new Error('HTTP '+r.status);
      return JSON.parse(text);
    }catch(e){last=e;if(i<attempts-1)await delay(300*(i+1));}
  }
  throw last||new Error('Jobbol request failed');
}
async function listAll({city=CITY,stateCode=STATE}={}){
  const rows=[];
  let offset=0,total=Infinity;
  while(offset<total){
    const qs=new URLSearchParams({cargo:'',cidade:city,estado:stateCode,modalidade:'',filtro_pcd:'',offset:String(offset),limit:'50'});
    const data=await getJson(BASE+'/assets/php/buscar-vagas-redis.php?'+qs);
    total=Math.max(0,Number(data?.total||0));
    const page=Array.isArray(data?.vagas)?data.vagas:[];
    rows.push(...page);
    if(!page.length)break;
    offset+=page.length;
    if(offset>12000)break;
  }
  return rows;
}
async function preview(jobkey){
  return getJson(BASE+'/assets/php/api/preview-vaga.php?jobkey='+encodeURIComponent(jobkey),{timeout:8000});
}
async function pool(items,limit,fn){
  let cursor=0;
  const out=new Array(items.length);
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length)return;
      try{out[i]=await fn(items[i]);}catch(e){out[i]={error:String(e?.message||e),item:items[i]};}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},()=>worker()));
  return out;
}
function asciiNorm(value){return fixText(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function metaValue(meta=[],rx){
  const raw=(meta||[]).map(cleanMeta).find(x=>rx.test(asciiNorm(x)));
  return raw||'';
}
function normalizeRow(row,detail){
  const epoch=Number(row?.post_date_epoch||0);
  const publishedAt=epoch?new Date(epoch*1000).toISOString():'';
  const meta=Array.isArray(detail?.meta)?detail.meta.map(cleanMeta):[];
  const contract=metaValue(meta,/(?:efetivo|estagio|temporario|pj|freelance|aprendiz|nao clt)/i);
  const salary=metaValue(meta,/(?:r\$|a combinar|\d[\d.,]*,\d{2})/i);
  const experience=metaValue(meta,/(?:experiencia|sem experiencia)/i);
  const description=[fixText(detail?.resumo||''),experience,meta.join(' | ')].filter(Boolean).join('\n').trim();
  const title=fixText(detail?.cargo||row?.CARGO||'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
  return {
    source:'Jobbol',
    externalId:String(row?.jobkey||detail?.jobkey||''),
    url:BASE+'/vaga/'+String(row?.jobkey||detail?.jobkey||''),
    title,
    company:fixText(detail?.empresa||row?.EMPRESA||'').trim(),
    salary,
    location:fixText(detail?.local||[row?.CIDADE,row?.ESTADO].filter(Boolean).join(', ')).trim(),
    description,
    contractType:contract,
    publishedAt,
    loginFreeCandidate:true,
    broadCollection:true,
    pcd:Boolean(row?.pcd),
    remote:/remot/i.test(asciiNorm(row?.TIPO||''))
  };
}
function save(rows,{fullSnapshot=false}={}){
  if(!rows.length)return;
  const upsert=db.prepare(`INSERT INTO job_inventory
    (source,external_id,url,canonical_url,title,company,salary,location,description,contract_type,published_at,content_hash,active,apply_mode,last_seen_at)
    VALUES('Jobbol',?,?,?,?,?,?,?,?,?,?,?,1,'SEARCH_ONLY',CURRENT_TIMESTAMP)
    ON CONFLICT DO UPDATE SET
      external_id=excluded.external_id,url=excluded.url,canonical_url=excluded.canonical_url,
      title=excluded.title,company=excluded.company,salary=excluded.salary,location=excluded.location,
      description=excluded.description,contract_type=excluded.contract_type,published_at=excluded.published_at,
      content_hash=excluded.content_hash,active=1,apply_mode='DIRECT_HTTP',last_seen_at=CURRENT_TIMESTAMP`);
  db.exec('BEGIN');
  try{
    if(fullSnapshot)db.prepare("UPDATE job_inventory SET active=0 WHERE source='Jobbol'").run();
    for(const j of rows){
      const hash=createHash('sha1').update([j.title,j.company,j.location,j.description,j.publishedAt].join('\n')).digest('hex');
      upsert.run(j.externalId,j.url,j.url,j.title,j.company,j.salary,j.location,j.description,j.contractType,j.publishedAt,hash);
    }
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}
function saveState({full,count}){
  const old=state(),now=new Date().toISOString();
  db.prepare(`INSERT INTO source_sync_state(source,last_sync_at,last_full_sync_at,coverage_days,last_count)
    VALUES('Jobbol',?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET last_sync_at=excluded.last_sync_at,last_full_sync_at=excluded.last_full_sync_at,
      coverage_days=excluded.coverage_days,last_count=excluded.last_count`)
    .run(now,full?now:String(old.last_full_sync_at||''),full?DAYS:Number(old.coverage_days||0),Number(count)||0);
}
export function getJobbolInventoryStatus(){
  db.prepare("UPDATE job_inventory SET active=0 WHERE source='Jobbol' AND active=1 AND datetime(published_at)<datetime(?)").run(cutoffIso());
  const counts=db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN active=0 THEN 1 ELSE 0 END) inactive,MIN(CASE WHEN active=1 THEN published_at END) oldest,
    MAX(CASE WHEN active=1 THEN published_at END) newest FROM job_inventory WHERE source='Jobbol'`).get()||{};
  return {...state(),...counts,fullSyncDue:fullDue()};
}
let syncPromise=null;
export async function syncJobbolInventory({full=false,force=false}={}){
  if(syncPromise)return syncPromise;
  if(!force){
    if(full&&!fullDue())return {...getJobbolInventoryStatus(),skipped:true,reason:'FULL_SYNC_FRESH'};
    if(!full&&age()<30*60*1000)return {...getJobbolInventoryStatus(),skipped:true,reason:'INCREMENTAL_SYNC_FRESH'};
  }
  syncPromise=(async()=>{
    const listed=await listAll();
    const cutoff=Date.now()-DAYS*86400000;
    const direct=[...new Map(listed.filter(x=>String(x?.STATUS_ORIGINAL||'')==='1')
      .filter(x=>Number(x?.post_date_epoch||0)*1000>=cutoff)
      .map(x=>[String(x.jobkey),x])).values()];
    const details=await pool(direct,12,async row=>({row,detail:await preview(row.jobkey)}));
    const ok=details.filter(x=>x&&!x.error&&x.detail?.jobkey).map(x=>normalizeRow(x.row,x.detail));
    const failures=details.filter(x=>x?.error);
    const authoritative=full&&failures.length===0;
    if(ok.length)save(ok,{fullSnapshot:authoritative});
    db.prepare("UPDATE job_inventory SET active=0 WHERE source='Jobbol' AND active=1 AND datetime(published_at)<datetime(?)").run(cutoffIso());
    saveState({full:authoritative,count:ok.length});
    return {...getJobbolInventoryStatus(),fetched:ok.length,listed:listed.length,direct:direct.length,errors:failures.length,fullSnapshot:authoritative,skipped:false};
  })();
  try{return await syncPromise;}finally{syncPromise=null;}
}
export async function maintainJobbolInventory(){
  return syncJobbolInventory({full:fullDue(),force:true});
}
