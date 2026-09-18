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
addColumn('resumes','candidate_id','INTEGER');
addColumn('runs','candidate_id','INTEGER');
addColumn('jobs','published_at','TEXT');
addColumn('jobs','sendable','INTEGER DEFAULT 1');
addColumn('jobs','blocked_reason',"TEXT DEFAULT ''");
addColumn('jobs','selected','INTEGER DEFAULT 0');
addColumn('jobs','batch_no','INTEGER DEFAULT 0');
addColumn('jobs','rank_position','INTEGER DEFAULT 0');
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

CREATE TABLE IF NOT EXISTS candidate_job_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  source TEXT, url TEXT, title TEXT, company TEXT, location TEXT, salary TEXT, description TEXT,
  contract_type TEXT, published_at TEXT, score REAL DEFAULT 0, sendable INTEGER DEFAULT 0,
  blocked_reason TEXT DEFAULT '', last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(candidate_id,fingerprint), FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidate_job_pool_candidate ON candidate_job_pool(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_job_pool_sendable ON candidate_job_pool(candidate_id,sendable,blocked_reason);
`);

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
