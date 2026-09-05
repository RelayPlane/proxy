/**
 * Osmosis Phase 1, KnowledgeAtom capture
 *
 * Stores per-request atoms in ~/.relayplane/osmosis.db (SQLite via better-sqlite3).
 * Falls back to ~/.relayplane/osmosis.jsonl if SQLite is unavailable.
 *
 * All writes are fire-and-forget; errors are silently swallowed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SuccessAtom {
  type: 'success';
  model: string;
  taskType: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
  classifierSource?: 'regex' | 'sidecar';
  classifierConfidence?: number;
  classifierRecommendedModel?: string;
}

export interface FailureAtom {
  type: 'failure';
  errorType: string;
  model: string;
  fallbackTaken: boolean;
  timestamp: number;
  classifierSource?: 'regex' | 'sidecar';
  classifierConfidence?: number;
  classifierRecommendedModel?: string;
}

export type KnowledgeAtom = SuccessAtom | FailureAtom;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  model TEXT,
  task_type TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_type TEXT,
  fallback_taken INTEGER,
  timestamp INTEGER NOT NULL,
  session_id TEXT,
  confidence REAL DEFAULT 0.5,
  observation_count INTEGER DEFAULT 1,
  decay_rate REAL DEFAULT 0.05,
  tags TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS episodic_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration_ms INTEGER,
  model_used TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  tool_name TEXT,
  tool_input_hash TEXT,
  outcome TEXT NOT NULL,
  outcome_detail TEXT,
  trace_id TEXT,
  tags TEXT DEFAULT '[]',
  run_id TEXT,
  agent_label TEXT,
  thread_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_events(session_id);
CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_events(timestamp);

CREATE TABLE IF NOT EXISTS episodic_to_procedural_candidates (
  id TEXT PRIMARY KEY,
  pattern_signature TEXT NOT NULL UNIQUE,
  session_ids TEXT DEFAULT '[]',
  evidence_count INTEGER DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  promoted_at INTEGER,
  atom_id TEXT
);
`;

// Migrations for pre-existing DBs that lack newer columns.
// SQLite does not support IF NOT EXISTS for ADD COLUMN; we catch errors silently.
const COLUMN_MIGRATIONS = [
  `ALTER TABLE knowledge_atoms ADD COLUMN session_id TEXT`,
  `ALTER TABLE knowledge_atoms ADD COLUMN confidence REAL DEFAULT 0.5`,
  `ALTER TABLE knowledge_atoms ADD COLUMN observation_count INTEGER DEFAULT 1`,
  `ALTER TABLE knowledge_atoms ADD COLUMN decay_rate REAL DEFAULT 0.05`,
  `ALTER TABLE knowledge_atoms ADD COLUMN tags TEXT DEFAULT '[]'`,
  // Run attribution (PR1): run chip on the dashboard RequestStream
  `ALTER TABLE episodic_events ADD COLUMN run_id TEXT`,
  `ALTER TABLE episodic_events ADD COLUMN agent_label TEXT`,
  `ALTER TABLE episodic_events ADD COLUMN thread_id TEXT`,
];

/** Lazy-initialised SQLite database handle, or null if unavailable. */
let _db: import('better-sqlite3').Database | null | undefined = undefined;
let _jsonlPath: string | null = null;
let _insertStmt: import('better-sqlite3').Statement | null = null;

export function getRelayplaneDir(): string {
  // RELAYPLANE_HOME_OVERRIDE is used in tests to avoid writing to ~/.relayplane
  const override = process.env['RELAYPLANE_HOME_OVERRIDE'];
  const base = override ?? os.homedir();
  return path.join(base, '.relayplane');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function initDb(): import('better-sqlite3').Database | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const dir = getRelayplaneDir();
    ensureDir(dir);
    const dbPath = path.join(dir, 'osmosis.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA_SQL);
    // Column migrations for pre-existing DBs; errors are swallowed (column already exists).
    for (const sql of COLUMN_MIGRATIONS) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }
    return db;
  } catch {
    return null;
  }
}

function getDb(): import('better-sqlite3').Database | null {
  if (_db !== undefined) return _db;
  _db = initDb();
  if (_db) {
    _insertStmt = _db.prepare(`
      INSERT INTO knowledge_atoms
        (type, model, task_type, latency_ms, input_tokens, output_tokens, error_type, fallback_taken, timestamp, session_id)
      VALUES
        (@type, @model, @task_type, @latency_ms, @input_tokens, @output_tokens, @error_type, @fallback_taken, @timestamp, @session_id)
    `);
  }
  return _db;
}

/** Exposed for use by episode-writer and memory endpoints. */
export function getOsmosisDb(): import('better-sqlite3').Database | null {
  return getDb();
}

/** Count knowledge atoms relevant to a session (or all atoms if no session). */
export function countAtomsForSession(sessionId?: string | null): number {
  try {
    const db = getDb();
    if (!db) return 0;
    if (sessionId) {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM knowledge_atoms WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM knowledge_atoms`).get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getJsonlPath(): string {
  if (_jsonlPath) return _jsonlPath;
  const dir = getRelayplaneDir();
  ensureDir(dir);
  _jsonlPath = path.join(dir, 'osmosis.jsonl');
  return _jsonlPath;
}

function writeToJsonl(atom: KnowledgeAtom): void {
  try {
    fs.appendFileSync(getJsonlPath(), JSON.stringify(atom) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * Capture a KnowledgeAtom (fire-and-forget).
 * Never throws. Writes to SQLite; falls back to JSONL.
 *
 * @param atom - The knowledge atom to capture.
 * @param sessionId - Optional session ID to associate with this atom.
 */
export function captureAtom(atom: KnowledgeAtom, sessionId?: string): void {
  try {
    const db = getDb();
    if (db && _insertStmt) {
      if (atom.type === 'success') {
        _insertStmt.run({
          type: atom.type,
          model: atom.model ?? null,
          task_type: atom.taskType ?? null,
          latency_ms: atom.latencyMs,
          input_tokens: atom.inputTokens,
          output_tokens: atom.outputTokens,
          error_type: null,
          fallback_taken: null,
          timestamp: atom.timestamp,
          session_id: sessionId ?? null,
        });
        // Update confidence on repeat observations for same (model, task_type).
        if (atom.model && atom.taskType) {
          try {
            db.prepare(
              `UPDATE knowledge_atoms SET observation_count = observation_count + 1, confidence = MIN(1.0, confidence + 0.1)
               WHERE type = 'success' AND model = ? AND task_type = ? AND id != last_insert_rowid()`
            ).run(atom.model, atom.taskType);
          } catch { /* best-effort */ }
        }
      } else {
        _insertStmt.run({
          type: atom.type,
          model: atom.model ?? null,
          task_type: null,
          latency_ms: null,
          input_tokens: null,
          output_tokens: null,
          error_type: atom.errorType ?? null,
          fallback_taken: atom.fallbackTaken ? 1 : 0,
          timestamp: atom.timestamp,
          session_id: sessionId ?? null,
        });
      }
      return;
    }
    // SQLite unavailable, fall back to JSONL
    writeToJsonl(atom);
  } catch {
    // best-effort fallback
    try { writeToJsonl(atom); } catch { /* ignore */ }
  }
}

/** Exposed for testing; resets singleton state. */
export function _resetStore(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = undefined;
  _insertStmt = null;
  _jsonlPath = null;
}
