import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../src/db.mjs';
import { optimizeBaseResume } from '../src/services/tailor.mjs';

function assert(condition,message){
  if(!condition)throw new Error(message);
}

const applicationRunMismatch=db.prepare(`
  SELECT COUNT(*) n
  FROM applications a
  JOIN jobs j ON j.id=a.job_id
  WHERE a.run_id<>j.run_id
`).get().n;
assert(applicationRunMismatch===0,`Há ${applicationRunMismatch} candidatura(s) ligada(s) a job de outro run`);

const runCandidateMismatch=db.prepare(`
  SELECT COUNT(*) n
  FROM runs r
  JOIN resumes x ON x.id=r.resume_id
  WHERE r.candidate_id<>x.candidate_id
`).get().n;
assert(runCandidateMismatch===0,`Há ${runCandidateMismatch} run(s) ligado(s) a currículo de outro candidato`);

const orphanApps=db.prepare(`
  SELECT COUNT(*) n
  FROM applications a
  LEFT JOIN runs r ON r.id=a.run_id
  LEFT JOIN jobs j ON j.id=a.job_id
  WHERE r.id IS NULL OR j.id IS NULL
`).get().n;
assert(orphanApps===0,`Há ${orphanApps} candidatura(s) órfã(s)`);

const sentByCandidate=db.prepare(`
  SELECT r.candidate_id,COUNT(*) n
  FROM applications a
  JOIN runs r ON r.id=a.run_id
  WHERE a.status IN ('SENT','ALREADY_APPLIED')
  GROUP BY r.candidate_id
`).all();
for(const row of sentByCandidate){
  assert(Number(row.candidate_id)>0,'Candidatura enviada sem candidato válido');
}

const tmpRoot=fs.mkdtempSync(path.join(os.tmpdir(),'letswork-smoke-'));
try{
  const resumes=path.join(tmpRoot,'curriculos');
  fs.mkdirSync(resumes,{recursive:true});
  const source=path.join(resumes,'curriculo.txt');
  const raw=[
    'PESSOA TESTE',
    'OBJETIVO PROFISSIONAL',
    'Atendimento ao cliente e apoio administrativo.',
    'FORMAÇÃO ACADÊMICA',
    'Ensino Médio - Escola Exemplo',
    'Concluído',
    'EXPERIÊNCIAS PROFISSIONAIS',
    'Empresa Exemplo',
    'Atendente | 2022 - 2024',
    'Atendimento ao cliente e organização de demandas.',
    'CERTIFICAÇÕES E IDIOMAS',
    'Inglês - Básico',
    'Curso de informática - Escola Técnica'
  ].join('\n');
  fs.writeFileSync(source,raw,'utf8');
  const result=await optimizeBaseResume(source,{
    candidateId:999999,
    name:'Pessoa Teste',
    rawText:raw,
    skills:['atendimento','administrativo'],
    supportDocuments:[]
  },'Atendimento ao cliente e apoio administrativo');

  assert(result?.file&&fs.existsSync(result.file),'Smoke: currículo-base não foi criado');
  assert(result.validation?.resumePages===1,'Smoke: currículo-base deveria ter 1 página');
  assert(result.validation?.portfolioPages===0,'Smoke: portfólio não pode ser anexado ao currículo-base');
  assert((result.content?.education||[]).some(x=>/Ensino Médio/i.test(x)),'Smoke: formação acadêmica não foi extraída');
  assert((result.content?.experience||[]).length>=1,'Smoke: experiência profissional não foi extraída');
} finally {
  fs.rmSync(tmpRoot,{recursive:true,force:true});
}

console.log(JSON.stringify({
  ok:true,
  applicationRunMismatch,
  runCandidateMismatch,
  orphanApps,
  sentByCandidate
}));
