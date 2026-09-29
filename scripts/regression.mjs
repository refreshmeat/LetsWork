import fs from 'fs';
import path from 'path';
import { db } from '../src/db.mjs';
import { queryRioInventory, sourceRegistry } from '../src/services/inventory.mjs';

function assert(condition,message){
  if(!condition)throw new Error(message);
}
function scalar(sql,...args){
  return Number(db.prepare(sql).get(...args)?.n||0);
}

const sources=sourceRegistry();
const enabled=sources.filter(x=>Number(x.enabled)===1);
assert(enabled.length===1&&enabled[0].source_key==='rio','Somente RioVagas pode estar habilitado');
assert(enabled[0].apply_mode==='DIRECT_HTTP'&&Number(enabled[0].login_required)===0,'RioVagas deve ser DIRECT_HTTP e sem login');

const inventoryCount=scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1");
assert(inventoryCount>0,'Inventário RioVagas está vazio');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE active=1 AND source<>'RioVagas'")===0,'Há fonte ativa diferente de RioVagas no inventário');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND url NOT LIKE '%riovagas.com.br/riovagas/%'")===0,'Inventário ativo contém URL que não é vaga direta RioVagas');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND datetime(published_at)<datetime('now','-30 days')")===0,'Há vaga ativa com mais de 30 dias');
assert(scalar("SELECT COUNT(*) n FROM (SELECT url,COUNT(*) c FROM job_inventory WHERE source='RioVagas' GROUP BY url HAVING c>1)")===0,'Há URL duplicada no inventário');

const counts={};
for(const days of [7,15,30]){
  counts[days]=scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND datetime(published_at)>=datetime(?)",new Date(Date.now()-days*86400000).toISOString());
}
assert(counts[7]<=counts[15]&&counts[15]<=counts[30],'Janelas 7/15/30 estão inconsistentes');

const ftsHits=scalar("SELECT COUNT(*) n FROM job_inventory_fts WHERE job_inventory_fts MATCH 'auxiliar'");
assert(ftsHits>0,'FTS5 não retorna resultados esperados');
const ftsSample=queryRioInventory(30,['auxiliar'],100);
assert(ftsSample.length>0&&ftsSample.some(x=>Number.isFinite(x.ftsRank)),'Consulta BM25 não priorizou nenhuma vaga');

const applicationRunMismatch=scalar(`
  SELECT COUNT(*) n FROM applications a
  JOIN jobs j ON j.id=a.job_id
  WHERE a.run_id<>j.run_id
`);
assert(applicationRunMismatch===0,'Há candidatura ligada a job de outro run');

const runCandidateMismatch=scalar(`
  SELECT COUNT(*) n FROM runs r
  JOIN resumes x ON x.id=r.resume_id
  WHERE r.candidate_id<>x.candidate_id
`);
assert(runCandidateMismatch===0,'Há run ligado a currículo de outro candidato');

const matchOrphans=scalar(`
  SELECT COUNT(*) n FROM candidate_job_matches m
  LEFT JOIN candidates c ON c.id=m.candidate_id
  LEFT JOIN job_inventory i ON i.id=m.inventory_id
  WHERE c.id IS NULL OR i.id IS NULL
`);
assert(matchOrphans===0,'Há associação candidato-vaga órfã');

const jobInventoryOrphans=scalar(`
  SELECT COUNT(*) n FROM jobs j
  LEFT JOIN job_inventory i ON i.id=j.inventory_id
  WHERE j.inventory_id IS NOT NULL AND i.id IS NULL
`);
assert(jobInventoryOrphans===0,'Há job ligado a inventory_id inexistente');

const receiptCandidateMismatch=scalar(`
  SELECT COUNT(*) n
  FROM application_receipts x
  JOIN applications a ON a.id=x.application_id
  JOIN runs r ON r.id=a.run_id
  WHERE x.candidate_id<>r.candidate_id
`);
assert(receiptCandidateMismatch===0,'Há recibo ligado ao candidato errado');

const receiptJobMismatch=scalar(`
  SELECT COUNT(*) n
  FROM application_receipts x
  JOIN applications a ON a.id=x.application_id
  JOIN jobs j ON j.id=a.job_id
  WHERE x.inventory_id IS NOT NULL AND j.inventory_id IS NOT NULL AND x.inventory_id<>j.inventory_id
`);
assert(receiptJobMismatch===0,'Há recibo ligado à vaga errada');

for(const file of ['src/server.mjs','src/services/jobs.mjs','src/apply/rio.mjs']){
  const text=fs.readFileSync(path.resolve(file),'utf8');
  assert(!/from\s+['"]playwright-core['"]/.test(text),'Playwright voltou ao runtime ativo: '+file);
  assert(!/from\s+['"]\.\/sources\//.test(text),'Fonte legada voltou ao runtime ativo: '+file);
}

console.log(JSON.stringify({
  ok:true,
  source:enabled[0].name,
  inventoryCount,
  windows:counts,
  ftsHits,
  applicationRunMismatch,
  runCandidateMismatch,
  matchOrphans,
  jobInventoryOrphans,
  receiptCandidateMismatch,
  receiptJobMismatch
}));
