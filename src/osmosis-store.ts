/**
 * Osmosis Phase 1 — KnowledgeAtom capture
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
}

export interface FailureAtom {
  type: 'failure';
  errorType: string;
  model: string;
  fallbackTaken: boolean;
  timestamp: number;
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
  timestamp INTEGER NOT NULL
);
`;

/** Lazy-initialised SQLite database handle, or null if unavailable. */
let _db: import('better-sqlite3').Database | null | undefined = undefined;
let _jsonlPath: string | null = null;
let _insertStmt: import('better-sqlite3').Statement | null = null;

function getRelayplaneDir(): string {
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
        (type, model, task_type, latency_ms, input_tokens, output_tokens, error_type, fallback_taken, timestamp)
      VALUES
        (@type, @model, @task_type, @latency_ms, @input_tokens, @output_tokens, @error_type, @fallback_taken, @timestamp)
    `);
  }
  return _db;
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
 */
export function captureAtom(atom: KnowledgeAtom): void {
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
        });
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
        });
      }
      return;
    }
    // SQLite unavailable — fall back to JSONL
    writeToJsonl(atom);
  } catch {
    // best-effort fallback
    try { writeToJsonl(atom); } catch { /* ignore */ }
  }
}

/** Exposed for testing — reset singleton state. */
export function _resetStore(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = undefined;
  _insertStmt = null;
  _jsonlPath = null;
}
