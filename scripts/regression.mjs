import fs from 'fs';
import path from 'path';
import { db } from '../src/db.mjs';
import { queryRioInventory, sourceRegistry } from '../src/services/inventory.mjs';
import { prefilterJobsForAI } from '../src/services/ranking.mjs';
import { knownAnswer, aiAnswers } from '../src/apply/answers.mjs';

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

assert(!fs.existsSync(path.resolve('src/apply/engine.mjs')),'Motor legado de navegador voltou ao projeto');
assert(!fs.existsSync(path.resolve('src/sources')),'Pasta de fontes legadas voltou ao projeto');
const packageText=fs.readFileSync(path.resolve('package.json'),'utf8');
assert(!packageText.includes('playwright-core'),'Playwright voltou às dependências');

for(const file of ['src/server.mjs','src/services/jobs.mjs','src/apply/rio.mjs']){
  const text=fs.readFileSync(path.resolve(file),'utf8');
  assert(!/from\s+['"]playwright-core['"]/.test(text),'Playwright voltou ao runtime ativo: '+file);
  assert(!/from\s+['"]\.\/sources\//.test(text),'Fonte legada voltou ao runtime ativo: '+file);
}

const syntheticDesignFilters={
  nationwide:false,state:'RJ',city:'Rio de Janeiro',cities:['Rio de Janeiro'],states:['RJ'],locationScope:'state_priority',
  area:'Design, UX/UI e Design Gráfico',workMode:'include_remote',pcdMode:'exclude',experienceLevel:'entry',recencyDays:30,
  contractTypes:['CLT','PJ','ESTAGIO','TEMPORARIO','APRENDIZ','FREELANCE'],
  searchFamilies:['Design','UX/UI','UI'],searchCoreTerms:['designer gráfico','ux','ui'],
  searchAdjacentTerms:['marketing digital','criação visual'],searchLiteralTerms:['figma','photoshop','canva'],
  searchTargetTerms:['designer gráfico','ux','ui','criação visual']
};
const syntheticDesignProfile={rawText:'Bacharelado em Design em andamento. Figma Photoshop Canva UX UI.',skills:['Figma','Photoshop','Canva','UX','UI','Design']};
const syntheticJobs=[
  {source:'RioVagas',title:'Designer Gráfico Júnior',description:'Criação de peças visuais, Figma, Photoshop e materiais digitais.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/design-grafico-junior',publishedAt:new Date().toISOString(),contractType:'CLT'},
  {source:'RioVagas',title:'Assistente de Projetos - Móveis Planejados',description:'Atendimento ao cliente, projeto de móveis planejados e Promob. Ambiente de design.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/moveis-planejados',publishedAt:new Date().toISOString(),contractType:'CLT'},
  {source:'RioVagas',title:'Ajudante de Marcenaria',description:'Apoio à produção de mobiliário e peças de design.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/ajudante-marcenaria',publishedAt:new Date().toISOString(),contractType:'CLT'}
];
const syntheticRanked=prefilterJobsForAI(syntheticJobs,syntheticDesignProfile,syntheticDesignFilters);
assert(syntheticRanked.some(x=>/Designer Gráfico Júnior/i.test(x.title)),'Vaga válida de Design foi rejeitada pela regressão sintética');
assert(!syntheticRanked.some(x=>/Marcenaria|Móveis Planejados/i.test(x.title)),'Domínio de marcenaria/móveis vazou para perfil de Design');

const syntheticMaria={
  address:'Rua Virginia Vidal 148',neighborhood:'Tanque',residenceCity:'Rio de Janeiro',residenceState:'RJ',
  rawText:'ENSINO MÉDIO\nCompleto - Colégio Estadual Bangu\nIDIOMAS\nInglês Básico\nEspanhol Básico\nEXPERIÊNCIA\nAtendimento presencial e remoto.'
};
const mariaPrefs={city:'Rio de Janeiro',state:'RJ'};
assert(/Ensino Médio/i.test(String(knownAnswer('Qual a sua escolaridade ?',syntheticMaria,mariaPrefs)||'')),'Escolaridade conhecida deixou de ser reconhecida');
assert(/Tanque|Rio de Janeiro/i.test(String(knownAnswer('Em qual cidade e bairro você reside?',syntheticMaria,mariaPrefs)||'')),'Cidade/bairro conhecidos deixaram de ser reconhecidos');
const languageAnswers=await aiAnswers([{id:'1',question:'Tem Inglês intermediário',options:['Sim','Não']}],syntheticMaria,mariaPrefs,null);
assert(languageAnswers.get('1')==='Não','Nível de idioma inferior ao exigido não foi respondido com segurança');
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
