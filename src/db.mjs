import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { storage } from './storage.mjs';

export const db = new DatabaseSync(path.join(storage.data,'letswork.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'Sem nome',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER,
  original_name TEXT,
  stored_path TEXT,
  extracted_text TEXT,
  profile_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'support',
  original_name TEXT,
  stored_path TEXT,
  extracted_text TEXT,
  is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'NEW',
  filters_json TEXT NOT NULL,
  resume_id INTEGER,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
`);db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  source TEXT,
  source_key TEXT,
  title TEXT,
  company TEXT,
  salary TEXT,
  location TEXT,
  url TEXT,
  description TEXT,
  score REAL,
  pcd INTEGER DEFAULT 0,
  remote INTEGER DEFAULT 0,
  contract_type TEXT,
  UNIQUE(run_id, url),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  job_id INTEGER,
  status TEXT DEFAULT 'PENDING',
  tailored_file TEXT,
  error TEXT,
  submitted_at TEXT,
  UNIQUE(run_id, job_id),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
`);function hasColumn(table,column){
  return db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column);
}
function addColumn(table,column,sql){
  if(!hasColumn(table,column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
}
addColumn('candidates','import_fingerprint','TEXT');
addColumn('resumes','candidate_id','INTEGER');
addColumn('resumes','base_resume_path','TEXT');
addColumn('resumes','base_resume_text','TEXT');
addColumn('resumes','base_resume_focus','TEXT');
addColumn('resumes','base_resume_updated_at','TEXT');
addColumn('resumes','base_resume_template',"TEXT DEFAULT 'executive'");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_import_fingerprint ON candidates(import_fingerprint) WHERE import_fingerprint IS NOT NULL AND import_fingerprint<>'';");
addColumn('runs','candidate_id','INTEGER');
addColumn('jobs','published_at','TEXT');
addColumn('jobs','sendable','INTEGER DEFAULT 1');
addColumn('jobs','blocked_reason',"TEXT DEFAULT ''");
addColumn('jobs','selected','INTEGER DEFAULT 0');
addColumn('jobs','batch_no','INTEGER DEFAULT 0');
addColumn('jobs','rank_position','INTEGER DEFAULT 0');
addColumn('jobs','inventory_id','INTEGER');
addColumn('jobs','provider_job_id',"TEXT DEFAULT ''");
addColumn('runs','active_batch','INTEGER DEFAULT 1');
db.exec(`
CREATE TABLE IF NOT EXISTS candidate_job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT,
  url TEXT,
  title TEXT,
  company TEXT,
  location TEXT,
  published_at TEXT,
  first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'SEEN',
  last_run_id INTEGER,
  UNIQUE(candidate_id,fingerprint),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidate_job_history_candidate ON candidate_job_history(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_job_history_status ON candidate_job_history(candidate_id,status);

CREATE TABLE IF NOT EXISTS job_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT DEFAULT '',
  salary TEXT DEFAULT '',
  location TEXT DEFAULT '',
  description TEXT DEFAULT '',
  contract_type TEXT DEFAULT '',
  published_at TEXT NOT NULL,
  first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1,
  apply_mode TEXT DEFAULT 'DIRECT_HTTP',
  UNIQUE(source,url)
);
CREATE INDEX IF NOT EXISTS idx_job_inventory_source_date ON job_inventory(source,published_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_inventory_active_date ON job_inventory(active,published_at DESC);


CREATE TABLE IF NOT EXISTS source_sync_state (
  source TEXT PRIMARY KEY,
  last_sync_at TEXT,
  last_full_sync_at TEXT,
  coverage_days INTEGER DEFAULT 0,
  last_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_registry (
  source_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  discovery_mode TEXT NOT NULL,
  apply_mode TEXT NOT NULL,
  login_required INTEGER DEFAULT 0,
  status TEXT DEFAULT 'DISABLED',
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candidate_job_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  run_id INTEGER,
  score REAL DEFAULT 0,
  decision TEXT DEFAULT 'SEEN',
  reason TEXT DEFAULT '',
  rank_position INTEGER DEFAULT 0,
  batch_no INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(candidate_id,inventory_id),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
  FOREIGN KEY(inventory_id) REFERENCES job_inventory(id) ON DELETE CASCADE,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_job_matches_candidate ON candidate_job_matches(candidate_id,decision);
CREATE INDEX IF NOT EXISTS idx_candidate_job_matches_inventory ON candidate_job_matches(inventory_id);

CREATE TABLE IF NOT EXISTS application_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  inventory_id INTEGER,
  provider TEXT NOT NULL,
  provider_job_id TEXT DEFAULT '',
  confirmation_type TEXT NOT NULL,
  http_status INTEGER,
  response_url TEXT DEFAULT '',
  response_hash TEXT DEFAULT '',
  confirmation_text TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
  FOREIGN KEY(inventory_id) REFERENCES job_inventory(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_application_receipts_app ON application_receipts(application_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  candidate_id INTEGER,
  event_type TEXT NOT NULL,
  data_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id,id);
`);
addColumn('job_inventory','canonical_url',"TEXT DEFAULT ''");
addColumn('job_inventory','content_hash',"TEXT DEFAULT ''");
addColumn('candidate_job_history','provider_job_id',"TEXT DEFAULT ''");

db.exec("DROP TABLE IF EXISTS candidate_job_pool;");
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_inventory ON jobs(inventory_id);");
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_provider_job ON jobs(source,provider_job_id);");
db.exec("CREATE INDEX IF NOT EXISTS idx_history_provider_job ON candidate_job_history(candidate_id,source,provider_job_id);");
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_source_external_unique ON job_inventory(source,external_id) WHERE external_id IS NOT NULL AND external_id<>''");}catch{}
try{
  db.prepare(`UPDATE jobs SET provider_job_id=COALESCE((SELECT external_id FROM job_inventory WHERE id=jobs.inventory_id),'')
    WHERE COALESCE(provider_job_id,'')='' AND inventory_id IS NOT NULL`).run();
  db.prepare(`UPDATE candidate_job_history
    SET provider_job_id=COALESCE((
      SELECT j.provider_job_id FROM jobs j
      WHERE j.run_id=candidate_job_history.last_run_id AND j.source_key=candidate_job_history.fingerprint
      LIMIT 1
    ),'')
    WHERE COALESCE(provider_job_id,'')=''`).run();
}catch{}

db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS job_inventory_fts USING fts5(
  title,company,location,description,
  content='job_inventory',content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS job_inventory_ai AFTER INSERT ON job_inventory BEGIN
  INSERT INTO job_inventory_fts(rowid,title,company,location,description)
  VALUES(new.id,new.title,new.company,new.location,new.description);
END;
CREATE TRIGGER IF NOT EXISTS job_inventory_ad AFTER DELETE ON job_inventory BEGIN
  INSERT INTO job_inventory_fts(job_inventory_fts,rowid,title,company,location,description)
  VALUES('delete',old.id,old.title,old.company,old.location,old.description);
END;
CREATE TRIGGER IF NOT EXISTS job_inventory_au AFTER UPDATE OF title,company,location,description ON job_inventory BEGIN
  INSERT INTO job_inventory_fts(job_inventory_fts,rowid,title,company,location,description)
  VALUES('delete',old.id,old.title,old.company,old.location,old.description);
  INSERT INTO job_inventory_fts(rowid,title,company,location,description)
  VALUES(new.id,new.title,new.company,new.location,new.description);
END;`);
db.exec(`CREATE TABLE IF NOT EXISTS system_meta (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
try{
  const ftsVersion=String(db.prepare("SELECT value FROM system_meta WHERE key='job_inventory_fts_version'").get()?.value||'');
  if(ftsVersion!=='1'){
    db.exec("INSERT INTO job_inventory_fts(job_inventory_fts) VALUES('rebuild')");
    db.prepare("INSERT INTO system_meta(key,value,updated_at) VALUES('job_inventory_fts_version','1',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=CURRENT_TIMESTAMP").run();
  }
}catch{}
db.prepare(`INSERT INTO source_registry(source_key,name,enabled,discovery_mode,apply_mode,login_required,status,notes,updated_at)
  VALUES('rio','RioVagas',1,'HTTP_JSON','DIRECT_HTTP',0,'VALIDATED','Fonte direta via HTTP',CURRENT_TIMESTAMP)
  ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,enabled=1,discovery_mode=excluded.discovery_mode,
    apply_mode=excluded.apply_mode,login_required=0,status='VALIDATED',notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).run();

db.prepare(`INSERT INTO source_registry(source_key,name,enabled,discovery_mode,apply_mode,login_required,status,notes,updated_at)
  VALUES('jobbol','Jobbol',1,'HTTP_JSON','SEARCH_ONLY',0,'VALIDATED','Busca e triagem por HTTP; envio automatico por script suspenso enquanto a sessao/CSRF exigir pagina protegida',CURRENT_TIMESTAMP)
  ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,enabled=1,discovery_mode=excluded.discovery_mode,
    apply_mode=excluded.apply_mode,login_required=0,status='VALIDATED',notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).run();

export const json = value => JSON.stringify(value ?? null);
export const parseJson = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export function candidateSummary(){
  return db.prepare(`SELECT c.id,c.name,c.created_at,c.updated_at,
    (SELECT COUNT(*) FROM runs r WHERE r.candidate_id=c.id) runs,
    (SELECT COUNT(*) FROM applications a JOIN runs r ON r.id=a.run_id
      WHERE r.candidate_id=c.id AND a.status='SENT') sent
    FROM candidates c ORDER BY c.updated_at DESC,c.id DESC`).all();
}
