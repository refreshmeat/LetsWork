import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { db, json, parseJson, candidateSummary } from './db.mjs';
import { extractText, inferProfile, extractPreferredResumeFromZip } from './services/resume.mjs';
import { searchJobs, buildSearchTerms } from './services/jobs.mjs';
import { rankJobs } from './services/ranking.mjs';
import { classifyJobsForQueue } from './services/sendability.mjs';
import { tailorResume, tailorResumesBatch } from './services/tailor.mjs';
import { applyToJob, closeLoginSession, createJobContextCollector, createApplicationBrowser } from './apply/engine.mjs';
import { runtime } from './runtime.mjs';
import { storage, ensureCandidateDirs, candidateDir } from './storage.mjs';
import { registerMultiFileRoute } from './multifile.mjs';
import { aiStatus } from './services/ai.mjs';
import { cleanUploadFilename, safeFilename } from './utils/filename.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PORT = Number(process.env.PORT || 4317);
const uploadDir = runtime.uploads;
const reportDir = runtime.reports;
const generatedDir = runtime.generated;
const upload = multer({ dest:uploadDir, limits:{fileSize:80*1024*1024} });
const docKind=(name,isPrimary=false)=>{
  if(isPrimary) return 'resume';
  const n=String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/portfolio|book|portifolio/.test(n)) return 'portfolio';
  if(/certif|diploma|curso|comprov/.test(n)) return 'certificate';
  return 'support';
};

const app = express();
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(ROOT,'public')));
registerMultiFileRoute(app,upload);

const getResume = id => db.prepare('SELECT * FROM resumes WHERE id=?').get(id);
const getRun = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const getJobs = id => db.prepare('SELECT * FROM jobs WHERE run_id=? AND selected=1 AND sendable=1 ORDER BY score DESC').all(id);
const getAllJobs = id => db.prepare('SELECT * FROM jobs WHERE run_id=? ORDER BY score DESC').all(id);
const getCandidate=id=>db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
const latestRun=id=>db.prepare("SELECT * FROM runs WHERE candidate_id=? AND status<>'PREVIEW' ORDER BY id DESC LIMIT 1").get(id);
function normalizeStoredFilenames(){
  for(const table of ['resumes','documents']){
    for(const row of db.prepare(`SELECT id,original_name FROM ${table}`).all()){
      const fixed=cleanUploadFilename(row.original_name);
      if(fixed!==row.original_name) db.prepare(`UPDATE ${table} SET original_name=? WHERE id=?`).run(fixed,row.id);
    }
  }
}
normalizeStoredFilenames();

function rebuildResumeFromDocuments(candidateId){
  const docs=db.prepare('SELECT * FROM documents WHERE candidate_id=? ORDER BY is_primary DESC,id').all(candidateId);
  const latest=db.prepare('SELECT * FROM resumes WHERE candidate_id=? ORDER BY id DESC LIMIT 1').get(candidateId);
  if(!docs.length){db.prepare('DELETE FROM resumes WHERE candidate_id=?').run(candidateId);return null;}
  let primary=docs.find(x=>x.is_primary)||docs[0];
  if(!primary.is_primary){
    db.prepare('UPDATE documents SET is_primary=0 WHERE candidate_id=?').run(candidateId);
    db.prepare("UPDATE documents SET is_primary=1,kind='resume' WHERE id=?").run(primary.id);
    primary={...primary,is_primary:1,kind:'resume'};
  }
  const others=docs.filter(x=>x.id!==primary.id);
  const combined=[primary.extracted_text||'',...others.map(x=>`

=== DOCUMENTO DE APOIO: ${x.original_name} ===
${x.extracted_text||''}`)].join('');
  const inferred=inferProfile(combined),old=parseJson(latest?.profile_json,{}),sticky={};
  for(const k of ['name','email','phone','linkedin','portfolio','instagram','pcd','cpf','birthDate','cep','address','neighborhood','additionalFacts']) if(old[k]!==undefined&&old[k]!==null&&old[k]!=='') sticky[k]=old[k];
  const profile={...inferred,...sticky,candidateId,rawText:combined};
  if(latest) db.prepare('UPDATE resumes SET original_name=?,stored_path=?,extracted_text=?,profile_json=? WHERE id=?').run(primary.original_name,primary.stored_path,combined,json(profile),latest.id);
  else db.prepare('INSERT INTO resumes(candidate_id,original_name,stored_path,extracted_text,profile_json) VALUES(?,?,?,?,?)').run(candidateId,primary.original_name,primary.stored_path,combined,json(profile));
  return profile;
}
const normJobKey=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function canonicalUrl(value){
  try{const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_|^(ref|source|src|fbclid|gclid)$/i.test(k))u.searchParams.delete(k);return u.toString().replace(/\/$/,'');}
  catch{return String(value||'').trim().replace(/\/$/,'');}
}
function jobFingerprint(job){
  const d=publicationDate(job.publishedAt||job.published_at);
  const day=d?d.toISOString().slice(0,10):'';
  const semantic=[normJobKey(job.title),normJobKey(job.company),normJobKey(job.location),day].filter(Boolean).join('|');
  const base=semantic.length>12?semantic:canonicalUrl(job.url);
  return createHash('sha256').update(base||String(job.url||job.title||'')).digest('hex').slice(0,40);
}
function publicationDate(value){
  const s=String(value||'').trim(); if(!s)return null;
  const dmy=s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if(dmy){const d=new Date(Date.UTC(Number(dmy[3]),Number(dmy[2])-1,Number(dmy[1]),12));return Number.isNaN(d.getTime())?null:d;}
  const d=new Date(s);return Number.isNaN(d.getTime())?null:d;
}
function recentJobs(rows,days=15){
  const cutoff=Date.now()-Math.max(1,Math.min(60,Number(days)||15))*86400000;
  return rows.filter(j=>{if(j.indexedRecent===true)return true;const d=publicationDate(j.publishedAt||j.published_at);return d&&d.getTime()>=cutoff&&d.getTime()<=Date.now()+86400000;});
}
const normSearch=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const rxEscape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function hasSearchTerm(text,term){
  const t=normSearch(term); if(t.length<3)return false;
  const pattern=rxEscape(t).replace(/\\ /g,'\\s+');
  return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`,'i').test(normSearch(text));
}
function addSearchEvidence(job,terms){
  const title=normSearch(job.title),body=normSearch(`${job.title||''} ${job.description||''} ${job.company||''}`);
  const clean=[...new Set((terms||[]).map(normSearch).filter(x=>x.length>=3))];
  const titleHits=clean.filter(t=>hasSearchTerm(title,t));
  const bodyHits=clean.filter(t=>hasSearchTerm(body,t));
  return {...job,searchTitleHits:titleHits.length,searchBodyHits:bodyHits.length,searchTitleTerms:titleHits.slice(0,10),searchMatchedTerms:bodyHits.slice(0,10)};
}
// Login é classificado por vaga. Fontes inteiras nunca são bloqueadas por conveniência.

app.get('/api/ai/status',async(req,res)=>res.json(await aiStatus()));
app.get('/api/candidates',(req,res)=>{
  const rows=candidateSummary().map(c=>{const r=latestRun(c.id);return {...c,latestRunId:r?.id||null};});
  res.json(rows);
});
app.get('/api/candidate/:id',(req,res)=>{
  const id=Number(req.params.id),candidate=getCandidate(id);
  if(!candidate) return res.status(404).json({error:'Candidato não encontrado'});
  const resume=db.prepare('SELECT * FROM resumes WHERE candidate_id=? ORDER BY id DESC LIMIT 1').get(id);
  const documents=db.prepare('SELECT id,kind,original_name,is_primary,created_at FROM documents WHERE candidate_id=? ORDER BY is_primary DESC,id').all(id);
  const runs=db.prepare('SELECT id,created_at,status FROM runs WHERE candidate_id=? ORDER BY id DESC').all(id);
  res.json({candidate,resume:resume?{...resume,extracted_text:undefined,profile:parseJson(resume.profile_json,{})}:null,documents,runs});
});

app.post('/api/resume/upload', upload.single('resume'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({error:'Arquivo não recebido'});
    req.file.originalname=cleanUploadFilename(req.file.originalname);
    const ext=path.extname(req.file.originalname||'');
    const staged=`${req.file.path}${ext}`; fs.renameSync(req.file.path,staged);
    const text=await extractText(staged); const profile=inferProfile(text);
    const cname=profile.name||path.basename(req.file.originalname,ext)||'Novo candidato';
    const ci=db.prepare('INSERT INTO candidates(name) VALUES(?)').run(cname);
    const candidateId=Number(ci.lastInsertRowid), dirs=ensureCandidateDirs(candidateId);
    const original=path.join(dirs.resumes,`original_${safeFilename(req.file.originalname)}`); fs.copyFileSync(staged,original);
    let sourcePath=original;
    if(ext.toLowerCase()==='.zip'){
      const extracted=extractPreferredResumeFromZip(staged,dirs.resumes);
      if(extracted) sourcePath=extracted; else {sourcePath=path.join(dirs.resumes,'curriculo_extraido.txt');fs.writeFileSync(sourcePath,text,'utf8');}
    }
    fs.rmSync(staged,{force:true});
    const full={...profile,candidateId};
    const info=db.prepare('INSERT INTO resumes(candidate_id,original_name,stored_path,extracted_text,profile_json) VALUES(?,?,?,?,?)')
      .run(candidateId,req.file.originalname,sourcePath,text,json(full));
    res.json({candidateId,resumeId:Number(info.lastInsertRowid),profile:{...full,rawText:undefined},chars:text.length});
  } catch(e) { res.status(500).json({error:String(e.message||e)}); }
});

app.delete('/api/candidate/:candidateId/document/:docId',(req,res)=>{
  const candidateId=Number(req.params.candidateId),docId=Number(req.params.docId);
  const doc=db.prepare('SELECT * FROM documents WHERE id=? AND candidate_id=?').get(docId,candidateId);
  if(!doc) return res.status(404).json({error:'Arquivo não encontrado'});
  const latest=db.prepare('SELECT * FROM resumes WHERE candidate_id=? ORDER BY id DESC LIMIT 1').get(candidateId);
  try{
    if(doc.stored_path) fs.rmSync(doc.stored_path,{force:true});
    if(doc.is_primary&&latest?.stored_path&&latest.stored_path!==doc.stored_path) fs.rmSync(latest.stored_path,{force:true});
    db.prepare('DELETE FROM documents WHERE id=?').run(docId);
    const profile=rebuildResumeFromDocuments(candidateId);
    db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(candidateId);
    res.json({ok:true,remaining:db.prepare('SELECT COUNT(*) count FROM documents WHERE candidate_id=?').get(candidateId).count,profile:profile?{...profile,rawText:undefined}:null});
  }catch(e){res.status(500).json({error:String(e.message||e)});}
});

app.patch('/api/resume/:id/profile',(req,res) => {
  const id = Number(req.params.id); const row = getResume(id);
  if (!row) return res.status(404).json({error:'Currículo não encontrado'});
  const profile = {...parseJson(row.profile_json,{}),...(req.body||{})};
  db.prepare('UPDATE resumes SET profile_json=? WHERE id=?').run(json(profile),id);
  if(row.candidate_id) db.prepare('UPDATE candidates SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(profile.name||'Sem nome',row.candidate_id);
  res.json({ok:true,candidateId:row.candidate_id,profile:{...profile,rawText:undefined}});
});
app.post('/api/search', async (req,res) => {
  try {
    const {resumeId,filters={},preview=false} = req.body || {};
    const resume = getResume(Number(resumeId));
    if (!resume) return res.status(400).json({error:'Currículo não encontrado'});
    const profile = {...parseJson(resume.profile_json,{}),candidateId:resume.candidate_id};
    const effectiveFilters={...filters,recencyDays:Math.max(1,Math.min(60,Number(filters.recencyDays||15)))};
    const searchTerms=await buildSearchTerms(profile,effectiveFilters);
    effectiveFilters.searchExclusions=Array.isArray(searchTerms.exclusions)?searchTerms.exclusions:[];
    const raw = await searchJobs(profile,effectiveFilters,searchTerms);
    const recent=recentJobs(raw,effectiveFilters.recencyDays).map(j=>addSearchEvidence(j,searchTerms));
    const poolUpsert=db.prepare(`INSERT INTO candidate_job_pool
      (candidate_id,fingerprint,source,url,title,company,location,salary,description,contract_type,published_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(candidate_id,fingerprint) DO UPDATE SET source=excluded.source,url=excluded.url,title=excluded.title,
      company=excluded.company,location=excluded.location,salary=excluded.salary,description=excluded.description,
      contract_type=excluded.contract_type,published_at=excluded.published_at,last_seen_at=CURRENT_TIMESTAMP`);
    for(const j of recent) poolUpsert.run(resume.candidate_id,jobFingerprint(j),j.source||'',j.url||'',j.title||'',j.company||'',j.location||'',j.salary||'',j.description||'',j.contractType||'',j.publishedAt||'');
    const cutoffIso=new Date(Date.now()-effectiveFilters.recencyDays*86400000).toISOString().slice(0,10);
    const poolRows=db.prepare('SELECT * FROM candidate_job_pool WHERE candidate_id=? AND published_at>=?').all(resume.candidate_id,cutoffIso);
    const poolMap=new Map(poolRows.map(x=>[x.fingerprint,x]));
    const storedPool=poolRows.map(x=>({source:x.source,title:x.title,company:x.company,location:x.location,salary:x.salary,url:x.url,description:x.description,contractType:x.contract_type,publishedAt:x.published_at,loginFreeCandidate:x.sendable===1||x.source==='RioVagas',requiresLogin:['LOGIN_REQUIRED','EMAIL_REQUIRED'].includes(x.blocked_reason),broadCollection:/^(RioVagas|EmpregosRJ)$/i.test(x.source||'')}));
    const candidatePool=[...new Map([...storedPool,...recent].map(j=>[jobFingerprint(j),addSearchEvidence(j,searchTerms)])).values()];
    for(const j of candidatePool){const cached=poolMap.get(jobFingerprint(j));if(cached?.sendable===1)j.loginFreeCandidate=true;if(['LOGIN_REQUIRED','EMAIL_REQUIRED'].includes(cached?.blocked_reason))j.requiresLogin=true;}
    const historyRows=db.prepare("SELECT fingerprint FROM candidate_job_history WHERE candidate_id=? AND status IN ('SENT','ALREADY_APPLIED')").all(resume.candidate_id);
    const seen=new Set(historyRows.map(x=>x.fingerprint));
    const unseen=candidatePool.filter(j=>!seen.has(jobFingerprint(j)));
    const ranked = rankJobs(unseen,profile,effectiveFilters);
    const batchSize=Math.min(500,Math.max(100,Number(effectiveFilters.limit||500)));
    const prepared=await classifyJobsForQueue(ranked,{batchSize,probeLimit:Math.min(160,batchSize)});
    for(const j of prepared)if(j.reason==='UNVERIFIED_LOGIN'){j.sendable=1;j.reason='ACCESS_TO_VERIFY';j.verified=false;}
    const poolClassified=db.prepare("UPDATE candidate_job_pool SET score=?,sendable=?,blocked_reason=?,last_seen_at=CURRENT_TIMESTAMP WHERE candidate_id=? AND fingerprint=?");
    for(const j of prepared) poolClassified.run(j.score||0,j.reason==='ACCESS_TO_VERIFY'?0:(j.sendable?1:0),j.reason||'',resume.candidate_id,jobFingerprint(j));
    prepared.forEach((j,index)=>{j._rank=index+1;});
    let sendableIndex=0;
    for(const j of prepared) if(j.sendable){sendableIndex++;j._batch=Math.floor((sendableIndex-1)/batchSize)+1;j._selected=j._batch===1?1:0;} else {j._batch=0;j._selected=0;}
    const selected=prepared.filter(j=>j._selected===1);
    const sendable=prepared.filter(j=>j.sendable===1);
    const blocked=prepared.filter(j=>j.reason==='LOGIN_REQUIRED'||j.reason==='EMAIL_REQUIRED');
    const blockedEmail=prepared.filter(j=>j.reason==='EMAIL_REQUIRED');
    const unverified=prepared.filter(j=>j.sendable===0&&!blocked.includes(j));
    const info = db.prepare('INSERT INTO runs(candidate_id,filters_json,resume_id,status,active_batch) VALUES(?,?,?,?,1)')
      .run(resume.candidate_id,json(effectiveFilters),resume.id,preview?'PREVIEW':'SEARCHED');
    if(!preview) db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(resume.candidate_id);
    const runId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO jobs
      (run_id,source,source_key,title,company,salary,location,url,description,score,pcd,remote,contract_type,published_at,sendable,blocked_reason,selected,batch_no,rank_position)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const hist=db.prepare(`INSERT INTO candidate_job_history
      (candidate_id,fingerprint,source,url,title,company,location,published_at,status,last_run_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_id,fingerprint) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP,last_run_id=excluded.last_run_id,status=excluded.status`);
    for (const j of prepared){
      const fp=jobFingerprint(j);
      const histStatus=j.sendable?(j._selected?'SELECTED':'RESERVE'):((j.reason==='LOGIN_REQUIRED'||j.reason==='EMAIL_REQUIRED')?'BLOCKED_LOGIN':'UNVERIFIED_LOGIN');
      ins.run(runId,j.source,fp,j.title,j.company||'',j.salary||'',j.location||'',j.url,j.description||'',j.score||0,j.pcd?1:0,j.remote?1:0,j.contractType|| (j.pj?'PJ':j.clt?'CLT':''),j.publishedAt||'',j.sendable,j.reason||'',j._selected,j._batch,j._rank);
      if(j._selected&&!preview) hist.run(resume.candidate_id,fp,j.source||'',j.url||'',j.title||'',j.company||'',j.location||'',j.publishedAt||'',histStatus,runId);
    }
    const countBySource=rows=>Object.fromEntries(Object.entries(rows.reduce((acc,j)=>{const k=j.source||'Outra';acc[k]=(acc[k]||0)+1;return acc;},{})).sort((a,b)=>b[1]-a[1]));
    res.json({runId,preview:Boolean(preview),found:raw.length,recent:recent.length,staleSkipped:raw.length-recent.length,previouslySeenSkipped:Math.max(0,candidatePool.length-unseen.length),poolTotal:candidatePool.length,compatible:selected.length,compatibleTotal:prepared.length,sendableTotal:sendable.length,reserve:Math.max(0,sendable.length-selected.length),blockedLogin:blocked.length,blockedEmail:blockedEmail.length,unverifiedLogin:unverified.length,batches:Math.max(1,Math.ceil(sendable.length/batchSize)),sourceCounts:countBySource(candidatePool),freshSourceCounts:countBySource(raw),compatibleSourceCounts:countBySource(selected),sendableSourceCounts:countBySource(sendable),blockedSourceCounts:countBySource(blocked),unverifiedSourceCounts:countBySource(unverified),jobs:selected});
  } catch(e) { res.status(500).json({error:String(e.message||e)}); }
});

app.get('/api/run/:id/jobs',(req,res)=>res.json(getJobs(Number(req.params.id))));
async function processRun(runId,onlyErrors=false) {
  const run=getRun(runId); if(!run) throw new Error('Execução não encontrada');
  const resume=getResume(run.resume_id);
  const supportDocuments=db.prepare('SELECT kind,original_name,stored_path FROM documents WHERE candidate_id=? AND is_primary=0').all(run.candidate_id);
  const profile={...parseJson(resume.profile_json,{}),candidateId:run.candidate_id,supportDocuments};
  const prefs={...parseJson(run.filters_json,{}),candidateId:run.candidate_id};
  const dryRun=!prefs.autoSubmit;
  let jobs=getJobs(runId);
  if(onlyErrors){
    const ids=new Set(db.prepare("SELECT job_id FROM applications WHERE run_id=? AND status IN ('ERROR','NEEDS_DATA','PREPARING','READY')").all(runId).map(x=>x.job_id));
    jobs=jobs.filter(x=>ids.has(x.id));
  }
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(onlyErrors?'RETRYING':'APPLYING',runId);

  const collector=createJobContextCollector(jobs,{concurrency:Math.max(4,Math.min(20,Number(process.env.PREFLIGHT_WORKERS||12)))});
  collector.done.catch(()=>{});
  const ready=[];
  const waiters=[];
  let producerDone=false;

  const wake=()=>{
    while(waiters.length && (ready.length || producerDone)) waiters.shift()();
  };
  const push=item=>{ready.push(item);wake();};
  const pop=async()=>{
    while(!ready.length){
      if(producerDone) return null;
      await new Promise(resolve=>waiters.push(resolve));
    }
    return ready.shift();
  };

  const saveApplication=(job,status,tailoredFile='',error='')=>{
    db.prepare(`INSERT INTO applications(run_id,job_id,status,tailored_file,error,submitted_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,job_id) DO UPDATE SET status=excluded.status,
      tailored_file=CASE WHEN excluded.tailored_file<>'' THEN excluded.tailored_file ELSE applications.tailored_file END,
      error=excluded.error,submitted_at=excluded.submitted_at`)
      .run(runId,job.id,status,tailoredFile,error||'',['SENT','ALREADY_APPLIED'].includes(status)?new Date().toISOString():null);
  };
  const updateHistory=(job,status)=>{
    if(job.source_key) db.prepare(`UPDATE candidate_job_history SET status=?,last_seen_at=CURRENT_TIMESTAMP,last_run_id=?
      WHERE candidate_id=? AND fingerprint=?`).run(status,runId,run.candidate_id,job.source_key);
  };

  async function producer(){
    const BATCH_SIZE=Math.max(2,Math.min(50,Number(process.env.AI_JOB_BATCH_SIZE||50)));
    let cursor=0;
    try{
      while(cursor<jobs.length){
        const batch=[];
        while(cursor<jobs.length&&batch.length<BATCH_SIZE){
          const job=jobs[cursor++];
          const old=db.prepare('SELECT * FROM applications WHERE run_id=? AND job_id=?').get(runId,job.id);
          if(['SENT','ALREADY_APPLIED'].includes(old?.status))continue;
          if(old?.tailored_file&&fs.existsSync(old.tailored_file)){push({job,file:old.tailored_file});continue;}
          saveApplication(job,'PREPARING','','');batch.push(job);
        }
        if(!batch.length)continue;
        const contexts=await Promise.all(batch.map(async job=>({job,ctx:await collector.get(job.id)})));
        const enriched=[];
        for(const {job,ctx} of contexts){
          if(ctx?.blocked){
            const status=/login necess[aá]rio/i.test(ctx.blocked)?'SKIPPED_LOGIN':'NEEDS_DATA';
            saveApplication(job,status,'',ctx.blocked);
            if(status==='SKIPPED_LOGIN')db.prepare("UPDATE jobs SET sendable=0,blocked_reason='LOGIN_REQUIRED',selected=0,batch_no=0 WHERE id=?").run(job.id);
            updateHistory(job,status);continue;
          }
          enriched.push({...job,url:ctx?.url||job.url,description:[job.description||'',ctx?.text||''].filter(Boolean).join('\n\n').slice(0,50000)});
        }
        if(!enriched.length)continue;
        try{
          const generated=await tailorResumesBatch(resume.stored_path,enriched,profile);
          const byId=new Map(generated.map(x=>[String(x.jobId),x]));
          for(const job of enriched){
            const tailored=byId.get(String(job.id));
            if(!tailored?.file)throw new Error('Lote de currículos retornou item incompleto');
            saveApplication(job,'READY',tailored.file,'');push({job,file:tailored.file});
          }
        }catch(batchError){
          for(const job of enriched){
            try{const tailored=await tailorResume(resume.stored_path,job,profile);saveApplication(job,'READY',tailored.file,'');push({job,file:tailored.file});}
            catch(e){const message=String(e?.message||batchError?.message||e).slice(0,500);saveApplication(job,'ERROR','',message);updateHistory(job,'ERROR');}
          }
        }
      }
    }finally{producerDone=true;wake();await collector.done.catch(()=>{});}
  }

  let applicationBrowser=null;
  async function applyWorker(){
    while(true){
      const item=await pop();
      if(!item) return;
      const {job,file}=item;
      const old=db.prepare('SELECT * FROM applications WHERE run_id=? AND job_id=?').get(runId,job.id);
      if(['SENT','ALREADY_APPLIED'].includes(old?.status)) continue;
      try{
        const result=await applyToJob(job,file,profile,prefs,{dryRun,browser:applicationBrowser});
        saveApplication(job,result.status,file,result.error||'');
        if(result.status==='SKIPPED_LOGIN') db.prepare("UPDATE jobs SET sendable=0,blocked_reason='LOGIN_REQUIRED',selected=0,batch_no=0 WHERE id=?").run(job.id);
        updateHistory(job,result.status);
      }catch(e){
        const message=String(e?.message||e).slice(0,500);
        saveApplication(job,'ERROR',file,message);
        updateHistory(job,'ERROR');
      }
    }
  }

  const workerCount=Math.max(2,Math.min(14,Number(process.env.APPLY_WORKERS||(dryRun?12:10))));
  applicationBrowser=await createApplicationBrowser();
  try{
    const workers=Array.from({length:workerCount},()=>applyWorker());
    await Promise.all([producer(),...workers]);
  }finally{
    if(applicationBrowser)await applicationBrowser.close().catch(()=>{});
  }
  if(!dryRun) await closeLoginSession();
  db.prepare('UPDATE runs SET status=? WHERE id=?').run('DONE',runId);
}

function startBackground(runId,onlyErrors){
  setImmediate(()=>processRun(runId,onlyErrors).catch(e=>{
    db.prepare('UPDATE runs SET status=? WHERE id=?').run(`ERROR: ${String(e.message||e).slice(0,120)}`,runId);
  }));
}

app.get('/api/execution',(req,res)=>res.json({path:runtime.session}));

app.post('/api/run/:id/apply',(req,res)=>{
  const id=Number(req.params.id),run=getRun(id); if(!run) return res.status(404).json({error:'Execução não encontrada'});
  const prefs=parseJson(run.filters_json,{});
  if(prefs.autoSubmit&&req.body?.confirmLive!==true) return res.status(409).json({error:'Confirmação explícita do modo real é obrigatória.'});
  startBackground(id,false); res.json({ok:true,runId:id});
});
app.post('/api/run/:id/retry',(req,res)=>{
  const id=Number(req.params.id); if(!getRun(id)) return res.status(404).json({error:'Execução não encontrada'});
  startBackground(id,true); res.json({ok:true,runId:id});
});
app.post('/api/run/:id/batch/:batch',(req,res)=>{
  const id=Number(req.params.id),batch=Number(req.params.batch),run=getRun(id);
  if(!run) return res.status(404).json({error:'Execução não encontrada'});
  if(['APPLYING','RETRYING'].includes(run.status)) return res.status(409).json({error:'Aguarde o processamento atual terminar antes de trocar o lote.'});
  const maxBatch=Number(db.prepare('SELECT COALESCE(MAX(batch_no),0) n FROM jobs WHERE run_id=? AND sendable=1').get(id).n||0);
  if(!Number.isInteger(batch)||batch<1||batch>maxBatch) return res.status(400).json({error:'Lote inválido'});
  db.prepare('UPDATE jobs SET selected=CASE WHEN sendable=1 AND batch_no=? THEN 1 ELSE 0 END WHERE run_id=?').run(batch,id);
  db.prepare("UPDATE runs SET active_batch=?,status='SEARCHED' WHERE id=?").run(batch,id);
  res.json({ok:true,runId:id,batch,total:getJobs(id).length});
});
app.get('/api/run/:id/status',(req,res)=>{
  const id=Number(req.params.id); const run=getRun(id);
  if(!run) return res.status(404).json({error:'Execução não encontrada'});
  const counts=db.prepare('SELECT status,COUNT(*) count FROM applications WHERE run_id=? GROUP BY status').all(id);
  const total=db.prepare('SELECT COUNT(*) count FROM jobs WHERE run_id=? AND selected=1 AND sendable=1').get(id).count;
  const pool=db.prepare(`SELECT COUNT(*) poolTotal,COALESCE(SUM(sendable),0) sendableTotal,
    COALESCE(SUM(CASE WHEN blocked_reason IN ('LOGIN_REQUIRED','EMAIL_REQUIRED') THEN 1 ELSE 0 END),0) blockedLogin,
    COALESCE(SUM(CASE WHEN blocked_reason='EMAIL_REQUIRED' THEN 1 ELSE 0 END),0) blockedEmail,
    COALESCE(SUM(CASE WHEN sendable=0 AND blocked_reason NOT IN ('LOGIN_REQUIRED','EMAIL_REQUIRED') THEN 1 ELSE 0 END),0) unverifiedLogin,
    COALESCE(SUM(CASE WHEN sendable=1 AND selected=0 THEN 1 ELSE 0 END),0) reserve,
    COALESCE(MAX(batch_no),0) batches FROM jobs WHERE run_id=?`).get(id);
  res.json({runId:id,status:run.status,total,activeBatch:run.active_batch||1,...pool,counts:Object.fromEntries(counts.map(x=>[x.status,x.count]))});
});

function reportRows(runId){
  return db.prepare(`SELECT COALESCE(a.status,CASE WHEN j.blocked_reason='LOGIN_REQUIRED' THEN 'BLOQUEADA LOGIN' WHEN j.blocked_reason='EMAIL_REQUIRED' THEN 'BLOQUEADA EMAIL' WHEN j.sendable=0 THEN 'RESERVA NÃO VERIFICADA' WHEN j.selected=1 THEN 'PENDING' ELSE 'RESERVA' END) status,j.title,j.location,j.salary,j.url,j.score FROM jobs j
    LEFT JOIN applications a ON a.job_id=j.id AND a.run_id=j.run_id WHERE j.run_id=? ORDER BY j.score DESC`).all(runId).map(x=>({
      Enviado:x.status==='SENT'?'SIM':x.status,
      'Nome da vaga':x.title,
      Local:x.location||'',
      'Remuneração':x.salary||'',
      Link:x.url
    }));
}

async function saveXlsx(runId){
  const run=getRun(runId); if(!run) throw new Error('Execução não encontrada');
  const rows=reportRows(runId),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Candidaturas');
  ws.columns=[{header:'Enviado',key:'Enviado',width:16},{header:'Nome da vaga',key:'Nome da vaga',width:48},{header:'Local',key:'Local',width:28},{header:'Remuneração',key:'Remuneração',width:22},{header:'Link',key:'Link',width:60}];
  rows.forEach(r=>ws.addRow(r)); ws.getRow(1).font={bold:true}; ws.views=[{state:'frozen',ySplit:1}];
  const dirs=ensureCandidateDirs(run.candidate_id);
  const file=path.join(dirs.reports,`candidaturas_${runId}.xlsx`); await wb.xlsx.writeFile(file); return file;
}
app.get('/api/run/:id/export.xlsx',async(req,res)=>{
  try{const file=await saveXlsx(Number(req.params.id));res.download(file);}catch(e){res.status(404).json({error:String(e.message||e)});}
});
app.get('/api/run/:id/export.csv',(req,res)=>{
  const rows=reportRows(Number(req.params.id));
  const cols=['Enviado','Nome da vaga','Local','Remuneração','Link'];
  const q=v=>'"'+String(v??'').replace(/"/g,'""').replace(/\r?\n/g,' ')+'"';
  const csv='\uFEFF'+[cols.join(','),...rows.map(r=>cols.map(c=>q(r[c])).join(','))].join('\n');
  res.type('text/csv').send(csv);
});

app.get('/api/candidate/:id/reports',(req,res)=>{
  const id=Number(req.params.id),c=getCandidate(id); if(!c) return res.status(404).json({error:'Candidato não encontrado'});
  const dirs=ensureCandidateDirs(id);
  const files=fs.readdirSync(dirs.reports).filter(x=>/\.xlsx$/i.test(x)).map(name=>{const file=path.join(dirs.reports,name),st=fs.statSync(file);return {name,modifiedAt:st.mtime.toISOString(),size:st.size};}).sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));
  res.json(files);
});
app.get('/api/candidate/:id/report/:name',(req,res)=>{
  const id=Number(req.params.id),name=path.basename(req.params.name);
  const dirs=ensureCandidateDirs(id),file=path.join(dirs.reports,name);
  if(!getCandidate(id)||!fs.existsSync(file)||!/\.xlsx$/i.test(name)) return res.status(404).json({error:'Relatório não encontrado'});
  res.download(file,name);
});
app.get('/api/candidate/:id/export-latest.xlsx',async(req,res)=>{
  try{const id=Number(req.params.id),r=latestRun(id);if(!r) return res.status(404).json({error:'Nenhuma execução encontrada'});res.download(await saveXlsx(r.id));}
  catch(e){res.status(500).json({error:String(e.message||e)});}
});
app.delete('/api/candidate/:id',async(req,res)=>{
  const id=Number(req.params.id),c=getCandidate(id);if(!c)return res.status(404).json({error:'Candidato não encontrado'});
  try{await closeLoginSession(id);}catch{}
  db.prepare('DELETE FROM candidates WHERE id=?').run(id);
  fs.rmSync(candidateDir(id),{recursive:true,force:true});
  res.json({ok:true,id,name:c.name});
});

app.delete('/api/run/:id',(req,res)=>{
  const id=Number(req.params.id);
  for(const x of db.prepare('SELECT tailored_file FROM applications WHERE run_id=?').all(id)) if(x.tailored_file) fs.rmSync(x.tailored_file,{force:true});
  db.prepare('DELETE FROM applications WHERE run_id=?').run(id);
  db.prepare('DELETE FROM jobs WHERE run_id=?').run(id);
  db.prepare('DELETE FROM runs WHERE id=?').run(id);
  res.json({ok:true});
});

app.post('/api/execution/delete',async(req,res)=>{
  try{
    await closeLoginSession();
    db.close();
    res.json({ok:true,path:runtime.session,message:'Execução encerrada e pasta agendada para exclusão.'});
    setTimeout(()=>{try{fs.rmSync(runtime.session,{recursive:true,force:true});}finally{process.exit(0);}},600);
  }catch(e){res.status(500).json({error:String(e.message||e)});}
});

app.post('/api/reset',(req,res)=>{
  db.exec('DELETE FROM applications; DELETE FROM jobs; DELETE FROM runs; DELETE FROM resumes;');
  for(const dir of [uploadDir,generatedDir,reportDir]){
    for(const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir,name),{recursive:true,force:true});
  }
  res.json({ok:true});
});

app.listen(PORT,'127.0.0.1',()=>{
  console.log(`LetsWork: http://127.0.0.1:${PORT}`);
  console.log(`PASTA DESTA EXECUÇÃO: ${runtime.session}`);
});

app.get('/api/run/:id/applications',(req,res)=>{
  const id=Number(req.params.id);
  const rows=db.prepare(`SELECT a.status,a.error,a.submitted_at,j.title,j.location,j.salary,j.url
    FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.run_id=? ORDER BY j.score DESC`).all(id);
  res.json(rows);
});

