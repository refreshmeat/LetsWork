import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.mjs';
import { storage } from '../storage.mjs';

const safeName=s=>String(s||'backup').replace(/[^a-zA-Z0-9._-]+/g,'_');

function addFolderFiltered(zip,root,zipRoot){
  if(!fs.existsSync(root))return;
  const walk=(dir,rel='')=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.name==='sessoes_navegador')continue;
      const full=path.join(dir,entry.name),nextRel=rel?rel+'/'+entry.name:entry.name;
      if(entry.isDirectory())walk(full,nextRel);
      else zip.addLocalFile(full,zipRoot+'/'+path.posix.dirname(nextRel),path.basename(entry.name));
    }
  };
  walk(root);
}


export function createPortableBackup(){
  fs.mkdirSync(storage.backups,{recursive:true});
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(storage.backups,`LetsWork-backup-${stamp}.zip`);
  const zip=new AdmZip();
  const manifest={format:'letswork-backup',version:3,createdAt:new Date().toISOString(),includes:['database','candidates'],excluded:['browser_sessions','live_inventory_cache'],inventoryCanRefresh:true,portablePaths:true};
  zip.addFile('letswork-backup.json',Buffer.from(JSON.stringify(manifest,null,2),'utf8'));
  const dbFile=path.join(storage.data,'letswork.sqlite');
  if(!fs.existsSync(dbFile))throw new Error('Banco local não encontrado');
  zip.addLocalFile(dbFile,'data','letswork.sqlite');
  if(fs.existsSync(storage.candidates))addFolderFiltered(zip,storage.candidates,'candidatos');
  zip.writeZip(file);
  return {file,name:path.basename(file),bytes:fs.statSync(file).size,manifest};
}

function validateEntryName(name){
  const normalized=String(name||'').replace(/\\/g,'/');
  if(!normalized||normalized.startsWith('/')||normalized.includes('../')||/^[a-zA-Z]:/.test(normalized))return false;
  return normalized==='letswork-backup.json'||normalized==='data/letswork.sqlite'||normalized.startsWith('candidatos/');
}


function rebaseCandidateFile(value){
  const raw=String(value||'').trim();
  if(!raw)return raw;
  const normalized=raw.replace(/\\/g,'/');
  const lower=normalized.toLowerCase();
  const marker='/candidatos/';
  const idx=lower.lastIndexOf(marker);
  if(idx<0)return raw;
  const rel=normalized.slice(idx+marker.length).split('/').filter(Boolean);
  return path.join(storage.candidates,...rel);
}
function rebaseRestorePaths(database){
  const specs=[
    ['resumes','stored_path'],
    ['resumes','base_resume_path'],
    ['documents','stored_path'],
    ['applications','tailored_file']
  ];
  database.exec('BEGIN');
  try{
    for(const [table,column] of specs){
      const rows=database.prepare(`SELECT id,${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>''`).all();
      const update=database.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`);
      for(const row of rows){
        const next=rebaseCandidateFile(row.value);
        if(next!==row.value)update.run(next,row.id);
      }
    }
    database.exec('COMMIT');
  }catch(e){
    try{database.exec('ROLLBACK');}catch{}
    throw e;
  }
}

export function preparePortableRestore(uploadFile){
  if(!uploadFile||!fs.existsSync(uploadFile))throw new Error('Arquivo de backup não encontrado');
  const zip=new AdmZip(uploadFile);
  const entries=zip.getEntries();
  if(!entries.length)throw new Error('Backup vazio');
  for(const entry of entries)if(!validateEntryName(entry.entryName))throw new Error('Backup contém caminho inválido: '+safeName(entry.entryName));
  const manifestEntry=zip.getEntry('letswork-backup.json');
  const dbEntry=zip.getEntry('data/letswork.sqlite');
  if(!manifestEntry||!dbEntry)throw new Error('Backup LetsWork inválido ou incompleto');
  const manifest=JSON.parse(manifestEntry.getData().toString('utf8'));
  if(manifest?.format!=='letswork-backup'||![1,2,3].includes(Number(manifest?.version)))throw new Error('Versão de backup não suportada');

  const staging=path.join(storage.temp,'restore-'+Date.now());
  fs.mkdirSync(staging,{recursive:true});
  for(const entry of entries){
    if(entry.isDirectory)continue;
    const dest=path.join(staging,...entry.entryName.replace(/\\/g,'/').split('/'));
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,entry.getData());
  }

  const stagedDb=path.join(staging,'data','letswork.sqlite');
  let probe;
  try{
    probe=new DatabaseSync(stagedDb);
    rebaseRestorePaths(probe);
    const candidateCount=Number(probe.prepare('SELECT COUNT(*) n FROM candidates').get()?.n||0);
    const resumeCount=Number(probe.prepare('SELECT COUNT(*) n FROM resumes').get()?.n||0);
    const applicationCount=Number(probe.prepare('SELECT COUNT(*) n FROM applications').get()?.n||0);
    probe.close();
    const pending={format:'letswork-restore-pending',version:1,createdAt:new Date().toISOString(),stagingPath:staging,summary:{candidateCount,resumeCount,applicationCount}};
    fs.writeFileSync(path.join(storage.root,'restore-pending.json'),JSON.stringify(pending,null,2),'utf8');
    return {ok:true,restartRequired:true,manifest,summary:pending.summary};
  }catch(e){
    try{probe?.close();}catch{}
    fs.rmSync(staging,{recursive:true,force:true});
    throw new Error('Banco do backup não pôde ser validado: '+String(e?.message||e));
  }
}
