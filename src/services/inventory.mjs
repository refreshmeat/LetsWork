import { db } from '../db.mjs';

const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const STOP=new Set('a o as os de da do das dos e em para por com sem um uma no na nos nas ao aos vaga vagas trabalho emprego pessoa pessoas area profissional'.split(' '));

function cutoffIso(days=30){
  const safe=Math.max(1,Math.min(30,Number(days)||30));
  return new Date(Date.now()-safe*86400000).toISOString();
}

function ftsQuery(terms=[]){
  const tokens=[];
  for(const term of Array.isArray(terms)?terms:[]){
    for(const token of norm(term).split(/\s+/)){
      if(token.length<3||STOP.has(token))continue;
      if(!tokens.includes(token))tokens.push(token);
      if(tokens.length>=36)break;
    }
    if(tokens.length>=36)break;
  }
  return tokens.map(x=>x.replace(/"/g,'')+'*').join(' OR ');
}

export function queryRioInventory(days=15,terms=[],limit=25000){
  const cutoff=cutoffIso(days),requested=Math.max(1,Number(limit)||25000);
  const all=db.prepare(`SELECT id AS inventoryId,source,title,company,salary,location,url,description,
    contract_type AS contractType,published_at AS publishedAt,external_id AS externalId,
    1 AS loginFreeCandidate,1 AS broadCollection
    FROM job_inventory
    WHERE source='RioVagas' AND active=1 AND datetime(published_at)>=datetime(?)
    ORDER BY datetime(published_at) DESC LIMIT 25000`).all(cutoff);
  const query=ftsQuery(terms);
  if(!query||!all.length)return all.slice(0,requested);
  try{
    const ranked=db.prepare(`SELECT ji.id,bm25(job_inventory_fts,8.0,2.0,1.5,1.0) AS rank
      FROM job_inventory_fts
      JOIN job_inventory ji ON ji.id=job_inventory_fts.rowid
      WHERE job_inventory_fts MATCH ?
        AND ji.source='RioVagas' AND ji.active=1 AND datetime(ji.published_at)>=datetime(?)
      ORDER BY rank LIMIT ?`).all(query,cutoff,Math.min(all.length,12000));
    const order=new Map(ranked.map((x,i)=>[Number(x.id),{i,rank:Number(x.rank)}]));
    all.sort((a,b)=>{
      const ar=order.get(Number(a.inventoryId)),br=order.get(Number(b.inventoryId));
      if(ar&&br)return ar.i-br.i;
      if(ar)return -1;
      if(br)return 1;
      return Date.parse(String(b.publishedAt||''))-Date.parse(String(a.publishedAt||''));
    });
    for(const row of all){
      const hit=order.get(Number(row.inventoryId));
      row.ftsRank=hit?hit.rank:null;
    }
  }catch(e){
    console.log('[FTS] consulta falhou; usando inventario por data:',String(e?.message||e));
  }
  return all.slice(0,requested);
}

export function terminalInventoryIds(candidateId){
  return new Set(db.prepare(`SELECT inventory_id
    FROM candidate_job_matches
    WHERE candidate_id=? AND decision IN ('SENT','ALREADY_APPLIED','UNCERTAIN')`).all(Number(candidateId)).map(x=>Number(x.inventory_id)).filter(Boolean));
}

export function upsertCandidateMatch({candidateId,inventoryId,runId=null,score=0,decision='SEEN',reason='',rankPosition=0,batchNo=0}){
  if(!Number(candidateId)||!Number(inventoryId))return;
  db.prepare(`INSERT INTO candidate_job_matches
    (candidate_id,inventory_id,run_id,score,decision,reason,rank_position,batch_no,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(candidate_id,inventory_id) DO UPDATE SET
      run_id=excluded.run_id,score=excluded.score,
      decision=CASE WHEN candidate_job_matches.decision IN ('SENT','ALREADY_APPLIED','UNCERTAIN') THEN candidate_job_matches.decision ELSE excluded.decision END,
      reason=CASE WHEN candidate_job_matches.decision IN ('SENT','ALREADY_APPLIED','UNCERTAIN') THEN candidate_job_matches.reason ELSE excluded.reason END,
      rank_position=excluded.rank_position,batch_no=excluded.batch_no,last_seen_at=CURRENT_TIMESTAMP`)
    .run(Number(candidateId),Number(inventoryId),runId?Number(runId):null,Number(score)||0,String(decision||'SEEN'),String(reason||''),Number(rankPosition)||0,Number(batchNo)||0);
}

export function updateCandidateMatchStatus(candidateId,inventoryId,status,reason='',runId=null){
  if(!Number(candidateId)||!Number(inventoryId))return;
  upsertCandidateMatch({candidateId,inventoryId,runId,decision:String(status||'SEEN'),reason});
}

export function recordRunEvent({runId=null,candidateId=null,type,data={}}){
  try{
    db.prepare('INSERT INTO run_events(run_id,candidate_id,event_type,data_json) VALUES(?,?,?,?)')
      .run(runId?Number(runId):null,candidateId?Number(candidateId):null,String(type||'EVENT'),JSON.stringify(data??{}));
  }catch{}
}

export function runMetrics(runId){
  const jobs=db.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN sendable=1 THEN 1 ELSE 0 END) sendable,
    SUM(CASE WHEN selected=1 THEN 1 ELSE 0 END) selected,
    SUM(CASE WHEN blocked_reason='AI_REVIEW_PENDING' THEN 1 ELSE 0 END) ai_pending
    FROM jobs WHERE run_id=?`).get(Number(runId))||{};
  const apps=db.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN status='SENT' THEN 1 ELSE 0 END) sent,
    SUM(CASE WHEN status='ALREADY_APPLIED' THEN 1 ELSE 0 END) already_applied,
    SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) errors,
    SUM(CASE WHEN status='NEEDS_DATA' THEN 1 ELSE 0 END) needs_data,
    SUM(CASE WHEN status='PROFILE_REQUIRED' THEN 1 ELSE 0 END) profile_required,
    SUM(CASE WHEN status='INVALID_FORM' THEN 1 ELSE 0 END) invalid_form,
    SUM(CASE WHEN status='UNCERTAIN' THEN 1 ELSE 0 END) uncertain,
    SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) closed
    FROM applications WHERE run_id=?`).get(Number(runId))||{};
  return {jobs,applications:apps};
}

export function sourceRegistry(){
  return db.prepare("SELECT * FROM source_registry WHERE source_key='rio' ORDER BY name").all();
}
