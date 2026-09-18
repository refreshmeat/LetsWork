import fs from 'fs';
import path from 'path';
import { db, json } from './db.mjs';
import { extractText, inferProfile, extractPreferredResumeFromZip } from './services/resume.mjs';
import { ensureCandidateDirs } from './storage.mjs';
import { cleanUploadFilename, safeFilename } from './utils/filename.mjs';

function docKind(name,isPrimary=false){
  if(isPrimary) return 'resume';
  const n=String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/portfolio|book|portifolio/.test(n)) return 'portfolio';
  if(/certif|diploma|curso|comprov/.test(n)) return 'certificate';
  return 'support';
}

export function registerMultiFileRoute(app,upload){
  app.post('/api/candidate/import',upload.array('files',12),async(req,res)=>{
    const staged=[];
    try{
      const files=req.files||[];
      if(!files.length) return res.status(400).json({error:'Nenhum arquivo recebido'});
      let primaryIndex=Number(req.body?.primaryIndex);
      if(!Number.isInteger(primaryIndex)||primaryIndex<0||primaryIndex>=files.length){
        primaryIndex=files.findIndex(f=>/(^|[_ -])(cv|curr[ií]culo|curriculum|resume)([_ .-]|$)/i.test(f.originalname));
        if(primaryIndex<0) primaryIndex=0;
      }
      for(let i=0;i<files.length;i++){
        const f=files[i]; f.originalname=cleanUploadFilename(f.originalname); const ext=path.extname(f.originalname||'');
        const staged=`${f.path}${ext}`;
        fs.renameSync(f.path,staged); f._staged=staged;
        f._text=await extractText(staged).catch(()=> '');
        f._kind=docKind(f.originalname,i===primaryIndex);
      }
      const primary=files[primaryIndex];
      const combined=[primary._text,...files.filter((_,i)=>i!==primaryIndex)
        .map(f=>`\n\n=== DOCUMENTO DE APOIO: ${f.originalname} ===\n${f._text}`)].join('');
      const profile=inferProfile(combined);
      const ext=path.extname(primary.originalname||'');
      const cname=profile.name||path.basename(primary.originalname,ext)||'Novo candidato';
      const ci=db.prepare('INSERT INTO candidates(name) VALUES(?)').run(cname);
      const candidateId=Number(ci.lastInsertRowid),dirs=ensureCandidateDirs(candidateId);
      let primaryPath=path.join(dirs.resumes,`original_${safeFilename(primary.originalname)}`);
      fs.copyFileSync(primary._staged,primaryPath);
      if(ext.toLowerCase()==='.zip'){
        const extracted=extractPreferredResumeFromZip(primary._staged,dirs.resumes);
        if(extracted) primaryPath=extracted;
        else {primaryPath=path.join(dirs.resumes,'curriculo_extraido.txt');fs.writeFileSync(primaryPath,primary._text,'utf8');}
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
      res.json({candidateId,resumeId:Number(info.lastInsertRowid),profile:{...full,rawText:undefined},chars:combined.length,
        documents:files.map((f,i)=>({name:f.originalname,kind:f._kind,isPrimary:i===primaryIndex}))});
    }catch(e){
      res.status(500).json({error:String(e.message||e)});
    }finally{
      for(const f of req.files||[]){
        if(f._staged) fs.rmSync(f._staged,{force:true}); else if(f.path) fs.rmSync(f.path,{force:true});
      }
    }
  });
}
