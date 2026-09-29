const fs=require('fs');
const path=require('path');

function applyPendingRestore(dataRoot,{log=()=>{},beforeApply=()=>{}}={}){
  const pendingFile=path.join(dataRoot,'restore-pending.json');
  if(!fs.existsSync(pendingFile))return false;
  let pending;
  try{pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));}
  catch(e){log('RESTORE inválido: '+String(e?.message||e));return false;}

  const staging=path.resolve(String(pending?.stagingPath||''));
  const tempRoot=path.resolve(path.join(dataRoot,'temp'));
  if(!staging.startsWith(tempRoot+path.sep)){log('RESTORE bloqueado: staging fora da pasta temporária');return false;}
  const stagedDb=path.join(staging,'data','letswork.sqlite');
  if(!fs.existsSync(stagedDb)){log('RESTORE bloqueado: banco do backup ausente');return false;}

  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const backupDir=path.join(dataRoot,'backups','pre-restore-'+stamp);
  try{
    beforeApply();
    fs.mkdirSync(backupDir,{recursive:true});
    const currentDb=path.join(dataRoot,'data','letswork.sqlite');
    if(fs.existsSync(currentDb))fs.copyFileSync(currentDb,path.join(backupDir,'letswork.sqlite'));
    const currentCandidates=path.join(dataRoot,'candidatos');
    if(fs.existsSync(currentCandidates))fs.cpSync(currentCandidates,path.join(backupDir,'candidatos'),{recursive:true});

    fs.mkdirSync(path.join(dataRoot,'data'),{recursive:true});
    for(const suffix of ['','-wal','-shm']){try{fs.rmSync(currentDb+suffix,{force:true});}catch{}}
    fs.copyFileSync(stagedDb,currentDb);
    fs.rmSync(currentCandidates,{recursive:true,force:true});
    const stagedCandidates=path.join(staging,'candidatos');
    if(fs.existsSync(stagedCandidates))fs.cpSync(stagedCandidates,currentCandidates,{recursive:true});
    else fs.mkdirSync(currentCandidates,{recursive:true});
    fs.rmSync(pendingFile,{force:true});
    fs.rmSync(staging,{recursive:true,force:true});
    log('RESTORE concluído. Cópia anterior preservada em '+backupDir);
    return true;
  }catch(e){
    log('RESTORE falhou: '+String(e?.stack||e));
    return false;
  }
}
module.exports={applyPendingRestore};
