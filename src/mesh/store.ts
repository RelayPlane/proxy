/**
 * Osmosis Knowledge Mesh — Local SQLite Store
 * Adapted from ~/osmosis/packages/core/src/store/
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { KnowledgeAtom, AtomType } from './types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS atoms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  observation TEXT NOT NULL,
  context TEXT NOT NULL,
  confidence REAL NOT NULL,
  fitness_score REAL NOT NULL,
  trust_tier TEXT NOT NULL DEFAULT 'quarantine',
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
  last_used TEXT,
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
CREATE INDEX IF NOT EXISTS idx_atoms_fitness ON atoms(fitness_score);
CREATE INDEX IF NOT EXISTS idx_atoms_synced ON atoms(synced);
CREATE INDEX IF NOT EXISTS idx_atoms_updated_at ON atoms(updated_at);
`;

const SYNC_META_SQL = `
CREATE TABLE IF NOT EXISTS sync_meta (
  peer_url TEXT PRIMARY KEY,
  last_push_at TEXT,
  last_pull_at TEXT
);
`;

export class MeshStore {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
    this.db.exec(SYNC_META_SQL);
  }

  /** Insert atom, returns it */
  insert(data: Omit<KnowledgeAtom, 'id' | 'created_at' | 'updated_at'>): KnowledgeAtom {
    const now = new Date().toISOString();
    const atom: KnowledgeAtom = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      evidence_count: 1,
      use_count: 0,
      success_after_use: 0,
      failure_after_use: 0,
      synced: false,
      ...data,
    };
    this.db.prepare(`
      INSERT INTO atoms (id, type, observation, context, confidence, fitness_score,
        trust_tier, source_agent_hash, created_at, updated_at, decay_rate,
        tool_name, params_hash, outcome, error_signature, latency_ms, reliability_score,
        anti_pattern, failure_cluster_size, error_type, severity,
        evidence_count, use_count, success_after_use, failure_after_use, last_used, synced)
      VALUES (@id, @type, @observation, @context, @confidence, @fitness_score,
        @trust_tier, @source_agent_hash, @created_at, @updated_at, @decay_rate,
        @tool_name, @params_hash, @outcome, @error_signature, @latency_ms, @reliability_score,
        @anti_pattern, @failure_cluster_size, @error_type, @severity,
        @evidence_count, @use_count, @success_after_use, @failure_after_use, @last_used, @synced)
    `).run({
      ...atom,
      synced: atom.synced ? 1 : 0,
      tool_name: atom.tool_name ?? null,
      params_hash: atom.params_hash ?? null,
      outcome: atom.outcome ?? null,
      error_signature: atom.error_signature ?? null,
      latency_ms: atom.latency_ms ?? null,
      reliability_score: atom.reliability_score ?? null,
      anti_pattern: atom.anti_pattern ?? null,
      failure_cluster_size: atom.failure_cluster_size ?? null,
      error_type: atom.error_type ?? null,
      severity: atom.severity ?? null,
      last_used: atom.last_used ?? null,
    });
    return atom;
  }

  getById(id: string): KnowledgeAtom | null {
    return (this.db.prepare('SELECT * FROM atoms WHERE id = ?').get(id) as KnowledgeAtom) ?? null;
  }

  getAll(): KnowledgeAtom[] {
    return this.db.prepare('SELECT * FROM atoms').all() as KnowledgeAtom[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM atoms').get() as { cnt: number };
    return row.cnt;
  }

  countSynced(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM atoms WHERE synced = 1').get() as { cnt: number };
    return row.cnt;
  }

  /** Get atoms not yet synced */
  getUnsynced(): KnowledgeAtom[] {
    return this.db.prepare('SELECT * FROM atoms WHERE synced = 0').all() as KnowledgeAtom[];
  }

  /** Mark atoms as synced */
  markSynced(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE atoms SET synced = 1 WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  }

  /** Update fitness score */
  updateFitness(id: string, score: number): void {
    this.db.prepare('UPDATE atoms SET fitness_score = ?, updated_at = ? WHERE id = ?')
      .run(score, new Date().toISOString(), id);
  }

  /** Get top atoms by fitness */
  getTopByFitness(limit: number = 20): KnowledgeAtom[] {
    return this.db.prepare('SELECT * FROM atoms ORDER BY fitness_score DESC LIMIT ?').all(limit) as KnowledgeAtom[];
  }

  // Sync meta helpers
  getLastPushAt(peerUrl: string): string | null {
    const row = this.db.prepare('SELECT last_push_at FROM sync_meta WHERE peer_url = ?').get(peerUrl) as any;
    return row?.last_push_at ?? null;
  }

  setLastPushAt(peerUrl: string, ts: string): void {
    this.db.prepare(`
      INSERT INTO sync_meta (peer_url, last_push_at) VALUES (?, ?)
      ON CONFLICT(peer_url) DO UPDATE SET last_push_at = excluded.last_push_at
    `).run(peerUrl, ts);
  }

  getLastPullAt(peerUrl: string): string | null {
    const row = this.db.prepare('SELECT last_pull_at FROM sync_meta WHERE peer_url = ?').get(peerUrl) as any;
    return row?.last_pull_at ?? null;
  }

  setLastPullAt(peerUrl: string, ts: string): void {
    this.db.prepare(`
      INSERT INTO sync_meta (peer_url, last_pull_at) VALUES (?, ?)
      ON CONFLICT(peer_url) DO UPDATE SET last_pull_at = excluded.last_pull_at
    `).run(peerUrl, ts);
  }

  getLastSyncTime(peerUrl: string): string | null {
    const row = this.db.prepare('SELECT MAX(last_push_at, last_pull_at) as ts FROM sync_meta WHERE peer_url = ?').get(peerUrl) as any;
    return row?.ts ?? null;
  }

  close(): void {
    this.db.close();
  }
}
