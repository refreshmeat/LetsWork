import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { db, json, parseJson } from './db.mjs';
import { extractText, inferProfile } from './services/resume.mjs';
import { searchJobs } from './services/jobs.mjs';
import { rankJobs } from './services/ranking.mjs';
import { tailorResume } from './services/tailor.mjs';
import { applyToJob } from './apply/engine.mjs';
import { runtime } from './runtime.mjs';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 4317);
const uploadDir = runtime.uploads;
const reportDir = runtime.reports;
const generatedDir = runtime.generated;
const upload = multer({ dest:uploadDir, limits:{fileSize:80*1024*1024} });
const app = express();
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(ROOT,'public')));

const getResume = id => db.prepare('SELECT * FROM resumes WHERE id=?').get(id);
const getRun = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const getJobs = id => db.prepare('SELECT * FROM jobs WHERE run_id=? ORDER BY score DESC').all(id);
app.post('/api/resume/upload', upload.single('resume'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({error:'Arquivo não recebido'});
    const ext = path.extname(req.file.originalname || '');
    const stored = `${req.file.path}${ext}`;
    fs.renameSync(req.file.path,stored);
    const text = await extractText(stored);
    const profile = inferProfile(text);
    const info = db.prepare('INSERT INTO resumes(original_name,stored_path,extracted_text,profile_json) VALUES(?,?,?,?)')
      .run(req.file.originalname,stored,text,json(profile));
    res.json({resumeId:Number(info.lastInsertRowid),profile:{...profile,rawText:undefined},chars:text.length});
  } catch(e) { res.status(500).json({error:String(e.message||e)}); }
});

app.patch('/api/resume/:id/profile',(req,res) => {
  const id = Number(req.params.id); const row = getResume(id);
  if (!row) return res.status(404).json({error:'Currículo não encontrado'});
  const profile = {...parseJson(row.profile_json,{}),...(req.body||{})};
  db.prepare('UPDATE resumes SET profile_json=? WHERE id=?').run(json(profile),id);
  res.json({ok:true,profile:{...profile,rawText:undefined}});
});
app.post('/api/search', async (req,res) => {
  try {
    const {resumeId,filters={}} = req.body || {};
    const resume = getResume(Number(resumeId));
    if (!resume) return res.status(400).json({error:'Currículo não encontrado'});
    const profile = parseJson(resume.profile_json,{});
    const raw = await searchJobs(profile,filters);
    const jobs = rankJobs(raw,profile,filters);
    const info = db.prepare('INSERT INTO runs(filters_json,resume_id,status) VALUES(?,?,?)')
      .run(json(filters),resume.id,'SEARCHED');
    const runId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO jobs
      (run_id,source,source_key,title,company,salary,location,url,description,score,pcd,remote,contract_type)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const j of jobs) ins.run(runId,j.source,'',j.title,j.company||'',j.salary||'',j.location||'',j.url,
      j.description||'',j.score||0,j.pcd?1:0,j.remote?1:0,j.pj?'PJ':j.clt?'CLT':'');
    res.json({runId,found:raw.length,compatible:jobs.length,jobs:jobs.slice(0,500)});
  } catch(e) { res.status(500).json({error:String(e.message||e)}); }
});

app.get('/api/run/:id/jobs',(req,res)=>res.json(getJobs(Number(req.params.id))));
async function processRun(runId,onlyErrors=false) {
  const run=getRun(runId); if(!run) throw new Error('Execução não encontrada');
  const resume=getResume(run.resume_id); const profile=parseJson(resume.profile_json,{});
  const prefs=parseJson(run.filters_json,{}); const dryRun=!prefs.autoSubmit;
  let jobs=getJobs(runId);
  if(onlyErrors){
    const ids=new Set(db.prepare("SELECT job_id FROM applications WHERE run_id=? AND status IN ('ERROR','NEEDS_DATA')").all(runId).map(x=>x.job_id));
    jobs=jobs.filter(x=>ids.has(x.id));
  }
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(onlyErrors?'RETRYING':'APPLYING',runId);
  let cursor=0;
  async function worker(){
    while(cursor<jobs.length){
      const job=jobs[cursor++];
      const old=db.prepare('SELECT * FROM applications WHERE run_id=? AND job_id=?').get(runId,job.id);
      if(old?.status==='SENT') continue;
      try{
        const tailored=await tailorResume(resume.stored_path,job,profile);
        const result=await applyToJob(job,tailored.file,profile,prefs,{dryRun});
        db.prepare(`INSERT INTO applications(run_id,job_id,status,tailored_file,error,submitted_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,job_id) DO UPDATE SET status=excluded.status,
          tailored_file=excluded.tailored_file,error=excluded.error,submitted_at=excluded.submitted_at`)
          .run(runId,job.id,result.status,tailored.file,result.error||'',result.status==='SENT'?new Date().toISOString():null);
      }catch(e){
        db.prepare(`INSERT INTO applications(run_id,job_id,status,error) VALUES(?,?,?,?)
          ON CONFLICT(run_id,job_id) DO UPDATE SET status='ERROR',error=excluded.error`)
          .run(runId,job.id,'ERROR',String(e.message||e).slice(0,500));
      }
    }
  }
  await Promise.all([worker(),worker(),worker()]);
  db.prepare('UPDATE runs SET status=? WHERE id=?').run('DONE',runId);
}

function startBackground(runId,onlyErrors){
  setImmediate(()=>processRun(runId,onlyErrors).catch(e=>{
    db.prepare('UPDATE runs SET status=? WHERE id=?').run(`ERROR: ${String(e.message||e).slice(0,120)}`,runId);
  }));
}

app.post('/api/run/:id/apply',(req,res)=>{
  const id=Number(req.params.id); if(!getRun(id)) return res.status(404).json({error:'Execução não encontrada'});
  startBackground(id,false); res.json({ok:true,runId:id});
});
app.post('/api/run/:id/retry',(req,res)=>{
  const id=Number(req.params.id); if(!getRun(id)) return res.status(404).json({error:'Execução não encontrada'});
  startBackground(id,true); res.json({ok:true,runId:id});
});
app.get('/api/run/:id/status',(req,res)=>{
  const id=Number(req.params.id); const run=getRun(id);
  if(!run) return res.status(404).json({error:'Execução não encontrada'});
  const counts=db.prepare('SELECT status,COUNT(*) count FROM applications WHERE run_id=? GROUP BY status').all(id);
  const total=db.prepare('SELECT COUNT(*) count FROM jobs WHERE run_id=?').get(id).count;
  res.json({runId:id,status:run.status,total,counts:Object.fromEntries(counts.map(x=>[x.status,x.count]))});
});

function reportRows(runId){
  return db.prepare(`SELECT a.status,j.title,j.location,j.salary,j.url,j.score FROM applications a
    JOIN jobs j ON j.id=a.job_id WHERE a.run_id=? ORDER BY j.score DESC`).all(runId).map(x=>({
      Enviado:x.status==='SENT'?'SIM':x.status,
      'Nome da vaga':x.title,
      Local:x.location||'',
      'Remuneração':x.salary||'',
      Link:x.url
    }));
}

app.get('/api/run/:id/export.xlsx',async(req,res)=>{
  const id=Number(req.params.id); const rows=reportRows(id);
  const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet('Candidaturas');
  ws.columns=[{header:'Enviado',key:'Enviado',width:16},{header:'Nome da vaga',key:'Nome da vaga',width:48},
    {header:'Local',key:'Local',width:28},{header:'Remuneração',key:'Remuneração',width:22},{header:'Link',key:'Link',width:60}];
  rows.forEach(r=>ws.addRow(r)); ws.getRow(1).font={bold:true}; ws.views=[{state:'frozen',ySplit:1}];
  const file=path.join(reportDir,`candidaturas_${id}.xlsx`); await wb.xlsx.writeFile(file); res.download(file);
});
app.get('/api/run/:id/export.csv',(req,res)=>{
  const rows=reportRows(Number(req.params.id));
  const cols=['Enviado','Nome da vaga','Local','Remuneração','Link'];
  const q=v=>'"'+String(v??'').replace(/"/g,'""').replace(/\r?\n/g,' ')+'"';
  const csv='\uFEFF'+[cols.join(','),...rows.map(r=>cols.map(c=>q(r[c])).join(','))].join('\n');
  res.type('text/csv').send(csv);
});

app.delete('/api/run/:id',(req,res)=>{
  const id=Number(req.params.id);
  for(const x of db.prepare('SELECT tailored_file FROM applications WHERE run_id=?').all(id)) if(x.tailored_file) fs.rmSync(x.tailored_file,{force:true});
  db.prepare('DELETE FROM applications WHERE run_id=?').run(id);
  db.prepare('DELETE FROM jobs WHERE run_id=?').run(id);
  db.prepare('DELETE FROM runs WHERE id=?').run(id);
  res.json({ok:true});
});

app.post('/api/reset',(req,res)=>{
  db.exec('DELETE FROM applications; DELETE FROM jobs; DELETE FROM runs; DELETE FROM resumes;');
  for(const dir of [uploadDir,generatedDir,reportDir]){
    for(const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir,name),{recursive:true,force:true});
  }
  res.json({ok:true});
});

app.listen(PORT,'127.0.0.1',()=>{
  console.log(`AUTOMACAO CURRICULO: http://127.0.0.1:${PORT}`);
  console.log(`PASTA DESTA EXECUÇÃO: ${runtime.session}`);
});

app.get('/api/run/:id/applications',(req,res)=>{
  const id=Number(req.params.id);
  const rows=db.prepare(`SELECT a.status,a.error,a.submitted_at,j.title,j.location,j.salary,j.url
    FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.run_id=? ORDER BY j.score DESC`).all(id);
  res.json(rows);
});
