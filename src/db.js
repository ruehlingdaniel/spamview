const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SPAMVIEW_DB || path.join(__dirname, 'spamview.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  unix_time INTEGER NOT NULL,
  rspamd_id TEXT,
  ip TEXT,
  helo TEXT,
  envelope_from TEXT,
  envelope_to TEXT,
  display_from TEXT,
  subject TEXT,
  action TEXT,
  score REAL,
  required_score REAL,
  symbols_json TEXT,
  reason TEXT,
  category TEXT,
  size INTEGER,
  raw TEXT,
  body TEXT,
  fingerprint TEXT UNIQUE,
  fetched_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_rejects_time ON rejects(unix_time DESC);
CREATE INDEX IF NOT EXISTS idx_rejects_source ON rejects(source);
CREATE INDEX IF NOT EXISTS idx_rejects_category ON rejects(category);
CREATE INDEX IF NOT EXISTS idx_rejects_ip ON rejects(ip);
CREATE INDEX IF NOT EXISTS idx_rejects_from ON rejects(envelope_from);

CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  inserted INTEGER DEFAULT 0,
  message TEXT
);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_summary TEXT,
  response TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aicache_kind ON ai_cache(kind);
CREATE INDEX IF NOT EXISTS idx_aicache_created ON ai_cache(created_at DESC);
`);

module.exports = db;
