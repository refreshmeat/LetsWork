const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const {pathToFileURL}=require('url');
const {DatabaseSync}=require('node:sqlite');
const {applyPendingRestore}=require('../desktop/restore.cjs');

function fail(msg){throw new Error(msg);}
const project=path.resolve(__dirname,'..');
const realRoot='C:\\Users\\RefreshMeat\\LetsWork\\dados';
const backupDir=path.join(realRoot,'backups');
const backups=fs.existsSync(backupDir)?fs.readdirSync(backupDir).filter(x=>/^LetsWork-backup-.*\.zip$/i.test(x)).map(name=>({name,file:path.join(backupDir,name),mtime:fs.statSync(path.join(backupDir,name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime):[];
if(!backups.length)fail('Nenhum backup portátil encontrado para teste de restauração');
const backup=backups[0].file;
const target=path.join(project,'restore-regression-root');
fs.rmSync(target,{recursive:true,force:true});
fs.mkdirSync(target,{recursive:true});

const moduleUrl=pathToFileURL(path.join(project,'src','services','backup.mjs')).href;
const code=`
  import { preparePortableRestore } from ${JSON.stringify(moduleUrl)};
  const r=preparePortableRestore(${JSON.stringify(backup)});
  console.log('RESULT '+JSON.stringify(r));
`;
const stage=spawnSync(process.execPath,['--input-type=module','-e',code],{
  cwd:project,
  env:{...process.env,LETSWORK_DATA_ROOT:target},
  encoding:'utf8',
  windowsHide:true
});
if(stage.status!==0)fail('Preparação do restore falhou: '+(stage.stderr||stage.stdout));
const line=String(stage.stdout||'').split(/\r?\n/).find(x=>x.startsWith('RESULT '));
if(!line)fail('Preparação do restore não retornou resultado');
const prepared=JSON.parse(line.slice(7));
if(!prepared.ok||!prepared.restartRequired)fail('Backup não foi aceito para restauração');

const logs=[];
const applied=applyPendingRestore(target,{log:x=>logs.push(String(x))});
if(!applied)fail('Aplicação do restore isolado falhou');

const dbFile=path.join(target,'data','letswork.sqlite');
if(!fs.existsSync(dbFile))fail('Banco restaurado ausente');
const db=new DatabaseSync(dbFile,{readOnly:true});
const counts={
  candidates:Number(db.prepare('SELECT COUNT(*) n FROM candidates').get()?.n||0),
  resumes:Number(db.prepare('SELECT COUNT(*) n FROM resumes').get()?.n||0),
  applications:Number(db.prepare('SELECT COUNT(*) n FROM applications').get()?.n||0)
};
if(counts.candidates!==Number(prepared.summary.candidateCount))fail('Contagem de candidatos divergente');
if(counts.resumes!==Number(prepared.summary.resumeCount))fail('Contagem de currículos divergente');
if(counts.applications!==Number(prepared.summary.applicationCount))fail('Contagem de candidaturas divergente');

const paths=[
  ...db.prepare("SELECT stored_path value FROM resumes WHERE stored_path<>'' UNION ALL SELECT base_resume_path FROM resumes WHERE base_resume_path<>''").all(),
  ...db.prepare("SELECT stored_path value FROM documents WHERE stored_path<>''").all()
].map(x=>String(x.value||''));
db.close();
const candidateRoot=path.resolve(path.join(target,'candidatos')).toLowerCase();
const wrong=paths.filter(x=>!path.resolve(x).toLowerCase().startsWith(candidateRoot+path.sep));
if(wrong.length)fail('Restore manteve caminhos absolutos do PC anterior: '+wrong.slice(0,3).join(' | '));
const missing=paths.filter(x=>!fs.existsSync(x));
if(missing.length)fail('Restore aponta para arquivos inexistentes: '+missing.slice(0,3).join(' | '));
if(fs.existsSync(path.join(target,'restore-pending.json')))fail('Marcador de restore não foi removido');
if(!fs.existsSync(path.join(target,'backups')))fail('Diretório de proteção pré-restore não foi criado');

const result={ok:true,backup:path.basename(backup),manifestVersion:prepared.manifest.version,counts,rebasedPaths:paths.length,missingFiles:0,wrongPaths:0,logs};
console.log(JSON.stringify(result));
fs.rmSync(target,{recursive:true,force:true});
