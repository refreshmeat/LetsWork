import { DatabaseSync } from 'node:sqlite';
import { runtime } from './runtime.mjs';

export const db = new DatabaseSync(`${runtime.data}\\runtime.sqlite`);

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'NEW',
  filters_json TEXT NOT NULL,
  resume_id INTEGER
);
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT,
  stored_path TEXT,
  extracted_text TEXT,
  profile_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
db.exec(`
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
  UNIQUE(run_id, url)
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  job_id INTEGER,
  status TEXT DEFAULT 'PENDING',
  tailored_file TEXT,
  error TEXT,
  submitted_at TEXT,
  UNIQUE(run_id, job_id)
);
`);
export const json = value => JSON.stringify(value ?? null);
export const parseJson = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
