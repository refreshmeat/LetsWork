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
import { searchJobs, buildSearchTerms, dedupeJobs, maintainRioVagasInventory, getRioVagasInventoryStatus } from './services/jobs.mjs';
import { prefilterJobsForAI, reviewVerifiedJobsWithAI, jobNeedsAIReview } from './services/ranking.mjs';
import { classifyJobsForQueue } from './services/sendability.mjs';
import { optimizeBaseResume } from './services/tailor.mjs';
import { terminalInventoryIds, upsertCandidateMatch, updateCandidateMatchStatus, recordRunEvent, runMetrics, sourceRegistry } from './services/inventory.mjs';
import { createPortableBackup, preparePortableRestore } from './services/backup.mjs';
import { applyRioVagasDirect } from './apply/rio.mjs';
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
const getBatchJobs = id => {
  const run=getRun(id); if(!run)return [];
  const batch=Math.max(1,Number(run.active_batch||1));
  if(batch===1)return db.prepare(`SELECT * FROM jobs WHERE run_id=? AND ((sendable=1 AND batch_no=?) OR blocked_reason='ALREADY_SENT')
    ORDER BY CASE WHEN blocked_reason='ALREADY_SENT' THEN 1 ELSE 0 END,score DESC`).all(id,batch);
  return db.prepare('SELECT * FROM jobs WHERE run_id=? AND sendable=1 AND batch_no=? ORDER BY score DESC').all(id,batch);
};
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
  if(latest){ if(latest.base_resume_path)try{fs.rmSync(latest.base_resume_path,{force:true});}catch{}; db.prepare('UPDATE resumes SET original_name=?,stored_path=?,extracted_text=?,profile_json=?,base_resume_path=NULL,base_resume_text=NULL,base_resume_focus=NULL,base_resume_updated_at=NULL WHERE id=?').run(primary.original_name,primary.stored_path,combined,json(profile),latest.id); }
  else db.prepare('INSERT INTO resumes(candidate_id,original_name,stored_path,extracted_text,profile_json) VALUES(?,?,?,?,?)').run(candidateId,primary.original_name,primary.stored_path,combined,json(profile));
  return profile;
}
const normJobKey=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function pendingFieldForQuestion(question){
  const q=normJobKey(question);
  if(/\bcpf\b/.test(q))return 'cpf';
  if(/\bcep\b|codigo postal/.test(q))return 'cep';
  if(/nascimento|data de nascimento/.test(q))return 'birthDate';
  if(/endereco|logradouro/.test(q))return 'address';
  if(/bairro|onde mora|onde reside|reside em|mora em|residencia|facil acesso|proximo|perto|distancia|desloc|trajeto|locomoc|como.*(?:chegaria|chegar)|tempo.*(?:empresa|trabalho|local)|onibus|brt|metro/.test(q))return 'neighborhood';
  if(/linkedin/.test(q))return 'linkedin';
  if(/instagram/.test(q))return 'instagram';
  if(/portfolio|portifolio/.test(q))return 'portfolio';
  return '';
}
const pendingFieldLabels={cpf:'CPF',cep:'CEP',birthDate:'Data de nascimento',address:'Endereço',neighborhood:'Bairro de residência',linkedin:'LinkedIn',instagram:'Instagram',portfolio:'Portfólio'};
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
function compileSearchEvidence(terms){
  return [...new Set((terms||[]).map(normSearch).filter(x=>x.length>=3))].map(term=>{
    const pattern=rxEscape(term).replace(/\\ /g,'\\s+');
    return {term,rx:new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`,'i')};
  });
}
function addSearchEvidence(job,compiledTerms){
  const title=normSearch(job.title),body=normSearch(`${job.title||''} ${job.description||''} ${job.company||''}`);
  const titleHits=[],bodyHits=[];
  for(const row of compiledTerms||[]){
    if(row.rx.test(title))titleHits.push(row.term);
    if(row.rx.test(body))bodyHits.push(row.term);
  }
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

app.post('/api/resume/:id/optimize-base',async(req,res)=>{
  try{
    const id=Number(req.params.id),row=getResume(id);
    if(!row)return res.status(404).json({error:'Currículo não encontrado'});
    const supportDocuments=db.prepare('SELECT * FROM documents WHERE candidate_id=? AND is_primary=0 ORDER BY id').all(row.candidate_id);
    const profile={...parseJson(row.profile_json,{}),candidateId:row.candidate_id,supportDocuments};
    const focus=String(req.body?.focus||'').trim();
    const template=['executive','classic','compact'].includes(String(req.body?.template||''))?String(req.body.template):String(row.base_resume_template||'executive');
    const result=await optimizeBaseResume(row.stored_path,profile,focus,template);
    if(row.base_resume_path&&row.base_resume_path!==result.file){try{fs.rmSync(row.base_resume_path,{force:true});}catch{}}
    db.prepare('UPDATE resumes SET base_resume_path=?,base_resume_text=?,base_resume_focus=?,base_resume_template=?,base_resume_updated_at=CURRENT_TIMESTAMP WHERE id=?').run(result.file,result.text||'',result.focus||focus,result.template||template,id);
    db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.candidate_id);
    const updated=getResume(id);
    res.json({ok:true,file:updated.base_resume_path,focus:updated.base_resume_focus,template:updated.base_resume_template||'executive',updatedAt:updated.base_resume_updated_at,validation:result.validation||null});
  }catch(e){res.status(500).json({error:String(e?.message||e)});}
});

app.get('/api/resume/:id/base-file',(req,res)=>{
  const row=getResume(Number(req.params.id));
  const file=row?.base_resume_path;
  if(!file||!fs.existsSync(file))return res.status(404).json({error:'Currículo-base otimizado ainda não foi gerado'});
  res.download(path.resolve(file),'curriculo-base-otimizado.pdf');
});
app.get('/api/candidate/:id/pending-data',(req,res)=>{
  const id=Number(req.params.id),candidate=getCandidate(id);
  if(!candidate)return res.status(404).json({error:'Candidato não encontrado'});
  const resume=db.prepare('SELECT * FROM resumes WHERE candidate_id=? ORDER BY id DESC LIMIT 1').get(id);
  const run=latestRun(id);
  if(!resume||!run)return res.json({runId:run?.id||null,total:0,requiredFields:[],custom:[],readyToRetry:0});
  const profile=parseJson(resume.profile_json,{});
  const saved=profile.formAnswers&&typeof profile.formAnswers==='object'?profile.formAnswers:{};
  const rows=db.prepare(`SELECT a.job_id,a.error,j.title
    FROM applications a JOIN jobs j ON j.id=a.job_id
    WHERE a.run_id=? AND a.status='NEEDS_DATA'
    ORDER BY a.job_id`).all(run.id);
  const unique=new Map();
  for(const row of rows){
    const raw=String(row.error||'').replace(/^.*?Campos obrigat[^:]*:\s*/i,'').trim();
    for(const part of raw.split(/\s*\|\s*/)){
      const question=String(part||'').trim(); if(!question)continue;
      const key=normJobKey(question); if(!key)continue;
      if(!unique.has(key))unique.set(key,{question,jobs:[]});
      unique.get(key).jobs.push({jobId:row.job_id,title:row.title});
    }
  }
  const fieldMap=new Map(),custom=[];
  for(const item of unique.values()){
    const qnorm=normJobKey(item.question);
    if(/(?:linkedin|instagram|portfolio|portifolio)/.test(qnorm)&&/(?:se tiver|se houver|opcional)/.test(qnorm))continue;
    const field=pendingFieldForQuestion(item.question);
    if(field){
      if(!String(profile[field]??'').trim()){
        if(!fieldMap.has(field))fieldMap.set(field,{field,label:pendingFieldLabels[field]||field,questions:[],jobs:[]});
        const rec=fieldMap.get(field);rec.questions.push(item.question);rec.jobs.push(...item.jobs);
      }
      continue;
    }
    const savedKey=Object.keys(saved).find(k=>normJobKey(k)===normJobKey(item.question));
    custom.push({question:item.question,answer:savedKey?String(saved[savedKey]??''):'',jobs:item.jobs});
  }
  const unresolvedCustom=custom.filter(x=>!String(x.answer||'').trim());
  const requiredFields=[...fieldMap.values()];
  const blockedJobIds=new Set();
  for(const f of requiredFields)for(const j of f.jobs||[])blockedJobIds.add(j.jobId);
  for(const c of unresolvedCustom)for(const j of c.jobs||[])blockedJobIds.add(j.jobId);
  res.json({runId:run.id,total:rows.length,requiredFields,custom,readyToRetry:Math.max(0,rows.length-blockedJobIds.size)});
});

app.patch('/api/candidate/:id/pending-data',(req,res)=>{
  const id=Number(req.params.id),resume=db.prepare('SELECT * FROM resumes WHERE candidate_id=? ORDER BY id DESC LIMIT 1').get(id);
  if(!resume)return res.status(404).json({error:'Currículo não encontrado'});
  const profile=parseJson(resume.profile_json,{});
  const nextAnswers={...(profile.formAnswers&&typeof profile.formAnswers==='object'?profile.formAnswers:{})};
  const answers=req.body?.answers&&typeof req.body.answers==='object'?req.body.answers:{};
  for(const [question,value] of Object.entries(answers)){
    const q=String(question||'').trim(),v=String(value??'').trim();
    if(q&&v)nextAnswers[q]=v;
  }
  const fields=req.body?.fields&&typeof req.body.fields==='object'?req.body.fields:{};
  const allowed=new Set(['cpf','cep','birthDate','address','neighborhood','linkedin','instagram','portfolio']);
  for(const [key,value] of Object.entries(fields))if(allowed.has(key))profile[key]=String(value??'').trim();
  profile.formAnswers=nextAnswers;
  db.prepare('UPDATE resumes SET profile_json=? WHERE id=?').run(json(profile),resume.id);
  db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
  res.json({ok:true,profile:{...profile,rawText:undefined}});
});
let searchInFlight=false;
const aiReviewPromises=new Map();

async function reviewPendingJobsForRun({runId,pending,profile,filters,batchSize,preview,candidateId}){
  if(!pending.length)return;
  const input=pending.map(j=>({...j,sendable:1,reason:'',verified:true,httpReady:true}));
  const reviewed=await reviewVerifiedJobsWithAI(input,profile,filters,{maxJobs:input.length,batchSize:12});
  const updJob=db.prepare('UPDATE jobs SET sendable=?,blocked_reason=?,selected=0,batch_no=0 WHERE run_id=? AND source_key=?');
  for(const j of reviewed){
    const fp=jobFingerprint(j),ok=j.sendable===1?1:0,reason=ok?'':String(j.reason||'AI_REVIEW_FAILED');
    updJob.run(ok,reason,runId,fp);
    const row=db.prepare('SELECT inventory_id,score,rank_position FROM jobs WHERE run_id=? AND source_key=?').get(runId,fp)||{};
    upsertCandidateMatch({candidateId,inventoryId:Number(j.inventoryId||row.inventory_id||0),runId,score:j.score||row.score||0,decision:ok?'AI_APPROVED':reason,reason,rankPosition:row.rank_position||0,batchNo:0});
  }

  while(['APPLYING','RETRYING'].includes(String(getRun(runId)?.status||''))){
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  db.prepare('UPDATE jobs SET selected=0,batch_no=0 WHERE run_id=?').run(runId);
  const activeBatch=Number(getRun(runId)?.active_batch||1);
  const rows=db.prepare('SELECT id,inventory_id,score,rank_position FROM jobs WHERE run_id=? AND sendable=1 ORDER BY rank_position ASC,score DESC').all(runId);
  const alloc=db.prepare('UPDATE jobs SET batch_no=?,selected=? WHERE id=?');
  for(let i=0;i<rows.length;i++){
    const row=rows[i],batch=Math.floor(i/batchSize)+1,selected=batch===activeBatch?1:0;
    alloc.run(batch,selected,row.id);
    upsertCandidateMatch({candidateId,inventoryId:row.inventory_id,runId,score:row.score||0,decision:selected?'SELECTED':'RESERVE',reason:'',rankPosition:row.rank_position||i+1,batchNo:batch});
  }
  recordRunEvent({runId,candidateId,type:'AI_REVIEW_COMPLETE',data:{reviewed:reviewed.length,approved:reviewed.filter(x=>x.sendable===1).length}});
}

app.post('/api/search', async (req,res) => {
  if(searchInFlight) return res.status(409).json({error:'Uma busca já está em andamento. Aguarde a conclusão para iniciar outra.'});
  searchInFlight=true;
  try {
    const {resumeId,filters={},preview=false} = req.body || {};
    let resume = getResume(Number(resumeId));
    if (!resume) return res.status(400).json({error:'Currículo não encontrado'});
    const profile = {...parseJson(resume.profile_json,{}),candidateId:resume.candidate_id};
    if(!resume.base_resume_path||!fs.existsSync(resume.base_resume_path)){
      const supportDocuments=db.prepare('SELECT * FROM documents WHERE candidate_id=? AND is_primary=0 ORDER BY id').all(resume.candidate_id);
      const baseProfile={...profile,supportDocuments};
      const baseFocus=String(filters.area||profile.desiredArea||'').trim();
      const base=await optimizeBaseResume(resume.stored_path,baseProfile,baseFocus,resume.base_resume_template||'executive');
      db.prepare('UPDATE resumes SET base_resume_path=?,base_resume_text=?,base_resume_focus=?,base_resume_template=?,base_resume_updated_at=CURRENT_TIMESTAMP WHERE id=?').run(base.file,base.text||'',base.focus||baseFocus,base.template||resume.base_resume_template||'executive',resume.id);
      db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(resume.candidate_id);
      resume=getResume(resume.id);
    }
    const recencyDays=[7,15,30].includes(Number(filters.recencyDays))?Number(filters.recencyDays):15;
    const effectiveFilters={...filters,candidateId:resume.candidate_id,nationwide:false,limit:500,recencyDays};
    // Fase de validação do produto: toda busca/candidatura usa apenas RioVagas.
    // A compatibilidade continua sendo derivada individualmente de cada currículo.
    effectiveFilters.publicSourcesOnly=true;
    effectiveFilters.publicSourceKeys=['rio'];
    effectiveFilters.agenticBroadReview=true;
    const rioOnly=effectiveFilters.publicSourcesOnly===true&&Array.isArray(effectiveFilters.publicSourceKeys)&&effectiveFilters.publicSourceKeys.length===1&&effectiveFilters.publicSourceKeys[0]==='rio';
    const priorRows=db.prepare('SELECT resume_id,filters_json FROM runs WHERE candidate_id=? AND resume_id=? ORDER BY id DESC LIMIT 8').all(resume.candidate_id,resume.id);
    for(const row of priorRows){
      const pf=parseJson(row.filters_json,{});
      if(Number(pf.searchPlanEvidenceVersion||0)>=2&&String(pf.searchPlanVersion||'')==='quality-agent-v22-compact-queries'&&String(pf.searchFocus||'').trim()&&(pf.searchCoreTerms||[]).length>=1){
        effectiveFilters.priorCareerPlan={evidenceVersion:pf.searchPlanEvidenceVersion,planVersion:pf.searchPlanVersion,focus:pf.searchFocus,families:pf.searchFamilies||[],core:pf.searchCoreTerms||[],adjacent:pf.searchAdjacentTerms||[],queries:pf.searchQueries||[],exclude:pf.searchExclusions||[],literal:pf.searchLiteralTerms||[],links:pf.searchPlanLinks||[]};
        break;
      }
    }
    const searchTerms=await buildSearchTerms(profile,effectiveFilters);
    effectiveFilters.searchFocus=String(searchTerms.focus||'').trim();
    effectiveFilters.searchFamilies=Array.isArray(searchTerms.families)?searchTerms.families:[];
    effectiveFilters.searchLiteralTerms=Array.isArray(searchTerms.literal)?searchTerms.literal:[];
    effectiveFilters.searchCoreTerms=Array.isArray(searchTerms.core)?searchTerms.core:[];
    effectiveFilters.searchAdjacentTerms=Array.isArray(searchTerms.adjacent)?searchTerms.adjacent:[];
    effectiveFilters.searchTargetTerms=Array.isArray(searchTerms.targets)&&searchTerms.targets.length?searchTerms.targets:[...new Set([...effectiveFilters.searchCoreTerms,...effectiveFilters.searchAdjacentTerms])];
    effectiveFilters.searchQueries=Array.isArray(searchTerms.queries)?searchTerms.queries:[...searchTerms];
    effectiveFilters.searchExclusions=Array.isArray(searchTerms.exclusions)?searchTerms.exclusions:[];
    effectiveFilters.searchPlanEvidenceVersion=Number(searchTerms.evidenceVersion||0);
    effectiveFilters.searchPlanLinks=Array.isArray(searchTerms.links)?searchTerms.links:[];
    effectiveFilters.searchPlanVersion=String(searchTerms.planVersion||'');
    const raw=await searchJobs(profile,effectiveFilters,searchTerms);
    const evidenceMatcher=compileSearchEvidence(searchTerms);
    const recent=recentJobs(raw,effectiveFilters.recencyDays).map(j=>addSearchEvidence(j,evidenceMatcher));
    const candidatePool=dedupeJobs(recent);
    const historyRows=db.prepare("SELECT fingerprint,provider_job_id,status,last_run_id FROM candidate_job_history WHERE candidate_id=? AND status IN ('SENT','ALREADY_APPLIED')").all(resume.candidate_id);
    const sentHistory=new Map(historyRows.map(x=>[x.fingerprint,x]));
    const sentProviderIds=new Set(historyRows.map(x=>String(x.provider_job_id||'')).filter(Boolean));
    const terminalIds=terminalInventoryIds(resume.candidate_id);
    const alreadyDone=j=>(Number(j.inventoryId)>0&&terminalIds.has(Number(j.inventoryId)))||
      (String(j.externalId||'')&&sentProviderIds.has(String(j.externalId)))||sentHistory.has(jobFingerprint(j));
    const unseen=candidatePool.filter(j=>!alreadyDone(j));
    const alreadySentPool=candidatePool.filter(alreadyDone);
    const ranked=prefilterJobsForAI(unseen,profile,effectiveFilters);
    ranked.sort((a,b)=>(b.score||0)-(a.score||0)||(Number.isFinite(a.ftsRank)?a.ftsRank:999999)-(Number.isFinite(b.ftsRank)?b.ftsRank:999999));
    const batchSize=Math.min(500,Math.max(100,Number(effectiveFilters.limit||500)));
    const checked=await classifyJobsForQueue(ranked,{batchSize:Math.max(1,ranked.length),probeLimit:Math.max(1,ranked.length)});
    for(const j of checked)if(j.detailText)j.description=[j.description||'',j.detailText].filter(Boolean).join('\n\n').slice(0,50000);
    const preparedRaw=checked.map(j=>{
      if(j.sendable!==1)return j;
      if(jobNeedsAIReview(j,effectiveFilters))return {...j,sendable:0,reason:'AI_REVIEW_PENDING',verified:true,aiReviewed:false};
      return {...j,aiReviewed:true,reviewMethod:'rules',aiReason:'Compatibilidade direta validada por requisitos objetivos e evidência do currículo.'};
    });
    const prepared=[]; const preparedUrls=new Set();
    for(const j of preparedRaw){
      const key=canonicalUrl(j.url)||jobFingerprint(j);
      if(preparedUrls.has(key))continue;
      preparedUrls.add(key);prepared.push(j);
    }
    prepared.forEach((j,index)=>{j._rank=index+1;});
    const alreadySent=alreadySentPool.map((j,index)=>{
      const fp=jobFingerprint(j),hist=sentHistory.get(fp)||{};
      return {...j,score:Number(j.score||0),sendable:0,reason:'ALREADY_SENT',alreadySent:true,
        previousStatus:hist.status||'SENT',previousRunId:hist.last_run_id||null,_rank:prepared.length+index+1,_batch:0,_selected:0};
    });
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
    const runId=Number(info.lastInsertRowid);
    recordRunEvent({runId,candidateId:resume.candidate_id,type:'SEARCH_START',data:{recencyDays,inventory:raw.length,terms:Array.from(searchTerms).slice(0,24)}});
    const ins = db.prepare(`INSERT OR IGNORE INTO jobs
      (run_id,inventory_id,provider_job_id,source,source_key,title,company,salary,location,url,description,score,pcd,remote,contract_type,published_at,sendable,blocked_reason,selected,batch_no,rank_position)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    db.exec('BEGIN');
    try{
      for (const j of [...prepared,...alreadySent]){
        const fp=jobFingerprint(j);
        ins.run(runId,Number(j.inventoryId)||null,String(j.externalId||''),j.source,fp,j.title,j.company||'',j.salary||'',j.location||'',j.url,j.description||'',j.score||0,j.pcd?1:0,j.remote?1:0,j.contractType||(j.pj?'PJ':j.clt?'CLT':''),j.publishedAt||'',j.sendable,j.reason||'',j._selected,j._batch,j._rank);
        const decision=j.alreadySent?(j.previousStatus||'ALREADY_APPLIED'):(j.sendable?(j._selected?'SELECTED':'RESERVE'):(j.reason||'REJECTED'));
        upsertCandidateMatch({candidateId:resume.candidate_id,inventoryId:j.inventoryId,runId,score:j.score||0,decision,reason:j.reason||'',rankPosition:j._rank,batchNo:j._batch});
      }
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    const allPendingReview=prepared.filter(j=>j.reason==='AI_REVIEW_PENDING');
    const reviewSlots=Math.max(0,Math.min(12,batchSize-sendable.length));
    const pendingReview=allPendingReview.slice(0,reviewSlots);
    const deferredReview=allPendingReview.slice(reviewSlots);
    if(deferredReview.length){
      const defer=db.prepare("UPDATE jobs SET blocked_reason='AMBIGUOUS_LOW_CONFIDENCE',sendable=0,selected=0,batch_no=0 WHERE run_id=? AND source_key=?");
      for(const j of deferredReview){
        const fp=jobFingerprint(j);defer.run(runId,fp);
        upsertCandidateMatch({candidateId:resume.candidate_id,inventoryId:j.inventoryId,runId,score:j.score||0,decision:'AMBIGUOUS_LOW_CONFIDENCE',reason:'AMBIGUOUS_LOW_CONFIDENCE',rankPosition:j._rank,batchNo:0});
      }
    }
    if(pendingReview.length){
      const reviewPromise=reviewPendingJobsForRun({runId,pending:pendingReview,profile,filters:effectiveFilters,batchSize,preview:Boolean(preview),candidateId:resume.candidate_id})
        .catch(e=>{
          console.error('[ranking] review failed',String(e?.message||e));
          db.prepare("UPDATE jobs SET blocked_reason='AI_REVIEW_FAILED' WHERE run_id=? AND blocked_reason='AI_REVIEW_PENDING'").run(runId);
        })
        .finally(()=>aiReviewPromises.delete(runId));
      aiReviewPromises.set(runId,reviewPromise);
    }
    const countBySource=rows=>Object.fromEntries(Object.entries(rows.reduce((acc,j)=>{const k=j.source||'Outra';acc[k]=(acc[k]||0)+1;return acc;},{})).sort((a,b)=>b[1]-a[1]));
    const finalAll=getAllJobs(runId);
    const finalJobs=getBatchJobs(runId);
    const finalSelected=finalAll.filter(j=>Number(j.sendable)===1&&Number(j.selected)===1);
    const finalSendable=finalAll.filter(j=>Number(j.sendable)===1);
    const finalBlocked=finalAll.filter(j=>['LOGIN_REQUIRED','EMAIL_REQUIRED'].includes(j.blocked_reason));
    const finalPending=finalAll.filter(j=>j.blocked_reason==='AI_REVIEW_PENDING');
    const finalUnverified=finalAll.filter(j=>Number(j.sendable)===0&&!['LOGIN_REQUIRED','EMAIL_REQUIRED','AI_REVIEW_PENDING','ALREADY_SENT'].includes(j.blocked_reason));
    const finalAlreadySent=finalAll.filter(j=>j.blocked_reason==='ALREADY_SENT');
    const finalBatches=Math.max(1,...finalSendable.map(j=>Number(j.batch_no||1)));
    recordRunEvent({runId,candidateId:resume.candidate_id,type:'SEARCH_COMPLETE',data:{inventory:raw.length,pool:candidatePool.length,ranked:ranked.length,sendable:finalSendable.length,selected:finalSelected.length,aiPending:finalPending.length}});
    res.json({runId,preview:Boolean(preview),found:raw.length,recent:recent.length,staleSkipped:raw.length-recent.length,previouslySeenSkipped:Math.max(0,candidatePool.length-unseen.length),poolTotal:candidatePool.length,compatible:finalSelected.length,compatibleTotal:prepared.length,sendableTotal:finalSendable.length,reserve:Math.max(0,finalSendable.length-finalSelected.length),blockedLogin:0,blockedEmail:0,aiReviewPending:finalPending.length,unverifiedLogin:finalUnverified.length,batches:finalBatches,sourceCounts:countBySource(candidatePool),freshSourceCounts:countBySource(raw),compatibleSourceCounts:countBySource(finalSelected),sendableSourceCounts:countBySource(finalSendable),blockedSourceCounts:countBySource(finalBlocked),unverifiedSourceCounts:countBySource(finalUnverified),alreadySentTotal:finalAlreadySent.length,jobs:finalJobs});
  } catch(e) { res.status(500).json({error:String(e.message||e)}); }
  finally { searchInFlight=false; }
});

app.get('/api/run/:id/jobs',(req,res)=>res.json(getBatchJobs(Number(req.params.id))));
async function processRun(runId,onlyErrors=false){
  const run=getRun(runId);if(!run)throw new Error('Execução não encontrada');
  const resume=getResume(run.resume_id);
  const supportDocuments=db.prepare('SELECT kind,original_name,stored_path FROM documents WHERE candidate_id=? AND is_primary=0').all(run.candidate_id);
  const profile={...parseJson(resume.profile_json,{}),candidateId:run.candidate_id,supportDocuments};
  const prefs={...parseJson(run.filters_json,{}),candidateId:run.candidate_id};
  const dryRun=!prefs.autoSubmit;
  const applicationResume=(resume.base_resume_path&&fs.existsSync(resume.base_resume_path))?resume.base_resume_path:'';
  if(!applicationResume)throw new Error('Currículo-base ainda não foi gerado. Gere o currículo otimizado antes de iniciar os envios.');

  let jobs=getJobs(runId).filter(job=>/^RioVagas$/i.test(String(job?.source||''))&&/riovagas\.com\.br\/riovagas\//i.test(String(job?.url||'')));
  if(onlyErrors){
    const ids=new Set(db.prepare("SELECT job_id FROM applications WHERE run_id=? AND status IN ('ERROR','NEEDS_DATA','PREPARING','READY')").all(runId).map(x=>x.job_id));
    const retryCandidates=jobs.filter(x=>ids.has(x.id)).map(x=>({...x,contractType:x.contract_type||'',publishedAt:x.published_at||''}));
    const eligible=prefilterJobsForAI(retryCandidates,profile,prefs);
    const eligibleIds=new Set(eligible.map(x=>x.id));
    for(const job of retryCandidates.filter(x=>!eligibleIds.has(x.id))){
      db.prepare("UPDATE applications SET status='SKIPPED_INCOMPATIBLE',error=? WHERE run_id=? AND job_id=?").run('Ignorada na retentativa: vaga incompatível com o perfil profissional atual.',runId,job.id);
      db.prepare('UPDATE jobs SET selected=0 WHERE id=?').run(job.id);
      updateCandidateMatchStatus(run.candidate_id,job.inventory_id,'SKIPPED_INCOMPATIBLE','Perfil não compatível na retentativa',runId);
    }
    jobs=eligible;
  }

  db.prepare('UPDATE runs SET status=? WHERE id=?').run(onlyErrors?'RETRYING':'APPLYING',runId);
  recordRunEvent({runId,candidateId:run.candidate_id,type:onlyErrors?'RETRY_START':'APPLY_START',data:{jobs:jobs.length,dryRun}});

  const saveApplication=(job,status,error='')=>{
    const row=db.prepare(`INSERT INTO applications(run_id,job_id,status,tailored_file,error,submitted_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,job_id) DO UPDATE SET
        status=excluded.status,error=excluded.error,submitted_at=excluded.submitted_at
      RETURNING id`).get(runId,job.id,status,'',error||'',['SENT','ALREADY_APPLIED'].includes(status)?new Date().toISOString():null);
    return Number(row?.id||db.prepare('SELECT id FROM applications WHERE run_id=? AND job_id=?').get(runId,job.id)?.id||0);
  };
  const saveReceipt=(applicationId,job,receipt)=>{
    if(!applicationId||!receipt)return;
    db.prepare(`INSERT INTO application_receipts
      (application_id,candidate_id,inventory_id,provider,provider_job_id,confirmation_type,http_status,response_url,response_hash,confirmation_text)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(applicationId,run.candidate_id,Number(job.inventory_id)||null,receipt.provider||'RioVagas',receipt.providerJobId||'',receipt.confirmationType||'UNKNOWN',receipt.httpStatus??null,receipt.responseUrl||'',receipt.responseHash||'',receipt.confirmationText||'');
  };
  const updateHistory=(job,status)=>{
    if(!job.source_key)return;
    const providerJobId=String(job.provider_job_id||'');
    if(providerJobId){
      const existing=db.prepare(`SELECT id,status,last_run_id FROM candidate_job_history
        WHERE candidate_id=? AND source=? AND provider_job_id=? ORDER BY id LIMIT 1`).get(run.candidate_id,job.source||'',providerJobId);
      if(existing){
        db.prepare(`UPDATE candidate_job_history SET fingerprint=?,url=?,title=?,company=?,location=?,published_at=?,last_seen_at=CURRENT_TIMESTAMP,
          last_run_id=CASE WHEN status IN ('SENT','ALREADY_APPLIED') THEN last_run_id ELSE ? END,
          status=CASE WHEN status IN ('SENT','ALREADY_APPLIED') THEN status ELSE ? END WHERE id=?`)
          .run(job.source_key,job.url||'',job.title||'',job.company||'',job.location||'',job.published_at||'',runId,status,existing.id);
        return;
      }
    }
    db.prepare(`INSERT INTO candidate_job_history
      (candidate_id,fingerprint,provider_job_id,source,url,title,company,location,published_at,status,last_run_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_id,fingerprint) DO UPDATE SET
        provider_job_id=CASE WHEN excluded.provider_job_id<>'' THEN excluded.provider_job_id ELSE candidate_job_history.provider_job_id END,
        source=excluded.source,url=excluded.url,title=excluded.title,company=excluded.company,location=excluded.location,published_at=excluded.published_at,
        last_seen_at=CURRENT_TIMESTAMP,
        last_run_id=CASE WHEN candidate_job_history.status IN ('SENT','ALREADY_APPLIED') THEN candidate_job_history.last_run_id ELSE excluded.last_run_id END,
        status=CASE WHEN candidate_job_history.status IN ('SENT','ALREADY_APPLIED') THEN candidate_job_history.status ELSE excluded.status END`)
      .run(run.candidate_id,job.source_key,providerJobId,job.source||'',job.url||'',job.title||'',job.company||'',job.location||'',job.published_at||'',status,runId);
  };

  let cursor=0;
  const workerCount=Math.max(2,Math.min(8,Number(process.env.RIO_APPLY_WORKERS||4)));
  async function worker(){
    while(true){
      const index=cursor++;if(index>=jobs.length)return;
      const job=jobs[index];
      const old=db.prepare('SELECT * FROM applications WHERE run_id=? AND job_id=?').get(runId,job.id);
      if(['SENT','ALREADY_APPLIED'].includes(old?.status))continue;
      try{
        saveApplication(job,'PREPARING','');
        const result=await applyRioVagasDirect(job,applicationResume,profile,prefs,{dryRun});
        const applicationId=saveApplication(job,result.status,result.error||'');
        saveReceipt(applicationId,job,result.receipt);
        if(result.status==='CLOSED')db.prepare("UPDATE jobs SET sendable=0,blocked_reason='CLOSED',selected=0,batch_no=0 WHERE id=?").run(job.id);
        updateHistory(job,result.status);
        updateCandidateMatchStatus(run.candidate_id,job.inventory_id,result.status,result.error||'',runId);
        recordRunEvent({runId,candidateId:run.candidate_id,type:'APPLICATION_RESULT',data:{jobId:job.id,inventoryId:job.inventory_id,status:result.status,error:String(result.error||'').slice(0,240),receiptType:result.receipt?.confirmationType||''}});
      }catch(e){
        const message=String(e?.message||e).slice(0,500);
        saveApplication(job,'ERROR',message);
        updateHistory(job,'ERROR');
        updateCandidateMatchStatus(run.candidate_id,job.inventory_id,'ERROR',message,runId);
        recordRunEvent({runId,candidateId:run.candidate_id,type:'APPLICATION_ERROR',data:{jobId:job.id,inventoryId:job.inventory_id,error:message}});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(workerCount,Math.max(1,jobs.length))},()=>worker()));
  db.prepare('UPDATE runs SET status=? WHERE id=?').run('DONE',runId);
  recordRunEvent({runId,candidateId:run.candidate_id,type:'APPLY_COMPLETE',data:runMetrics(runId)});
}

function startBackground(runId,onlyErrors){
  // Start processing the already-approved selection immediately.
  // Ambiguous jobs can keep being reviewed in the background and join later batches.
  setImmediate(async()=>{
    try{
      await processRun(runId,onlyErrors);
    }catch(e){
      db.prepare('UPDATE runs SET status=? WHERE id=?').run('ERROR: '+String(e.message||e).slice(0,120),runId);
    }
  });
}

app.get('/api/execution',(req,res)=>res.json({path:runtime.session}));

function persistRunSelection(runId,selectedJobIds){
  const run=getRun(runId);
  if(!run)throw new Error('Execução não encontrada');
  const batch=Math.max(1,Number(run.active_batch||1));
  const allowed=db.prepare('SELECT id FROM jobs WHERE run_id=? AND sendable=1 AND batch_no=?').all(runId,batch).map(x=>Number(x.id));
  const allowedSet=new Set(allowed);
  const requested=Array.isArray(selectedJobIds)?[...new Set(selectedJobIds.map(Number).filter(x=>Number.isInteger(x)&&allowedSet.has(x)))]:[];
  db.prepare('UPDATE jobs SET selected=0 WHERE run_id=? AND sendable=1 AND batch_no=?').run(runId,batch);
  if(requested.length){
    const placeholders=requested.map(()=>'?').join(',');
    db.prepare(`UPDATE jobs SET selected=1 WHERE run_id=? AND batch_no=? AND sendable=1 AND id IN (${placeholders})`).run(runId,batch,...requested);
  }
  return {batch,selected:requested.length,total:allowed.length,requested};
}

app.post('/api/run/:id/selection',(req,res)=>{
  const id=Number(req.params.id),run=getRun(id);
  if(!run)return res.status(404).json({error:'Execução não encontrada'});
  if(['APPLYING','RETRYING'].includes(run.status))return res.status(409).json({error:'Aguarde o processamento atual terminar antes de alterar a seleção.'});
  const saved=persistRunSelection(id,req.body?.selectedJobIds);
  res.json({ok:true,runId:id,...saved});
});

app.post('/api/run/:id/apply',(req,res)=>{
  const id=Number(req.params.id),run=getRun(id);
  if(!run)return res.status(404).json({error:'Execução não encontrada'});
  if(['APPLYING','RETRYING'].includes(run.status))return res.status(409).json({error:'Já existe processamento em andamento.'});
  const prefs=parseJson(run.filters_json,{});
  if(prefs.autoSubmit&&req.body?.confirmLive!==true)return res.status(409).json({error:'Confirmação explícita do modo real é obrigatória.'});
  const saved=persistRunSelection(id,req.body?.selectedJobIds);
  if(saved.selected<1)return res.status(400).json({error:'Selecione pelo menos uma vaga para processar.'});
  startBackground(id,false);
  res.json({ok:true,runId:id,...saved});
});

app.post('/api/run/:id/retry',(req,res)=>{
  const id=Number(req.params.id),run=getRun(id); if(!run) return res.status(404).json({error:'Execução não encontrada'});
  const prefs=parseJson(run.filters_json,{});
  if(prefs.autoSubmit&&req.body?.confirmLive!==true)return res.status(409).json({error:'Confirmação explícita do modo real é obrigatória para a retentativa.'});
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
  const counts=db.prepare('SELECT a.status,COUNT(*) count FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.run_id=? AND j.selected=1 GROUP BY a.status').all(id);
  const total=db.prepare('SELECT COUNT(*) count FROM jobs WHERE run_id=? AND selected=1 AND sendable=1').get(id).count;
  const pool=db.prepare(`SELECT COUNT(*) poolTotal,COALESCE(SUM(sendable),0) sendableTotal,
    COALESCE(SUM(CASE WHEN blocked_reason IN ('LOGIN_REQUIRED','EMAIL_REQUIRED') THEN 1 ELSE 0 END),0) blockedLogin,
    COALESCE(SUM(CASE WHEN blocked_reason='EMAIL_REQUIRED' THEN 1 ELSE 0 END),0) blockedEmail,
    COALESCE(SUM(CASE WHEN blocked_reason='AI_REVIEW_PENDING' THEN 1 ELSE 0 END),0) aiReviewPending,
    COALESCE(SUM(CASE WHEN blocked_reason='ALREADY_SENT' THEN 1 ELSE 0 END),0) alreadySentTotal,
    COALESCE(SUM(CASE WHEN sendable=0 AND blocked_reason NOT IN ('LOGIN_REQUIRED','EMAIL_REQUIRED','AI_REVIEW_PENDING','ALREADY_SENT') THEN 1 ELSE 0 END),0) unverifiedLogin,
    COALESCE(SUM(CASE WHEN sendable=1 AND selected=0 THEN 1 ELSE 0 END),0) reserve,
    COALESCE(MAX(batch_no),0) batches FROM jobs WHERE run_id=?`).get(id);
  res.json({runId:id,candidateId:run.candidate_id,resumeId:run.resume_id,status:run.status,total,activeBatch:run.active_batch||1,...pool,counts:Object.fromEntries(counts.map(x=>[x.status,x.count]))});
});

function reportRows(runId){
  return db.prepare(`SELECT COALESCE(a.status,CASE WHEN j.blocked_reason='LOGIN_REQUIRED' THEN 'BLOQUEADA LOGIN' WHEN j.blocked_reason='EMAIL_REQUIRED' THEN 'BLOQUEADA EMAIL' WHEN j.blocked_reason='ALREADY_SENT' THEN 'ENVIADA ANTERIORMENTE' WHEN j.sendable=0 THEN 'RESERVA NÃO VERIFICADA' WHEN j.selected=1 THEN 'PENDING' ELSE 'RESERVA' END) status,j.title,j.location,j.salary,j.url,j.score FROM jobs j
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
app.delete('/api/candidate/:id/search-history',(req,res)=>{
  const id=Number(req.params.id),candidate=getCandidate(id);
  if(!candidate)return res.status(404).json({error:'Candidato não encontrado'});
  const active=db.prepare("SELECT COUNT(*) n FROM runs WHERE candidate_id=? AND status IN ('APPLYING','RETRYING','PREPARING')").get(id).n||0;
  if(active)return res.status(409).json({error:'Há uma execução em andamento. Aguarde terminar antes de excluir o histórico.'});
  try{
    const runs=db.prepare('SELECT id FROM runs WHERE candidate_id=?').all(id).map(x=>Number(x.id));
    for(const runId of runs){
      for(const x of db.prepare('SELECT tailored_file FROM applications WHERE run_id=?').all(runId)){
        if(x.tailored_file)try{fs.rmSync(x.tailored_file,{force:true});}catch{}
      }
    }
    if(runs.length){
      const placeholders=runs.map(()=>'?').join(',');
      db.prepare(`DELETE FROM applications WHERE run_id IN (${placeholders})`).run(...runs);
      db.prepare(`DELETE FROM jobs WHERE run_id IN (${placeholders})`).run(...runs);
      db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...runs);
    }
    db.prepare('DELETE FROM candidate_job_history WHERE candidate_id=?').run(id);
    const dirs=ensureCandidateDirs(id);
    for(const name of fs.readdirSync(dirs.reports))try{fs.rmSync(path.join(dirs.reports,name),{recursive:true,force:true});}catch{}
    db.prepare('UPDATE candidates SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    res.json({ok:true,candidateId:id,deletedRuns:runs.length});
  }catch(e){res.status(500).json({error:String(e.message||e)});}
});

app.delete('/api/candidate/:id',async(req,res)=>{
  const id=Number(req.params.id),c=getCandidate(id);if(!c)return res.status(404).json({error:'Candidato não encontrado'});
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

app.get('/api/backup/export',(req,res)=>{
  try{
    const backup=createPortableBackup();
    res.download(path.resolve(backup.file),backup.name);
  }catch(e){res.status(500).json({error:String(e?.message||e)});}
});

app.post('/api/backup/import',upload.single('backup'),(req,res)=>{
  const uploaded=req.file?.path;
  try{
    if(!uploaded)return res.status(400).json({error:'Selecione um backup do LetsWork'});
    const result=preparePortableRestore(uploaded);
    res.json(result);
  }catch(e){res.status(400).json({error:String(e?.message||e)});}
  finally{if(uploaded)try{fs.rmSync(uploaded,{force:true});}catch{}}
});

app.get('/api/system/status',(req,res)=>{
  try{
    const dbFile=path.join(storage.data,'letswork.sqlite');
    res.json({inventory:getRioVagasInventoryStatus(),sources:sourceRegistry(),database:{path:dbFile,bytes:fs.existsSync(dbFile)?fs.statSync(dbFile).size:0}});
  }catch(e){res.status(500).json({error:String(e?.message||e)});}
});

app.get('/api/run/:id/metrics',(req,res)=>{
  try{res.json(runMetrics(Number(req.params.id)));}catch(e){res.status(500).json({error:String(e?.message||e)});}
});

app.get('/api/run/:id/events',(req,res)=>{
  try{
    const rows=db.prepare('SELECT id,event_type,data_json,created_at FROM run_events WHERE run_id=? ORDER BY id').all(Number(req.params.id)).map(x=>({...x,data:parseJson(x.data_json,{})}));
    res.json(rows);
  }catch(e){res.status(500).json({error:String(e?.message||e)});}
});

async function runRioInventoryMaintenance(){
  try{
    const status=await maintainRioVagasInventory();
    console.log(`[RioVagas] manutencao automatica: ${status.active||0} vagas ativas; ${status.fullSnapshot?'reconciliacao completa':'atualizacao incremental'}`);
  }catch(e){
    console.log('[RioVagas] manutencao automatica falhou:',String(e?.message||e));
  }
}

app.get('/api/inventory/riovagas/status',(req,res)=>{
  try{res.json(getRioVagasInventoryStatus());}catch(e){res.status(500).json({error:String(e?.message||e)});}
});

app.listen(PORT,'127.0.0.1',()=>{
  console.log(`LetsWork: http://127.0.0.1:${PORT}`);
  console.log(`PASTA DESTA EXECUÇÃO: ${runtime.session}`);
  const startup=setTimeout(runRioInventoryMaintenance,1200); startup.unref?.();
  const timer=setInterval(runRioInventoryMaintenance,60*60*1000); timer.unref?.();
});

app.get('/api/run/:id/applications',(req,res)=>{
  const id=Number(req.params.id);
  const rows=db.prepare(`SELECT a.status,a.error,a.submitted_at,j.title,j.location,j.salary,j.url
    FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.run_id=? ORDER BY j.score DESC`).all(id);
  res.json(rows);
});

