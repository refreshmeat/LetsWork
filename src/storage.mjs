import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = process.env.LETSWORK_DATA_ROOT || path.join(os.homedir(),'Documents','LetsWork');
export const storage = {
  root: ROOT,
  data: path.join(ROOT,'data'),
  candidates: path.join(ROOT,'candidatos'),
  temp: path.join(ROOT,'temp'),
  logs: path.join(ROOT,'logs')
};
for (const dir of Object.values(storage)) fs.mkdirSync(dir,{recursive:true});

export function candidateDir(id) {
  return path.join(storage.candidates,String(id));
}
export function ensureCandidateDirs(id) {
  const base=candidateDir(id);
  const dirs={
    base,
    resumes:path.join(base,'curriculos'),
    documents:path.join(base,'documentos'),
    generated:path.join(base,'curriculos_personalizados'),
    reports:path.join(base,'relatorios'),
    sessions:path.join(base,'sessoes_navegador')
  };
  for(const dir of Object.values(dirs)) fs.mkdirSync(dir,{recursive:true});
  return dirs;
}
