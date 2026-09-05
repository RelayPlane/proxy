/**
 * Episode Writer, Phase 2 Session 4: Layered Session Memory
 *
 * Writes episodic events to osmosis.db after each proxied response.
 * Also tracks promotion candidates: when evidence_count >= PROMOTION_THRESHOLD,
 * promotes the pattern to the procedural (mesh) atom store.
 *
 * All writes are fire-and-forget. Never throws.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRelayplaneDir } from './osmosis-store.js';
import { runCtx } from './run-attribution.js';

const PROMOTION_THRESHOLD = 2;
const EPISODIC_MAX_ROWS = parseInt(process.env['RELAYPLANE_EPISODIC_MAX_ROWS'] ?? '100000', 10);
let _writeCounter = 0;

// ── DB handles ──────────────────────────────────────────────────────────────

let _osmosisDb: import('better-sqlite3').Database | null | undefined = undefined;
let _meshDb: import('better-sqlite3').Database | null | undefined = undefined;

function getOsmosisDb(): import('better-sqlite3').Database | null {
  if (_osmosisDb !== undefined) return _osmosisDb;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const dir = getRelayplaneDir();
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'osmosis.db'));
    db.pragma('journal_mode = WAL');
    _osmosisDb = db;
    return db;
  } catch {
    _osmosisDb = null;
    return null;
  }
}

function getMeshDb(): import('better-sqlite3').Database | null {
  if (_meshDb !== undefined) return _meshDb;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const dir = getRelayplaneDir();
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'mesh.db'));
    db.pragma('journal_mode = WAL');
    // Minimal atoms schema compatible with mesh-core AtomStore
    db.exec(`
      CREATE TABLE IF NOT EXISTS atoms (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        observation TEXT NOT NULL,
        context TEXT NOT NULL,
        confidence REAL NOT NULL,
        fitness_score REAL NOT NULL,
        trust_tier TEXT NOT NULL DEFAULT 'local',
        source_agent_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decay_rate REAL NOT NULL DEFAULT 0.99,
        tool_name TEXT,
        params_hash TEXT,
        outcome TEXT,
        error_signature TEXT,
        latency_ms REAL,
        reliability_score REAL,
        anti_pattern TEXT,
        failure_cluster_size INTEGER,
        error_type TEXT,
        severity TEXT,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        success_after_use INTEGER NOT NULL DEFAULT 0,
        failure_after_use INTEGER NOT NULL DEFAULT 0,
        last_used TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
      CREATE INDEX IF NOT EXISTS idx_atoms_confidence ON atoms(confidence);
      CREATE INDEX IF NOT EXISTS idx_atoms_fitness ON atoms(fitness_score);
    `);
    _meshDb = db;
    return db;
  } catch {
    _meshDb = null;
    return null;
  }
}

// ── Event types ──────────────────────────────────────────────────────────────

export type EpisodeEventType =
  | 'tool-call'
  | 'model-response'
  | 'cost-checkpoint'
  | 'routing-decision'
  | 'error';

export interface EpisodeEvent {
  eventType: EpisodeEventType;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  outcome: 'success' | 'failure';
  outcomeDetail?: string;
  traceId?: string;
  durationMs?: number;
  /** Run attribution; defaults from the request's runCtx when omitted. */
  runId?: string;
  agentLabel?: string;
  threadId?: string;
}

// ── Write episode ─────────────────────────────────────────────────────────────

/**
 * Write an episodic event record. Fire-and-forget, never throws.
 */
export function writeEpisode(sessionId: string, event: EpisodeEvent): void {
  try {
    const db = getOsmosisDb();
    if (!db) return;
    const id = crypto.randomUUID();
    const rc = runCtx.getStore();
    db.prepare(`
      INSERT OR IGNORE INTO episodic_events
        (id, session_id, event_type, timestamp, duration_ms, model_used,
         tokens_in, tokens_out, cost_usd, outcome, outcome_detail, trace_id,
         run_id, agent_label, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      event.eventType,
      Date.now(),
      event.durationMs ?? null,
      event.modelUsed,
      event.tokensIn,
      event.tokensOut,
      event.costUsd,
      event.outcome,
      event.outcomeDetail ?? null,
      event.traceId ?? null,
      event.runId ?? rc?.runId ?? null,
      event.agentLabel ?? rc?.agentLabel ?? null,
      event.threadId ?? rc?.threadId ?? null,
    );

    // Prune episodic_events every 100th write
    _writeCounter++;
    if (_writeCounter % 100 === 0) {
      db.prepare(`
        DELETE FROM episodic_events WHERE id NOT IN (
          SELECT id FROM episodic_events ORDER BY timestamp DESC LIMIT ?
        )
      `).run(EPISODIC_MAX_ROWS);
    }

    // Check promotion after each write
    const signature = computeSignature(event.modelUsed, event.eventType, event.outcome);
    checkPromotion(sessionId, signature);
  } catch {
    // best-effort
  }
}

// ── Promotion ─────────────────────────────────────────────────────────────────

function computeSignature(model: string, eventType: string, outcome: string): string {
  return crypto.createHash('sha256')
    .update(`${model}:${eventType}:${outcome}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Check and potentially promote an episodic pattern to procedural (mesh) store.
 * Fire-and-forget, never throws.
 */
function checkPromotion(sessionId: string, patternSignature: string): void {
  try {
    const db = getOsmosisDb();
    if (!db) return;

    const now = Date.now();

    // Check if candidate exists
    const existing = db.prepare(
      `SELECT id, evidence_count, session_ids, promoted_at FROM episodic_to_procedural_candidates WHERE pattern_signature = ?`
    ).get(patternSignature) as { id: string; evidence_count: number; session_ids: string; promoted_at: number | null } | undefined;

    if (!existing) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT OR IGNORE INTO episodic_to_procedural_candidates
          (id, pattern_signature, session_ids, evidence_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(id, patternSignature, JSON.stringify([sessionId]), now, now);
      return;
    }

    // Update existing candidate
    const sessionIds: string[] = (() => {
      try { return JSON.parse(existing.session_ids) as string[]; } catch { return []; }
    })();
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);

    db.prepare(`
      UPDATE episodic_to_procedural_candidates
      SET evidence_count = evidence_count + 1,
          last_seen_at = ?,
          session_ids = ?
      WHERE pattern_signature = ?
    `).run(now, JSON.stringify(sessionIds), patternSignature);

    const newCount = existing.evidence_count + 1;
    if (newCount >= PROMOTION_THRESHOLD && !existing.promoted_at) {
      const atomId = promoteToProcedural(patternSignature, newCount);
      if (atomId) {
        db.prepare(`
          UPDATE episodic_to_procedural_candidates
          SET promoted_at = ?, atom_id = ?
          WHERE pattern_signature = ?
        `).run(now, atomId, patternSignature);
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Write a procedural atom to the mesh db. Returns the atom id or null on failure.
 */
function promoteToProcedural(patternSignature: string, evidenceCount: number): string | null {
  try {
    const db = getMeshDb();
    if (!db) return null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const confidence = Math.min(1.0, 0.5 + evidenceCount * 0.1);
    const observation = `Recurring pattern observed ${evidenceCount} times (sig: ${patternSignature.slice(0, 8)})`;

    db.prepare(`
      INSERT OR IGNORE INTO atoms
        (id, type, observation, context, confidence, fitness_score, trust_tier,
         source_agent_hash, created_at, updated_at, decay_rate, evidence_count)
      VALUES (?, 'pattern', ?, ?, ?, ?, 'local', ?, ?, ?, 0.99, ?)
    `).run(
      id,
      observation,
      JSON.stringify({ patternSignature, promotedFromEpisodic: true }),
      confidence,
      confidence * 0.9,
      'relayplane-proxy',
      now,
      now,
      evidenceCount,
    );

    return id;
  } catch {
    return null;
  }
}

/** Exposed for testing, reset singleton db handles. */
export function _resetEpisodeWriter(): void {
  if (_osmosisDb) { try { _osmosisDb.close(); } catch { /* ignore */ } }
  if (_meshDb) { try { _meshDb.close(); } catch { /* ignore */ } }
  _osmosisDb = undefined;
  _meshDb = undefined;
}
