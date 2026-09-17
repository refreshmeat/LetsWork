import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const EXECUTIONS = path.join(ROOT, 'execucoes');
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const session = path.join(EXECUTIONS, `EXECUCAO_${stamp}_${process.pid}`);

export const runtime = {
  root: ROOT,
  executions: EXECUTIONS,
  session,
  data: path.join(session, 'data'),
  uploads: path.join(session, 'uploads'),
  generated: path.join(session, 'curriculos_personalizados'),
  reports: path.join(session, 'relatorios'),
  sessions: path.join(session, 'sessoes_navegador')
};

for (const dir of Object.values(runtime)) {
  if (typeof dir === 'string' && dir.startsWith(session)) fs.mkdirSync(dir, { recursive:true });
}
fs.mkdirSync(EXECUTIONS, { recursive:true });
