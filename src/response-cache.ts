/**
 * RelayPlane Response Cache — Phase 1: Exact Match
 *
 * Caches LLM API responses locally to avoid duplicate API calls.
 * SHA-256 hash of canonical request → cached response.
 *
 * Features:
 * - In-memory LRU + disk persistence (~/.relayplane/cache/)
 * - SQLite index for metadata (hit counts, cost tracking, TTL)
 * - Gzipped response bodies on disk
 * - Configurable TTL with task-type overrides
 * - Only caches deterministic requests (temperature=0)
 * - Skips responses containing tool calls
 *
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

// ─── Types ───────────────────────────────────────────────────────────

export interface CacheConfig {
  enabled?: boolean;
  /** Max in-memory cache size in MB (default: 100) */
  maxSizeMb?: number;
  /** Default TTL in seconds (default: 3600 = 1 hour) */
  defaultTtlSeconds?: number;
  /** Per-task-type TTL overrides in seconds */
  ttlByTaskType?: Record<string, number>;
  /** Only cache when temperature=0 or unset (default: true) */
  onlyWhenDeterministic?: boolean;
  /** Cache directory (default: ~/.relayplane/cache) */
  cacheDir?: string;
  /** Cache mode: "exact" (default) or "aggressive" */
  mode?: 'exact' | 'aggressive';
  /** TTL for aggressive mode in seconds (default: 1800 = 30 min) */
  aggressiveMaxAge?: number;
}

interface ResolvedCacheConfig {
  enabled: boolean;
  maxSizeMb: number;
  defaultTtlSeconds: number;
  ttlByTaskType: Record<string, number>;
  onlyWhenDeterministic: boolean;
  cacheDir: string;
  mode: 'exact' | 'aggressive';
  aggressiveMaxAge: number;
}

const DEFAULTS: ResolvedCacheConfig = {
  enabled: true,
  maxSizeMb: 100,
  defaultTtlSeconds: 3600,
  ttlByTaskType: {},
  onlyWhenDeterministic: true,
  cacheDir: path.join(os.homedir(), '.relayplane', 'cache'),
  mode: 'exact',
  aggressiveMaxAge: 1800,
};

function resolveCache(cfg?: Partial<CacheConfig>): ResolvedCacheConfig {
  return {
    enabled: cfg?.enabled ?? DEFAULTS.enabled,
    maxSizeMb: cfg?.maxSizeMb ?? DEFAULTS.maxSizeMb,
    defaultTtlSeconds: cfg?.defaultTtlSeconds ?? DEFAULTS.defaultTtlSeconds,
    ttlByTaskType: cfg?.ttlByTaskType ?? DEFAULTS.ttlByTaskType,
    onlyWhenDeterministic: cfg?.onlyWhenDeterministic ?? DEFAULTS.onlyWhenDeterministic,
    cacheDir: cfg?.cacheDir ?? DEFAULTS.cacheDir,
    mode: cfg?.mode ?? DEFAULTS.mode,
    aggressiveMaxAge: cfg?.aggressiveMaxAge ?? DEFAULTS.aggressiveMaxAge,
  };
}

export interface CacheSetOptions {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  taskType?: string;
}

export interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  hits: number;
  misses: number;
  bypasses: number;
  hitRate: number;
  savedCostUsd: number;
  savedRequests: number;
  byModel: Record<string, { hits: number; entries: number; savedCostUsd: number }>;
  byTaskType: Record<string, { hits: number; entries: number; savedCostUsd: number }>;
}

// ─── Cache Key Generation ────────────────────────────────────────────

/**
 * Fields included in the cache key (sorted alphabetically for determinism).
 */
const CACHE_KEY_FIELDS = [
  'max_tokens',
  'messages',
  'model',
  'stop_sequences',
  'system',
  'temperature',
  'tool_choice',
  'tools',
  'top_k',
  'top_p',
] as const;

/**
 * Generate a SHA-256 cache key from a request body.
 * Only includes fields that affect the response content.
 * Excluded: stream, provider headers, API keys.
 */
export function computeCacheKey(requestBody: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const field of CACHE_KEY_FIELDS) {
    if (requestBody[field] !== undefined) {
      canonical[field] = requestBody[field];
    }
  }
  // Use stable JSON serialization (sorted top-level keys, full depth)
  const sortedKeys = Object.keys(canonical).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of sortedKeys) ordered[k] = canonical[k];
  const json = JSON.stringify(ordered);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Fields included in the aggressive cache key.
 * Ignores conversation history — only uses system prompt + last user message + model + tools.
 */
const AGGRESSIVE_KEY_FIELDS = ['model', 'system', 'tools'] as const;

/**
 * Generate an aggressive cache key from a request body.
 * Uses: system prompt + last user message + model + tools.
 * Ignores: full conversation history, temperature, max_tokens, etc.
 */
export function computeAggressiveCacheKey(requestBody: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};

  for (const field of AGGRESSIVE_KEY_FIELDS) {
    if (requestBody[field] !== undefined) {
      canonical[field] = requestBody[field];
    }
  }

  // Extract last user message only
  const messages = requestBody['messages'] as Array<Record<string, unknown>> | undefined;
  if (messages && messages.length > 0) {
    // Find last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!['role'] === 'user') {
        canonical['last_user_message'] = messages[i]!['content'];
        break;
      }
    }
  }

  const sortedKeys = Object.keys(canonical).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of sortedKeys) ordered[k] = canonical[k];
  const json = JSON.stringify(ordered);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Check if a request is deterministic (temperature=0 or unset).
 */
export function isDeterministic(requestBody: Record<string, unknown>): boolean {
  const temp = requestBody['temperature'];
  return temp === undefined || temp === null || temp === 0;
}

/**
 * Check if a response contains tool calls.
 * Note: We still cache tool call responses — agent workloads are almost
 * entirely tool calls, and identical requests should return cached results.
 * The caller decides whether to use this check.
 */
export function responseHasToolCalls(responseBody: Record<string, unknown>): boolean {
  // OpenAI format: choices[].message.tool_calls
  const choices = responseBody['choices'] as Array<Record<string, unknown>> | undefined;
  if (choices) {
    for (const choice of choices) {
      const message = choice['message'] as Record<string, unknown> | undefined;
      if (message?.['tool_calls'] && Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0) {
        return true;
      }
    }
  }

  // Anthropic format: content[].type === 'tool_use'
  const content = responseBody['content'] as Array<Record<string, unknown>> | undefined;
  if (content) {
    for (const block of content) {
      if (block['type'] === 'tool_use') return true;
    }
  }

  // Anthropic stop_reason
  if (responseBody['stop_reason'] === 'tool_use') return true;

  return false;
}

// ─── In-Memory LRU ──────────────────────────────────────────────────

interface LRUEntry {
  response: string;
  sizeBytes: number;
}

class MemoryLRU {
  private entries = new Map<string, LRUEntry>();
  private currentSizeBytes = 0;
  private readonly maxSizeBytes: number;

  constructor(maxSizeMb: number) {
    this.maxSizeBytes = maxSizeMb * 1024 * 1024;
  }

  get(hash: string): string | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    // Move to end (most recently used)
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    return entry.response;
  }

  set(hash: string, response: string): void {
    const sizeBytes = Buffer.byteLength(response, 'utf-8');
    const existing = this.entries.get(hash);
    if (existing) {
      this.currentSizeBytes -= existing.sizeBytes;
      this.entries.delete(hash);
    }
    // Evict LRU until we have space
    while (this.currentSizeBytes + sizeBytes > this.maxSizeBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      if (entry) {
        this.currentSizeBytes -= entry.sizeBytes;
        this.entries.delete(oldest);
      }
    }
    if (sizeBytes > this.maxSizeBytes) return; // too big
    this.entries.set(hash, { response, sizeBytes });
    this.currentSizeBytes += sizeBytes;
  }

  delete(hash: string): void {
    const entry = this.entries.get(hash);
    if (entry) {
      this.currentSizeBytes -= entry.sizeBytes;
      this.entries.delete(hash);
    }
  }

  clear(): void {
    this.entries.clear();
    this.currentSizeBytes = 0;
  }

  get size(): number { return this.entries.size; }
  get sizeBytes(): number { return this.currentSizeBytes; }
}

// ─── SQLite Helpers ─────────────────────────────────────────────────

interface SqliteDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
}

function openDatabase(dbPath: string): SqliteDb {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

// ─── ResponseCache ──────────────────────────────────────────────────

export class ResponseCache {
  private config: ResolvedCacheConfig;
  private memory: MemoryLRU;
  private db: SqliteDb | null = null;
  private responsesDir: string;
  private _initialized = false;

  // Runtime counters
  private _hits = 0;
  private _misses = 0;
  private _bypasses = 0;
  private _savedCostUsd = 0;

  constructor(config?: Partial<CacheConfig>) {
    this.config = resolveCache(config);
    this.memory = new MemoryLRU(this.config.maxSizeMb);
    this.responsesDir = path.join(this.config.cacheDir, 'responses');
  }

  /** Initialize disk storage + SQLite. Safe to call multiple times. */
  init(): void {
    if (this._initialized) return;
    if (!this.config.enabled) return;
    this._initialized = true;

    fs.mkdirSync(this.config.cacheDir, { recursive: true });
    fs.mkdirSync(this.responsesDir, { recursive: true });

    try {
      const dbPath = path.join(this.config.cacheDir, 'index.db');
      this.db = openDatabase(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cache_entries (
          hash TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          task_type TEXT NOT NULL DEFAULT 'general',
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0,
          response_size_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_expires_at ON cache_entries(expires_at);
        CREATE INDEX IF NOT EXISTS idx_model ON cache_entries(model);
      `);
      // Clean expired on startup
      this.db.prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
      console.warn('[RelayPlane Cache] SQLite unavailable, memory-only mode:', (err as Error).message);
      this.db = null;
    }
  }

  /** Returns true if the request should bypass the cache. */
  shouldBypass(requestBody: Record<string, unknown>): boolean {
    if (!this.config.enabled) return true;
    // In aggressive mode, bypass only if disabled
    if (this.config.mode === 'aggressive') return false;
    if (this.config.onlyWhenDeterministic && !isDeterministic(requestBody)) return true;
    return false;
  }

  /** Get the cache mode */
  get mode(): 'exact' | 'aggressive' { return this.config.mode; }

  /** Compute cache key based on current mode */
  computeKey(requestBody: Record<string, unknown>): string {
    if (this.config.mode === 'aggressive') {
      return computeAggressiveCacheKey(requestBody);
    }
    return computeCacheKey(requestBody);
  }

  /** Get aggressive mode max age in seconds */
  get aggressiveMaxAge(): number { return this.config.aggressiveMaxAge; }

  /** Look up a cached response. Returns the response string or null. */
  get(hash: string): string | null {
    // Memory first
    const memHit = this.memory.get(hash);
    if (memHit !== null) {
      // Check expiry via DB if available
      if (this.db) {
        const row = this.db.prepare('SELECT expires_at FROM cache_entries WHERE hash = ?').get(hash) as { expires_at: number } | undefined;
        if (!row || row.expires_at <= Date.now()) {
          this.evict(hash);
          return null;
        }
        this.db.prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE hash = ?').run(hash);
      }
      return memHit;
    }

    // Disk fallback
    if (this.db) {
      const row = this.db.prepare(
        'SELECT hash FROM cache_entries WHERE hash = ? AND expires_at > ?'
      ).get(hash, Date.now()) as { hash: string } | undefined;
      if (row) {
        const diskResponse = this.loadFromDisk(hash);
        if (diskResponse) {
          this.memory.set(hash, diskResponse);
          this.db.prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE hash = ?').run(hash);
          return diskResponse;
        }
        // Broken disk entry
        this.db.prepare('DELETE FROM cache_entries WHERE hash = ?').run(hash);
      }
    }

    return null;
  }

  /** Store a response in cache. */
  set(hash: string, responseJson: string, opts: CacheSetOptions): void {
    if (!this.config.enabled) return;

    const taskType = opts.taskType || 'general';
    const ttlSec = this.config.ttlByTaskType[taskType] ?? this.config.defaultTtlSeconds;
    const now = Date.now();
    const sizeBytes = Buffer.byteLength(responseJson, 'utf-8');

    // Memory
    this.memory.set(hash, responseJson);

    // Disk
    this.saveToDisk(hash, responseJson);

    // SQLite
    if (this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO cache_entries 
        (hash, model, task_type, tokens_in, tokens_out, cost_usd, created_at, expires_at, hit_count, response_size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(hash, opts.model, taskType, opts.tokensIn, opts.tokensOut, opts.costUsd, now, now + ttlSec * 1000, sizeBytes);
    }
  }

  /** Record a cache hit (for stats). */
  recordHit(savedCostUsd: number, _savedLatencyMs: number): void {
    this._hits++;
    this._savedCostUsd += savedCostUsd;
  }

  /** Record a cache miss (for stats). */
  recordMiss(): void {
    this._misses++;
  }

  /** Record a cache bypass (for stats). */
  recordBypass(): void {
    this._bypasses++;
  }

  /** Remove a single entry. */
  evict(hash: string): void {
    this.memory.delete(hash);
    if (this.db) this.db.prepare('DELETE FROM cache_entries WHERE hash = ?').run(hash);
    try { fs.unlinkSync(path.join(this.responsesDir, `${hash}.gz`)); } catch { /* ok */ }
  }

  /** Clear all cached entries. */
  clear(): void {
    this.memory.clear();
    if (this.db) this.db.exec('DELETE FROM cache_entries');
    try {
      for (const f of fs.readdirSync(this.responsesDir)) {
        try { fs.unlinkSync(path.join(this.responsesDir, f)); } catch { /* ok */ }
      }
    } catch { /* ok */ }
    this._hits = 0;
    this._misses = 0;
    this._bypasses = 0;
    this._savedCostUsd = 0;
  }

  /** Clean expired entries. Returns count removed. */
  cleanup(): number {
    if (!this.db) return 0;
    const now = Date.now();
    const expired = this.db.prepare('SELECT hash FROM cache_entries WHERE expires_at <= ?').all(now) as Array<{ hash: string }>;
    for (const { hash } of expired) this.evict(hash);
    return expired.length;
  }

  /** Get detailed stats. */
  getStats(): CacheStats {
    const total = this._hits + this._misses;
    const result: CacheStats = {
      totalEntries: this.memory.size,
      totalSizeBytes: this.memory.sizeBytes,
      hits: this._hits,
      misses: this._misses,
      bypasses: this._bypasses,
      hitRate: total > 0 ? this._hits / total : 0,
      savedCostUsd: this._savedCostUsd,
      savedRequests: this._hits,
      byModel: {},
      byTaskType: {},
    };

    if (this.db) {
      const countRow = this.db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(response_size_bytes),0) as s FROM cache_entries').get() as { c: number; s: number };
      result.totalEntries = countRow.c;
      result.totalSizeBytes = countRow.s;

      const modelRows = this.db.prepare(
        'SELECT model, SUM(hit_count) as h, COUNT(*) as e, SUM(cost_usd * hit_count) as sv FROM cache_entries GROUP BY model'
      ).all() as Array<{ model: string; h: number; e: number; sv: number }>;
      for (const r of modelRows) result.byModel[r.model] = { hits: r.h, entries: r.e, savedCostUsd: r.sv };

      const taskRows = this.db.prepare(
        'SELECT task_type, SUM(hit_count) as h, COUNT(*) as e, SUM(cost_usd * hit_count) as sv FROM cache_entries GROUP BY task_type'
      ).all() as Array<{ task_type: string; h: number; e: number; sv: number }>;
      for (const r of taskRows) result.byTaskType[r.task_type] = { hits: r.h, entries: r.e, savedCostUsd: r.sv };
    }

    return result;
  }

  /** Simple status for CLI. */
  getStatus(): { enabled: boolean; entries: number; sizeMb: number; hitRate: string; savedCostUsd: number } {
    const s = this.getStats();
    return {
      enabled: this.config.enabled,
      entries: s.totalEntries,
      sizeMb: parseFloat((s.totalSizeBytes / (1024 * 1024)).toFixed(2)),
      hitRate: `${(s.hitRate * 100).toFixed(1)}%`,
      savedCostUsd: parseFloat(s.savedCostUsd.toFixed(4)),
    };
  }

  setEnabled(enabled: boolean): void { this.config.enabled = enabled; }
  get enabled(): boolean { return this.config.enabled; }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private loadFromDisk(hash: string): string | null {
    try {
      const compressed = fs.readFileSync(path.join(this.responsesDir, `${hash}.gz`));
      return zlib.gunzipSync(compressed).toString('utf-8');
    } catch { return null; }
  }

  private saveToDisk(hash: string, response: string): void {
    try {
      const compressed = zlib.gzipSync(Buffer.from(response, 'utf-8'));
      fs.writeFileSync(path.join(this.responsesDir, `${hash}.gz`), compressed);
    } catch { /* non-fatal */ }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: ResponseCache | null = null;

export function getResponseCache(config?: Partial<CacheConfig>): ResponseCache {
  if (!_instance) {
    _instance = new ResponseCache(config);
  }
  return _instance;
}

export function resetResponseCache(): void {
  if (_instance) { _instance.close(); _instance = null; }
}
