import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { db, json } from './db.mjs';
import { extractText, inferProfile, extractPreferredResumeFromZip } from './services/resume.mjs';
import { ensureCandidateDirs, candidateDir } from './storage.mjs';
import { cleanUploadFilename, safeFilename } from './utils/filename.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function docKind(name,isPrimary=false){
  if(isPrimary) return 'resume';
  const n=String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/portfolio|book|portifolio/.test(n)) return 'portfolio';
  if(/certif|diploma|curso|comprov/.test(n)) return 'certificate';
  return 'support';
}

function fileSha256(file){
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function importFingerprint(files,primaryIndex){
  const primary=files[primaryIndex]?._sha256||'';
  const support=files.filter((_,i)=>i!==primaryIndex).map(f=>f._sha256||'').filter(Boolean).sort();
  return createHash('sha256').update(JSON.stringify({version:1,primary,support})).digest('hex');
}

function existingImport(fingerprint){
  return db.prepare(`
    SELECT c.id candidate_id,c.name,
      (SELECT r.id FROM resumes r WHERE r.candidate_id=c.id ORDER BY r.id DESC LIMIT 1) resume_id
    FROM candidates c
    WHERE c.import_fingerprint=?
    LIMIT 1
  `).get(fingerprint);
}

async function waitForExistingImport(fingerprint,timeoutMs=12000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const row=existingImport(fingerprint);
    if(row?.resume_id)return row;
    await sleep(180);
  }
  return existingImport(fingerprint);
}

export function registerMultiFileRoute(app,upload){
  app.post('/api/candidate/import',upload.array('files',12),async(req,res)=>{
    let createdCandidateId=0;
    try{
      const files=req.files||[];
      if(!files.length) return res.status(400).json({error:'Nenhum arquivo recebido'});
      let primaryIndex=Number(req.body?.primaryIndex);
      if(!Number.isInteger(primaryIndex)||primaryIndex<0||primaryIndex>=files.length){
        primaryIndex=files.findIndex(f=>/(^|[_ -])(cv|curr[ií]culo|curriculum|resume)([_ .-]|$)/i.test(f.originalname));
        if(primaryIndex<0) primaryIndex=0;
      }

      for(let i=0;i<files.length;i++){
        const f=files[i];
        f.originalname=cleanUploadFilename(f.originalname);
        const ext=path.extname(f.originalname||'');
        const staged=`${f.path}${ext}`;
        fs.renameSync(f.path,staged);
        f._staged=staged;
        f._sha256=fileSha256(staged);
        f._text=await extractText(staged).catch(()=> '');
        f._kind=docKind(f.originalname,i===primaryIndex);
      }

      const fingerprint=importFingerprint(files,primaryIndex);
      const already=existingImport(fingerprint);
      if(already?.resume_id){
        return res.json({
          candidateId:Number(already.candidate_id),
          resumeId:Number(already.resume_id),
          deduplicated:true,
          message:'Este mesmo conjunto de arquivos já estava cadastrado.'
        });
      }

      const primary=files[primaryIndex];
      const combined=[primary._text,...files.filter((_,i)=>i!==primaryIndex)
        .map(f=>`\n\n=== DOCUMENTO DE APOIO: ${f.originalname} ===\n${f._text}`)].join('');
      const profile=inferProfile(combined);
      const ext=path.extname(primary.originalname||'');
      const cname=profile.name||path.basename(primary.originalname,ext)||'Novo candidato';

      const ci=db.prepare('INSERT OR IGNORE INTO candidates(name,import_fingerprint) VALUES(?,?)').run(cname,fingerprint);
      if(Number(ci.changes||0)===0){
        const duplicate=await waitForExistingImport(fingerprint);
        if(duplicate?.resume_id){
          return res.json({
            candidateId:Number(duplicate.candidate_id),
            resumeId:Number(duplicate.resume_id),
            deduplicated:true,
            message:'A importação duplicada foi ignorada.'
          });
        }
        throw new Error('Este mesmo candidato já está sendo importado. Aguarde a importação atual terminar.');
      }

      const candidateId=Number(ci.lastInsertRowid);
      createdCandidateId=candidateId;
      const dirs=ensureCandidateDirs(candidateId);

      let primaryPath=path.join(dirs.resumes,`original_${safeFilename(primary.originalname)}`);
      fs.copyFileSync(primary._staged,primaryPath);
      if(ext.toLowerCase()==='.zip'){
        const extracted=extractPreferredResumeFromZip(primary._staged,dirs.resumes);
        if(extracted) primaryPath=extracted;
        else {
          primaryPath=path.join(dirs.resumes,'curriculo_extraido.txt');
          fs.writeFileSync(primaryPath,primary._text,'utf8');
        }
      }

      const insDoc=db.prepare('INSERT INTO documents(candidate_id,kind,original_name,stored_path,extracted_text,is_primary) VALUES(?,?,?,?,?,?)');
      for(let i=0;i<files.length;i++){
        const f=files[i];
        const dest=path.join(dirs.documents,`${i===primaryIndex?'principal':'apoio'}_${i+1}_${safeFilename(f.originalname)}`);
        fs.copyFileSync(f._staged,dest);
        insDoc.run(candidateId,f._kind,f.originalname,dest,f._text,i===primaryIndex?1:0);
      }

      const full={...profile,candidateId};
      const info=db.prepare('INSERT INTO resumes(candidate_id,original_name,stored_path,extracted_text,profile_json) VALUES(?,?,?,?,?)')
        .run(candidateId,primary.originalname,primaryPath,combined,json(full));

      res.json({
        candidateId,
        resumeId:Number(info.lastInsertRowid),
        profile:{...full,rawText:undefined},
        chars:combined.length,
        deduplicated:false,
        documents:files.map((f,i)=>({name:f.originalname,kind:f._kind,isPrimary:i===primaryIndex}))
      });
    }catch(e){
      if(createdCandidateId){
        try{db.prepare('DELETE FROM candidates WHERE id=?').run(createdCandidateId);}catch{}
        try{fs.rmSync(candidateDir(createdCandidateId),{recursive:true,force:true});}catch{}
      }
      res.status(500).json({error:String(e.message||e)});
    }finally{
      for(const f of req.files||[]){
        try{
          if(f._staged) fs.rmSync(f._staged,{force:true});
          else if(f.path) fs.rmSync(f.path,{force:true});
        }catch{}
      }
    }
  });
}
