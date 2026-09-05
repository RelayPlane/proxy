/**
 * Run attribution ledger storage (PR1).
 *
 * Stores runs, agents, requests, alerts and label stats in
 * `${RELAYPLANE_HOME_OVERRIDE ?? os.homedir()}/.relayplane/runs.db` (SQLite via
 * better-sqlite3, WAL). Falls back to in-process Maps when the native module is
 * unavailable, so the proxy never fails a request because storage is missing.
 *
 * JSON columns (`tags`, `models_seen`, `data`, `dominant_models`) are serialized
 * exactly once on write and parsed on read: callers only ever see objects.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Row types (snake_case, mirroring the columns exactly)
// ---------------------------------------------------------------------------

export type RunSource = 'header' | 'inferred_cc' | 'inferred_gap';
export type RunStatus = 'running' | 'completed' | 'stale_closed' | 'failed';
export type BandStatus = 'none' | 'under' | 'in' | 'over';
export type CacheState = 'cold' | 'warm' | 'mixed';
export type RetryReason = 'header' | 'after_error' | 'after_429' | 'same_prompt';
export type RunAlertKind =
  | 'run.cost_exceeded'
  | 'run.cap_hit'
  | 'run.over_band'
  | 'run.under_band'
  | 'run.rate_limit_wave'
  | 'run.model_drift'
  | 'run.stale_closed';

export interface RunRow {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  label: string | null;
  run_source: RunSource;
  status: RunStatus;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  exit_code: number | null;
  reopen_count: number;
  request_count: number;
  error_count: number;
  rate_limit_count: number;
  retry_count: number;
  retry_cost_usd: number;
  drift_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number;
  baseline_usd: number;
  cap_usd: number | null;
  cap_hit_at: number | null;
  cache_state: CacheState | null;
  band_lo: number | null;
  band_hi: number | null;
  band_status: BandStatus;
  tags: Record<string, string>;
  client_key: string | null;
  created_at: number;
}

export interface RunAgentRow {
  run_id: string;
  agent_label: string;
  thread_id: string;
  agent_source: 'header' | 'inferred';
  agent_fingerprint: string | null;
  first_seen_at: number;
  last_seen_at: number;
  request_count: number;
  error_count: number;
  retry_count: number;
  retry_cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  models_seen: Record<string, number>;
  last_msg_hash: string | null;
  repeat_count: number;
  last_status_code: number | null;
}

export interface RunRequestRow {
  trace_id: string;
  run_id: string;
  agent_label: string;
  thread_id: string;
  history_id: string | null;
  ts: number;
  model: string;
  requested_model: string | null;
  provider: string;
  attempt: number;
  is_retry: 0 | 1;
  retry_reason: RetryReason | null;
  cache_state: 'cold' | 'warm' | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number;
  cost_estimated: 0 | 1;
  latency_ms: number;
  success: 0 | 1;
  status_code: number | null;
  complexity: string | null;
  task_type: string | null;
}

export interface RunAlertRow {
  id: number;
  ts: number;
  kind: RunAlertKind;
  run_id: string;
  agent_label: string | null;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data: Record<string, unknown>;
  delivered: 0 | 1;
}

export interface LabelStatsRow {
  label: string;
  cache_state: string;
  window_days: number;
  n: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  dominant_models: Record<string, string>;
  updated_at: number;
}

export interface OpenRunInput {
  run_id: string;
  parent_run_id?: string | null;
  depth?: number;
  label?: string | null;
  run_source: RunSource;
  tags?: Record<string, string>;
  cap_usd?: number | null;
  client_key?: string | null;
  now?: number;
}

export interface RunListFilter {
  status?: RunStatus;
  /** Lower bound on `last_seen_at` (the column the list is ordered by). */
  sinceMs?: number;
  label?: string;
  /** `k:v` single tag match. */
  tag?: string;
  source?: RunSource;
  limit?: number;
  /** `${last_seen_at}:${run_id}` of the last row of the previous page. */
  cursor?: string;
}

/** Internal query shape shared by both backends. */
interface RunQuery {
  status?: RunStatus;
  minLastSeen?: number;
  maxLastSeen?: number;
  minEndedAt?: number;
  label?: string;
  source?: RunSource;
  parentRunId?: string;
  tagKey?: string;
  tagValue?: string;
  cursorTs?: number;
  cursorId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const RUNS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  parent_run_id     TEXT,
  depth             INTEGER NOT NULL DEFAULT 0,
  label             TEXT,
  run_source        TEXT NOT NULL,
  status            TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  ended_at          INTEGER,
  exit_code         INTEGER,
  reopen_count      INTEGER NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  rate_limit_count  INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  retry_cost_usd    REAL NOT NULL DEFAULT 0,
  drift_count       INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  cache_creation    INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  baseline_usd      REAL NOT NULL DEFAULT 0,
  cap_usd           REAL,
  cap_hit_at        INTEGER,
  cache_state       TEXT,
  band_lo           REAL,
  band_hi           REAL,
  band_status       TEXT NOT NULL DEFAULT 'none',
  tags              TEXT NOT NULL DEFAULT '{}',
  client_key        TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_runs_parent  ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_label   ON runs(label, started_at);

CREATE TABLE IF NOT EXISTS run_agents (
  run_id            TEXT NOT NULL,
  agent_label       TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  agent_source      TEXT NOT NULL,
  agent_fingerprint TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  retry_cost_usd    REAL NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  models_seen       TEXT NOT NULL DEFAULT '{}',
  last_msg_hash     TEXT,
  repeat_count      INTEGER NOT NULL DEFAULT 0,
  last_status_code  INTEGER,
  PRIMARY KEY (run_id, agent_label, thread_id)
);

CREATE TABLE IF NOT EXISTS run_requests (
  trace_id          TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  agent_label       TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  history_id        TEXT,
  ts                INTEGER NOT NULL,
  model             TEXT NOT NULL,
  requested_model   TEXT,
  provider          TEXT NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  is_retry          INTEGER NOT NULL DEFAULT 0,
  retry_reason      TEXT,
  cache_state       TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  cache_creation    INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  cost_estimated    INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  success           INTEGER NOT NULL,
  status_code       INTEGER,
  complexity        TEXT,
  task_type         TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_requests_run    ON run_requests(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_run_requests_ts     ON run_requests(ts);
CREATE INDEX IF NOT EXISTS idx_run_requests_thread ON run_requests(run_id, thread_id, ts);

CREATE TABLE IF NOT EXISTS run_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  agent_label   TEXT,
  severity      TEXT NOT NULL,
  message       TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  delivered     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_run_alerts_ts ON run_alerts(ts);

CREATE TABLE IF NOT EXISTS label_stats (
  label         TEXT NOT NULL,
  cache_state   TEXT NOT NULL,
  window_days   INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  p25           REAL,
  p50           REAL,
  p75           REAL,
  p90           REAL,
  dominant_models TEXT NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (label, cache_state, window_days)
);
`;

/**
 * Forward-only additive migrations for databases created by an older build.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each statement is attempted and
 * the "duplicate column name" error is swallowed (same pattern as osmosis-store).
 */
const COLUMN_MIGRATIONS = [
  `ALTER TABLE runs ADD COLUMN retry_cost_usd REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN drift_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN rate_limit_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN baseline_usd REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN cap_usd REAL`,
  `ALTER TABLE runs ADD COLUMN cap_hit_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN cache_state TEXT`,
  `ALTER TABLE runs ADD COLUMN band_lo REAL`,
  `ALTER TABLE runs ADD COLUMN band_hi REAL`,
  `ALTER TABLE runs ADD COLUMN band_status TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE runs ADD COLUMN tags TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE runs ADD COLUMN client_key TEXT`,
  `ALTER TABLE runs ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE run_agents ADD COLUMN retry_cost_usd REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE run_agents ADD COLUMN models_seen TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE run_agents ADD COLUMN last_msg_hash TEXT`,
  `ALTER TABLE run_agents ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE run_agents ADD COLUMN last_status_code INTEGER`,
  `ALTER TABLE run_requests ADD COLUMN retry_reason TEXT`,
  `ALTER TABLE run_requests ADD COLUMN cache_state TEXT`,
  `ALTER TABLE run_requests ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE run_requests ADD COLUMN complexity TEXT`,
  `ALTER TABLE run_requests ADD COLUMN task_type TEXT`,
];

const RUN_COLUMNS = [
  'run_id', 'parent_run_id', 'depth', 'label', 'run_source', 'status', 'started_at',
  'last_seen_at', 'ended_at', 'exit_code', 'reopen_count', 'request_count', 'error_count',
  'rate_limit_count', 'retry_count', 'retry_cost_usd', 'drift_count', 'tokens_in',
  'tokens_out', 'cache_read', 'cache_creation', 'cost_usd', 'baseline_usd', 'cap_usd',
  'cap_hit_at', 'cache_state', 'band_lo', 'band_hi', 'band_status', 'tags', 'client_key',
  'created_at',
];

const AGENT_COLUMNS = [
  'run_id', 'agent_label', 'thread_id', 'agent_source', 'agent_fingerprint', 'first_seen_at',
  'last_seen_at', 'request_count', 'error_count', 'retry_count', 'retry_cost_usd', 'tokens_in',
  'tokens_out', 'cost_usd', 'models_seen', 'last_msg_hash', 'repeat_count', 'last_status_code',
];

const REQUEST_COLUMNS = [
  'trace_id', 'run_id', 'agent_label', 'thread_id', 'history_id', 'ts', 'model',
  'requested_model', 'provider', 'attempt', 'is_retry', 'retry_reason', 'cache_state',
  'tokens_in', 'tokens_out', 'cache_read', 'cache_creation', 'cost_usd', 'cost_estimated',
  'latency_ms', 'success', 'status_code', 'complexity', 'task_type',
];

const LABEL_STATS_COLUMNS = [
  'label', 'cache_state', 'window_days', 'n', 'p25', 'p50', 'p75', 'p90',
  'dominant_models', 'updated_at',
];

// ---------------------------------------------------------------------------
// Decoding helpers (SQLite hands back `unknown`; narrow it without `any`)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bit(value: unknown): 0 | 1 {
  return num(value) === 1 ? 1 : 0;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function parseStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseJsonRecord(value))) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function parseNumberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parseJsonRecord(value))) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function toRunSource(value: unknown): RunSource {
  const s = str(value);
  return s === 'inferred_cc' || s === 'inferred_gap' ? s : 'header';
}

function toRunStatus(value: unknown): RunStatus {
  const s = str(value);
  return s === 'completed' || s === 'stale_closed' || s === 'failed' ? s : 'running';
}

function toBandStatus(value: unknown): BandStatus {
  const s = str(value);
  return s === 'under' || s === 'in' || s === 'over' ? s : 'none';
}

function toCacheState(value: unknown): CacheState | null {
  const s = str(value);
  return s === 'cold' || s === 'warm' || s === 'mixed' ? s : null;
}

function toRequestCacheState(value: unknown): 'cold' | 'warm' | null {
  const s = str(value);
  return s === 'cold' || s === 'warm' ? s : null;
}

function toRetryReason(value: unknown): RetryReason | null {
  const s = str(value);
  return s === 'header' || s === 'after_error' || s === 'after_429' || s === 'same_prompt' ? s : null;
}

function toAgentSource(value: unknown): 'header' | 'inferred' {
  return str(value) === 'header' ? 'header' : 'inferred';
}

function toSeverity(value: unknown): 'info' | 'warning' | 'critical' {
  const s = str(value);
  return s === 'warning' || s === 'critical' ? s : 'info';
}

const ALERT_KINDS: RunAlertKind[] = [
  'run.cost_exceeded', 'run.cap_hit', 'run.over_band', 'run.under_band',
  'run.rate_limit_wave', 'run.model_drift', 'run.stale_closed',
];

function toAlertKind(value: unknown): RunAlertKind {
  const s = str(value);
  for (const k of ALERT_KINDS) if (k === s) return k;
  return 'run.cost_exceeded';
}

function mapRunRow(raw: unknown): RunRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    run_id: str(r['run_id']),
    parent_run_id: strOrNull(r['parent_run_id']),
    depth: num(r['depth']),
    label: strOrNull(r['label']),
    run_source: toRunSource(r['run_source']),
    status: toRunStatus(r['status']),
    started_at: num(r['started_at']),
    last_seen_at: num(r['last_seen_at']),
    ended_at: numOrNull(r['ended_at']),
    exit_code: numOrNull(r['exit_code']),
    reopen_count: num(r['reopen_count']),
    request_count: num(r['request_count']),
    error_count: num(r['error_count']),
    rate_limit_count: num(r['rate_limit_count']),
    retry_count: num(r['retry_count']),
    retry_cost_usd: num(r['retry_cost_usd']),
    drift_count: num(r['drift_count']),
    tokens_in: num(r['tokens_in']),
    tokens_out: num(r['tokens_out']),
    cache_read: num(r['cache_read']),
    cache_creation: num(r['cache_creation']),
    cost_usd: num(r['cost_usd']),
    baseline_usd: num(r['baseline_usd']),
    cap_usd: numOrNull(r['cap_usd']),
    cap_hit_at: numOrNull(r['cap_hit_at']),
    cache_state: toCacheState(r['cache_state']),
    band_lo: numOrNull(r['band_lo']),
    band_hi: numOrNull(r['band_hi']),
    band_status: toBandStatus(r['band_status']),
    tags: parseStringMap(r['tags']),
    client_key: strOrNull(r['client_key']),
    created_at: num(r['created_at']),
  };
}

function mapAgentRow(raw: unknown): RunAgentRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    run_id: str(r['run_id']),
    agent_label: str(r['agent_label']),
    thread_id: str(r['thread_id']),
    agent_source: toAgentSource(r['agent_source']),
    agent_fingerprint: strOrNull(r['agent_fingerprint']),
    first_seen_at: num(r['first_seen_at']),
    last_seen_at: num(r['last_seen_at']),
    request_count: num(r['request_count']),
    error_count: num(r['error_count']),
    retry_count: num(r['retry_count']),
    retry_cost_usd: num(r['retry_cost_usd']),
    tokens_in: num(r['tokens_in']),
    tokens_out: num(r['tokens_out']),
    cost_usd: num(r['cost_usd']),
    models_seen: parseNumberMap(r['models_seen']),
    last_msg_hash: strOrNull(r['last_msg_hash']),
    repeat_count: num(r['repeat_count']),
    last_status_code: numOrNull(r['last_status_code']),
  };
}

function mapRequestRow(raw: unknown): RunRequestRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    trace_id: str(r['trace_id']),
    run_id: str(r['run_id']),
    agent_label: str(r['agent_label']),
    thread_id: str(r['thread_id']),
    history_id: strOrNull(r['history_id']),
    ts: num(r['ts']),
    model: str(r['model']),
    requested_model: strOrNull(r['requested_model']),
    provider: str(r['provider']),
    attempt: num(r['attempt'], 1),
    is_retry: bit(r['is_retry']),
    retry_reason: toRetryReason(r['retry_reason']),
    cache_state: toRequestCacheState(r['cache_state']),
    tokens_in: num(r['tokens_in']),
    tokens_out: num(r['tokens_out']),
    cache_read: num(r['cache_read']),
    cache_creation: num(r['cache_creation']),
    cost_usd: num(r['cost_usd']),
    cost_estimated: bit(r['cost_estimated']),
    latency_ms: num(r['latency_ms']),
    success: bit(r['success']),
    status_code: numOrNull(r['status_code']),
    complexity: strOrNull(r['complexity']),
    task_type: strOrNull(r['task_type']),
  };
}

function mapAlertRow(raw: unknown): RunAlertRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    id: num(r['id']),
    ts: num(r['ts']),
    kind: toAlertKind(r['kind']),
    run_id: str(r['run_id']),
    agent_label: strOrNull(r['agent_label']),
    severity: toSeverity(r['severity']),
    message: str(r['message']),
    data: parseJsonRecord(r['data']),
    delivered: bit(r['delivered']),
  };
}

function mapLabelStatsRow(raw: unknown): LabelStatsRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  return {
    label: str(r['label']),
    cache_state: str(r['cache_state']),
    window_days: num(r['window_days']),
    n: num(r['n']),
    p25: numOrNull(r['p25']),
    p50: numOrNull(r['p50']),
    p75: numOrNull(r['p75']),
    p90: numOrNull(r['p90']),
    dominant_models: parseStringMap(r['dominant_models']),
    updated_at: num(r['updated_at']),
  };
}

function cloneRun(row: RunRow): RunRow {
  return { ...row, tags: { ...row.tags } };
}

function cloneAgent(row: RunAgentRow): RunAgentRow {
  return { ...row, models_seen: { ...row.models_seen } };
}

function cloneRequest(row: RunRequestRow): RunRequestRow {
  return { ...row };
}

function cloneAlert(row: RunAlertRow): RunAlertRow {
  return { ...row, data: { ...row.data } };
}

function cloneLabelStats(row: LabelStatsRow): LabelStatsRow {
  return { ...row, dominant_models: { ...row.dominant_models } };
}

/**
 * Nearest-rank percentile. `p` is a percentile in 0..100 (25, 50, 75, 90).
 * `sorted` must be ascending. Returns null for an empty input.
 */
export function nearestRankPercentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const pct = Math.min(100, Math.max(0, p));
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil((pct / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function getRelayplaneDir(): string {
  const override = process.env['RELAYPLANE_HOME_OVERRIDE'];
  const base = override ?? os.homedir();
  return path.join(base, '.relayplane');
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

interface RunBackend {
  readonly isSqlite: boolean;
  transaction<T>(fn: () => T): T;
  getRun(runId: string): RunRow | null;
  putRun(row: RunRow): void;
  queryRuns(q: RunQuery): RunRow[];
  getAgent(runId: string, agentLabel: string, threadId: string): RunAgentRow | null;
  putAgent(row: RunAgentRow): void;
  agentsForRun(runId: string): RunAgentRow[];
  getRequest(traceId: string): RunRequestRow | null;
  putRequest(row: RunRequestRow): void;
  listRequests(runId: string, limit: number, cursorTs: number | null, cursorTraceId: string | null): RunRequestRow[];
  lastRequestOnThread(runId: string, threadId: string): RunRequestRow | null;
  requestsSince(runId: string, sinceTs: number): RunRequestRow[];
  insertAlert(row: Omit<RunAlertRow, 'id'>): RunAlertRow;
  listAlerts(opts: { sinceTs?: number; limit?: number; run_id?: string }): RunAlertRow[];
  hasAlert(runId: string, kind: RunAlertKind, sinceTs?: number): boolean;
  markAlertDelivered(id: number): void;
  putLabelStats(row: LabelStatsRow): void;
  getLabelStats(label: string, cacheState: string, windowDays: number): LabelStatsRow | null;
  prune(requestCutoff: number, rollupCutoff: number): { requests: number; runs: number };
  close(): void;
}

type SqliteDatabase = import('better-sqlite3').Database;
type SqliteStatement = import('better-sqlite3').Statement;

class SqliteRunBackend implements RunBackend {
  readonly isSqlite = true;
  private db: SqliteDatabase;
  private stmts = new Map<string, SqliteStatement>();

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private stmt(sql: string): SqliteStatement {
    const cached = this.stmts.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.stmts.set(sql, prepared);
    return prepared;
  }

  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  getRun(runId: string): RunRow | null {
    return mapRunRow(this.stmt(`SELECT * FROM runs WHERE run_id = ?`).get(runId));
  }

  putRun(row: RunRow): void {
    const sql = `INSERT OR REPLACE INTO runs (${RUN_COLUMNS.join(', ')}) VALUES (${RUN_COLUMNS.map((c) => '@' + c).join(', ')})`;
    this.stmt(sql).run({ ...row, tags: JSON.stringify(row.tags) });
  }

  queryRuns(q: RunQuery): RunRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status !== undefined) { where.push(`status = ?`); params.push(q.status); }
    if (q.minLastSeen !== undefined) { where.push(`last_seen_at >= ?`); params.push(q.minLastSeen); }
    if (q.maxLastSeen !== undefined) { where.push(`last_seen_at < ?`); params.push(q.maxLastSeen); }
    if (q.minEndedAt !== undefined) { where.push(`ended_at IS NOT NULL AND ended_at >= ?`); params.push(q.minEndedAt); }
    if (q.label !== undefined) { where.push(`label = ?`); params.push(q.label); }
    if (q.source !== undefined) { where.push(`run_source = ?`); params.push(q.source); }
    if (q.parentRunId !== undefined) { where.push(`parent_run_id = ?`); params.push(q.parentRunId); }
    if (q.tagKey !== undefined) {
      where.push(`json_extract(tags, '$."' || ? || '"') = ?`);
      params.push(q.tagKey.replace(/["$]/g, ''), q.tagValue ?? '');
    }
    if (q.cursorTs !== undefined && q.cursorId !== undefined) {
      where.push(`(last_seen_at < ? OR (last_seen_at = ? AND run_id < ?))`);
      params.push(q.cursorTs, q.cursorTs, q.cursorId);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    params.push(q.limit ?? 1000);
    const rows = this.stmt(`SELECT * FROM runs${clause} ORDER BY last_seen_at DESC, run_id DESC LIMIT ?`).all(...params);
    const out: RunRow[] = [];
    for (const raw of rows) {
      const mapped = mapRunRow(raw);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  getAgent(runId: string, agentLabel: string, threadId: string): RunAgentRow | null {
    return mapAgentRow(
      this.stmt(`SELECT * FROM run_agents WHERE run_id = ? AND agent_label = ? AND thread_id = ?`)
        .get(runId, agentLabel, threadId),
    );
  }

  putAgent(row: RunAgentRow): void {
    const sql = `INSERT OR REPLACE INTO run_agents (${AGENT_COLUMNS.join(', ')}) VALUES (${AGENT_COLUMNS.map((c) => '@' + c).join(', ')})`;
    this.stmt(sql).run({ ...row, models_seen: JSON.stringify(row.models_seen) });
  }

  agentsForRun(runId: string): RunAgentRow[] {
    const rows = this.stmt(`SELECT * FROM run_agents WHERE run_id = ? ORDER BY cost_usd DESC`).all(runId);
    const out: RunAgentRow[] = [];
    for (const raw of rows) {
      const mapped = mapAgentRow(raw);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  getRequest(traceId: string): RunRequestRow | null {
    return mapRequestRow(this.stmt(`SELECT * FROM run_requests WHERE trace_id = ?`).get(traceId));
  }

  putRequest(row: RunRequestRow): void {
    const sql = `INSERT OR REPLACE INTO run_requests (${REQUEST_COLUMNS.join(', ')}) VALUES (${REQUEST_COLUMNS.map((c) => '@' + c).join(', ')})`;
    this.stmt(sql).run({ ...row });
  }

  listRequests(runId: string, limit: number, cursorTs: number | null, cursorTraceId: string | null): RunRequestRow[] {
    const params: unknown[] = [runId];
    let clause = `run_id = ?`;
    if (cursorTs !== null && cursorTraceId !== null) {
      clause += ` AND (ts > ? OR (ts = ? AND trace_id > ?))`;
      params.push(cursorTs, cursorTs, cursorTraceId);
    }
    params.push(limit);
    const rows = this.stmt(`SELECT * FROM run_requests WHERE ${clause} ORDER BY ts ASC, trace_id ASC LIMIT ?`).all(...params);
    const out: RunRequestRow[] = [];
    for (const raw of rows) {
      const mapped = mapRequestRow(raw);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  lastRequestOnThread(runId: string, threadId: string): RunRequestRow | null {
    return mapRequestRow(
      this.stmt(`SELECT * FROM run_requests WHERE run_id = ? AND thread_id = ? ORDER BY ts DESC, trace_id DESC LIMIT 1`)
        .get(runId, threadId),
    );
  }

  requestsSince(runId: string, sinceTs: number): RunRequestRow[] {
    const rows = this.stmt(`SELECT * FROM run_requests WHERE run_id = ? AND ts >= ? ORDER BY ts ASC`).all(runId, sinceTs);
    const out: RunRequestRow[] = [];
    for (const raw of rows) {
      const mapped = mapRequestRow(raw);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  insertAlert(row: Omit<RunAlertRow, 'id'>): RunAlertRow {
    const info = this.stmt(
      `INSERT INTO run_alerts (ts, kind, run_id, agent_label, severity, message, data, delivered)
       VALUES (@ts, @kind, @run_id, @agent_label, @severity, @message, @data, @delivered)`,
    ).run({ ...row, data: JSON.stringify(row.data) });
    return cloneAlert({ ...row, id: Number(info.lastInsertRowid) });
  }

  listAlerts(opts: { sinceTs?: number; limit?: number; run_id?: string }): RunAlertRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.sinceTs !== undefined) { where.push(`ts >= ?`); params.push(opts.sinceTs); }
    if (opts.run_id !== undefined) { where.push(`run_id = ?`); params.push(opts.run_id); }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    params.push(opts.limit ?? 100);
    const rows = this.stmt(`SELECT * FROM run_alerts${clause} ORDER BY ts DESC, id DESC LIMIT ?`).all(...params);
    const out: RunAlertRow[] = [];
    for (const raw of rows) {
      const mapped = mapAlertRow(raw);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  hasAlert(runId: string, kind: RunAlertKind, sinceTs?: number): boolean {
    const row = sinceTs === undefined
      ? this.stmt(`SELECT id FROM run_alerts WHERE run_id = ? AND kind = ? LIMIT 1`).get(runId, kind)
      : this.stmt(`SELECT id FROM run_alerts WHERE run_id = ? AND kind = ? AND ts >= ? LIMIT 1`).get(runId, kind, sinceTs);
    return asRecord(row) !== null;
  }

  markAlertDelivered(id: number): void {
    this.stmt(`UPDATE run_alerts SET delivered = 1 WHERE id = ?`).run(id);
  }

  putLabelStats(row: LabelStatsRow): void {
    const sql = `INSERT OR REPLACE INTO label_stats (${LABEL_STATS_COLUMNS.join(', ')}) VALUES (${LABEL_STATS_COLUMNS.map((c) => '@' + c).join(', ')})`;
    this.stmt(sql).run({ ...row, dominant_models: JSON.stringify(row.dominant_models) });
  }

  getLabelStats(label: string, cacheState: string, windowDays: number): LabelStatsRow | null {
    return mapLabelStatsRow(
      this.stmt(`SELECT * FROM label_stats WHERE label = ? AND cache_state = ? AND window_days = ?`)
        .get(label, cacheState, windowDays),
    );
  }

  prune(requestCutoff: number, rollupCutoff: number): { requests: number; runs: number } {
    const requests = this.stmt(`DELETE FROM run_requests WHERE ts < ?`).run(requestCutoff).changes;
    this.stmt(`DELETE FROM run_agents WHERE run_id IN (SELECT run_id FROM runs WHERE last_seen_at < ?)`).run(rollupCutoff);
    this.stmt(`DELETE FROM run_alerts WHERE ts < ?`).run(rollupCutoff);
    const runs = this.stmt(`DELETE FROM runs WHERE last_seen_at < ?`).run(rollupCutoff).changes;
    return { requests, runs };
  }

  close(): void {
    this.stmts.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }
}

class MemoryRunBackend implements RunBackend {
  readonly isSqlite = false;
  private runs = new Map<string, RunRow>();
  private agents = new Map<string, RunAgentRow>();
  private requests = new Map<string, RunRequestRow>();
  private alerts: RunAlertRow[] = [];
  private labelStats = new Map<string, LabelStatsRow>();
  private alertSeq = 0;

  private agentKey(runId: string, agentLabel: string, threadId: string): string {
    return `${runId} ${agentLabel} ${threadId}`;
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  getRun(runId: string): RunRow | null {
    const row = this.runs.get(runId);
    return row ? cloneRun(row) : null;
  }

  putRun(row: RunRow): void {
    this.runs.set(row.run_id, cloneRun(row));
  }

  queryRuns(q: RunQuery): RunRow[] {
    let rows = [...this.runs.values()];
    const minLastSeen = q.minLastSeen;
    const maxLastSeen = q.maxLastSeen;
    const minEndedAt = q.minEndedAt;
    const tagKey = q.tagKey;
    const cursorTs = q.cursorTs;
    const cursorId = q.cursorId;
    if (q.status !== undefined) rows = rows.filter((r) => r.status === q.status);
    if (minLastSeen !== undefined) rows = rows.filter((r) => r.last_seen_at >= minLastSeen);
    if (maxLastSeen !== undefined) rows = rows.filter((r) => r.last_seen_at < maxLastSeen);
    if (minEndedAt !== undefined) rows = rows.filter((r) => r.ended_at !== null && r.ended_at >= minEndedAt);
    if (q.label !== undefined) rows = rows.filter((r) => r.label === q.label);
    if (q.source !== undefined) rows = rows.filter((r) => r.run_source === q.source);
    if (q.parentRunId !== undefined) rows = rows.filter((r) => r.parent_run_id === q.parentRunId);
    if (tagKey !== undefined) rows = rows.filter((r) => r.tags[tagKey] === (q.tagValue ?? ''));
    rows.sort((a, b) => (b.last_seen_at - a.last_seen_at) || (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
    if (cursorTs !== undefined && cursorId !== undefined) {
      rows = rows.filter((r) => r.last_seen_at < cursorTs || (r.last_seen_at === cursorTs && r.run_id < cursorId));
    }
    return rows.slice(0, q.limit ?? 1000).map(cloneRun);
  }

  getAgent(runId: string, agentLabel: string, threadId: string): RunAgentRow | null {
    const row = this.agents.get(this.agentKey(runId, agentLabel, threadId));
    return row ? cloneAgent(row) : null;
  }

  putAgent(row: RunAgentRow): void {
    this.agents.set(this.agentKey(row.run_id, row.agent_label, row.thread_id), cloneAgent(row));
  }

  agentsForRun(runId: string): RunAgentRow[] {
    return [...this.agents.values()]
      .filter((a) => a.run_id === runId)
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .map(cloneAgent);
  }

  getRequest(traceId: string): RunRequestRow | null {
    const row = this.requests.get(traceId);
    return row ? cloneRequest(row) : null;
  }

  putRequest(row: RunRequestRow): void {
    this.requests.set(row.trace_id, cloneRequest(row));
  }

  private sortedRequests(runId: string): RunRequestRow[] {
    return [...this.requests.values()]
      .filter((r) => r.run_id === runId)
      .sort((a, b) => (a.ts - b.ts) || (a.trace_id < b.trace_id ? -1 : a.trace_id > b.trace_id ? 1 : 0));
  }

  listRequests(runId: string, limit: number, cursorTs: number | null, cursorTraceId: string | null): RunRequestRow[] {
    let rows = this.sortedRequests(runId);
    if (cursorTs !== null && cursorTraceId !== null) {
      rows = rows.filter((r) => r.ts > cursorTs || (r.ts === cursorTs && r.trace_id > cursorTraceId));
    }
    return rows.slice(0, limit).map(cloneRequest);
  }

  lastRequestOnThread(runId: string, threadId: string): RunRequestRow | null {
    const rows = this.sortedRequests(runId).filter((r) => r.thread_id === threadId);
    const last = rows[rows.length - 1];
    return last ? cloneRequest(last) : null;
  }

  requestsSince(runId: string, sinceTs: number): RunRequestRow[] {
    return this.sortedRequests(runId).filter((r) => r.ts >= sinceTs).map(cloneRequest);
  }

  insertAlert(row: Omit<RunAlertRow, 'id'>): RunAlertRow {
    this.alertSeq += 1;
    const full = cloneAlert({ ...row, id: this.alertSeq });
    this.alerts.push(full);
    return cloneAlert(full);
  }

  listAlerts(opts: { sinceTs?: number; limit?: number; run_id?: string }): RunAlertRow[] {
    return this.alerts
      .filter((a) => (opts.sinceTs === undefined || a.ts >= opts.sinceTs) && (opts.run_id === undefined || a.run_id === opts.run_id))
      .sort((a, b) => (b.ts - a.ts) || (b.id - a.id))
      .slice(0, opts.limit ?? 100)
      .map(cloneAlert);
  }

  hasAlert(runId: string, kind: RunAlertKind, sinceTs?: number): boolean {
    return this.alerts.some((a) => a.run_id === runId && a.kind === kind && (sinceTs === undefined || a.ts >= sinceTs));
  }

  markAlertDelivered(id: number): void {
    for (const a of this.alerts) if (a.id === id) a.delivered = 1;
  }

  putLabelStats(row: LabelStatsRow): void {
    this.labelStats.set(`${row.label} ${row.cache_state} ${row.window_days}`, cloneLabelStats(row));
  }

  getLabelStats(label: string, cacheState: string, windowDays: number): LabelStatsRow | null {
    const row = this.labelStats.get(`${label} ${cacheState} ${windowDays}`);
    return row ? cloneLabelStats(row) : null;
  }

  prune(requestCutoff: number, rollupCutoff: number): { requests: number; runs: number } {
    let requests = 0;
    for (const [traceId, row] of [...this.requests.entries()]) {
      if (row.ts < requestCutoff) { this.requests.delete(traceId); requests += 1; }
    }
    let runs = 0;
    const doomed = new Set<string>();
    for (const [runId, row] of [...this.runs.entries()]) {
      if (row.last_seen_at < rollupCutoff) { this.runs.delete(runId); doomed.add(runId); runs += 1; }
    }
    for (const [key, row] of [...this.agents.entries()]) {
      if (doomed.has(row.run_id)) this.agents.delete(key);
    }
    this.alerts = this.alerts.filter((a) => a.ts >= rollupCutoff);
    return { requests, runs };
  }

  close(): void {
    this.runs.clear();
    this.agents.clear();
    this.requests.clear();
    this.labelStats.clear();
    this.alerts = [];
  }
}

function initSqlite(): SqliteDatabase | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const dir = getRelayplaneDir();
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'runs.db'));
    db.pragma('journal_mode = WAL');
    db.exec(RUNS_SCHEMA_SQL);
    // Additive column migrations for pre-existing DBs; errors mean the column is there.
    for (const sql of COLUMN_MIGRATIONS) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }
    const current = asRecord(db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get());
    const version = current ? numOrNull(current['version']) : null;
    if (version === null || version < SCHEMA_VERSION) {
      db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
    }
    return db;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RunStore
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function isRateLimited(statusCode: number | null): boolean {
  return statusCode === 429 || statusCode === 529;
}

function isDrift(row: Pick<RunRequestRow, 'model' | 'requested_model'>): boolean {
  return row.requested_model !== null && row.requested_model.length > 0 && row.requested_model !== row.model;
}

function splitCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(':');
  if (idx <= 0) return null;
  const ts = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ts) || id.length === 0) return null;
  return { ts, id };
}

export class RunStore {
  readonly isSqlite: boolean;
  private backend: RunBackend;

  constructor(opts?: { forceMemory?: boolean }) {
    const db = opts?.forceMemory ? null : initSqlite();
    this.backend = db ? new SqliteRunBackend(db) : new MemoryRunBackend();
    this.isSqlite = this.backend.isSqlite;
  }

  // -- runs ----------------------------------------------------------------

  private blankRun(runId: string, source: RunSource, now: number): RunRow {
    return {
      run_id: runId,
      parent_run_id: null,
      depth: 0,
      label: null,
      run_source: source,
      status: 'running',
      started_at: now,
      last_seen_at: now,
      ended_at: null,
      exit_code: null,
      reopen_count: 0,
      request_count: 0,
      error_count: 0,
      rate_limit_count: 0,
      retry_count: 0,
      retry_cost_usd: 0,
      drift_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 0,
      cost_usd: 0,
      baseline_usd: 0,
      cap_usd: null,
      cap_hit_at: null,
      cache_state: null,
      band_lo: null,
      band_hi: null,
      band_status: 'none',
      tags: {},
      client_key: null,
      created_at: now,
    };
  }

  /** Create or touch every ancestor implied by `parent_run_id` and its `/` chain. */
  private ensureAncestors(parentRunId: string | null | undefined, source: RunSource, now: number): void {
    if (!parentRunId) return;
    const segments = parentRunId.split('/').filter((s) => s.length > 0);
    let acc = '';
    for (let i = 0; i < segments.length; i++) {
      const prefix = acc;
      acc = i === 0 ? segments[i] : `${acc}/${segments[i]}`;
      const existing = this.backend.getRun(acc);
      if (!existing) {
        const row = this.blankRun(acc, source, now);
        row.depth = i;
        row.parent_run_id = i === 0 ? null : prefix;
        this.backend.putRun(row);
      } else if (existing.last_seen_at < now) {
        existing.last_seen_at = now;
        this.backend.putRun(existing);
      }
    }
  }

  openRun(input: OpenRunInput): { run: RunRow; reopened: boolean; created: boolean } {
    const now = input.now ?? Date.now();
    return this.backend.transaction(() => {
      this.ensureAncestors(input.parent_run_id, input.run_source, now);
      const existing = this.backend.getRun(input.run_id);
      if (!existing) {
        const run = this.blankRun(input.run_id, input.run_source, now);
        run.parent_run_id = input.parent_run_id ?? null;
        run.depth = input.depth ?? 0;
        run.label = input.label ?? null;
        run.cap_usd = typeof input.cap_usd === 'number' ? input.cap_usd : null;
        run.tags = { ...(input.tags ?? {}) };
        run.client_key = input.client_key ?? null;
        this.backend.putRun(run);
        return { run: cloneRun(run), reopened: false, created: true };
      }
      const run = cloneRun(existing);
      let reopened = false;
      run.last_seen_at = Math.max(run.last_seen_at, now);
      if (run.status !== 'running') {
        run.status = 'running';
        run.ended_at = null;
        run.reopen_count += 1;
        reopened = true;
      }
      if (typeof input.cap_usd === 'number' && (run.cap_usd === null || input.cap_usd > run.cap_usd)) {
        run.cap_usd = input.cap_usd;
      }
      if (input.label && run.label === null) run.label = input.label;
      // Existing tags win over newly supplied ones.
      for (const [k, v] of Object.entries(input.tags ?? {})) {
        if (!(k in run.tags)) run.tags[k] = v;
      }
      // Backfill identity fields on rows that were created as bare ancestors.
      if (run.parent_run_id === null && input.parent_run_id) run.parent_run_id = input.parent_run_id;
      if (run.depth === 0 && typeof input.depth === 'number' && input.depth > 0) run.depth = input.depth;
      if (run.client_key === null && input.client_key) run.client_key = input.client_key;
      this.backend.putRun(run);
      return { run: cloneRun(run), reopened, created: false };
    });
  }

  getRun(runId: string): RunRow | null {
    return this.backend.getRun(runId);
  }

  /** Defensive: a request row must never be orphaned if openRun never ran. */
  private ensureRun(runId: string, now: number): RunRow {
    const existing = this.backend.getRun(runId);
    if (existing) return existing;
    const row = this.blankRun(runId, 'header', now);
    this.backend.putRun(row);
    return row;
  }

  upsertRequest(
    row: RunRequestRow,
    agent: { agent_source: 'header' | 'inferred'; agent_fingerprint?: string | null },
  ): { run: RunRow; agent: RunAgentRow; prev: RunRequestRow | null } {
    return this.backend.transaction(() => {
      const prev = this.backend.getRequest(row.trace_id);

      const dTokensIn = row.tokens_in - (prev ? prev.tokens_in : 0);
      const dTokensOut = row.tokens_out - (prev ? prev.tokens_out : 0);
      const dCacheRead = row.cache_read - (prev ? prev.cache_read : 0);
      const dCacheCreation = row.cache_creation - (prev ? prev.cache_creation : 0);
      const dCost = row.cost_usd - (prev ? prev.cost_usd : 0);
      const dRequests = prev ? 0 : 1;
      const dErrors = (row.success === 0 ? 1 : 0) - (prev && prev.success === 0 ? 1 : 0);
      const dRateLimits = (isRateLimited(row.status_code) ? 1 : 0) - (prev && isRateLimited(prev.status_code) ? 1 : 0);
      const dRetries = (row.is_retry === 1 ? 1 : 0) - (prev && prev.is_retry === 1 ? 1 : 0);
      const dRetryCost = (row.is_retry === 1 ? row.cost_usd : 0) - (prev && prev.is_retry === 1 ? prev.cost_usd : 0);
      const dDrift = (isDrift(row) ? 1 : 0) - (prev && isDrift(prev) ? 1 : 0);

      this.backend.putRequest(row);

      const run = this.ensureRun(row.run_id, row.ts);
      run.tokens_in += dTokensIn;
      run.tokens_out += dTokensOut;
      run.cache_read += dCacheRead;
      run.cache_creation += dCacheCreation;
      run.cost_usd += dCost;
      run.request_count += dRequests;
      run.error_count += dErrors;
      run.rate_limit_count += dRateLimits;
      run.retry_count += dRetries;
      run.retry_cost_usd += dRetryCost;
      run.drift_count += dDrift;
      run.last_seen_at = Math.max(run.last_seen_at, row.ts);
      this.backend.putRun(run);

      const agentRow = this.backend.getAgent(row.run_id, row.agent_label, row.thread_id) ?? {
        run_id: row.run_id,
        agent_label: row.agent_label,
        thread_id: row.thread_id,
        agent_source: agent.agent_source,
        agent_fingerprint: agent.agent_fingerprint ?? null,
        first_seen_at: row.ts,
        last_seen_at: row.ts,
        request_count: 0,
        error_count: 0,
        retry_count: 0,
        retry_cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        models_seen: {},
        last_msg_hash: null,
        repeat_count: 0,
        last_status_code: null,
      };
      agentRow.last_seen_at = Math.max(agentRow.last_seen_at, row.ts);
      agentRow.request_count += dRequests;
      agentRow.error_count += dErrors;
      agentRow.retry_count += dRetries;
      agentRow.retry_cost_usd += dRetryCost;
      agentRow.tokens_in += dTokensIn;
      agentRow.tokens_out += dTokensOut;
      agentRow.cost_usd += dCost;
      agentRow.last_status_code = row.status_code;
      if (agent.agent_fingerprint) agentRow.agent_fingerprint = agent.agent_fingerprint;
      if (!prev) {
        agentRow.models_seen[row.model] = (agentRow.models_seen[row.model] ?? 0) + 1;
      }
      this.backend.putAgent(agentRow);

      return { run: cloneRun(run), agent: cloneAgent(agentRow), prev };
    });
  }

  addBaseline(runId: string, deltaUsd: number): void {
    if (!Number.isFinite(deltaUsd) || deltaUsd === 0) return;
    const run = this.backend.getRun(runId);
    if (!run) return;
    run.baseline_usd += deltaUsd;
    this.backend.putRun(run);
  }

  closeRun(runId: string, opts: { status: RunStatus; exit_code?: number | null; now?: number }): RunRow | null {
    const run = this.backend.getRun(runId);
    if (!run) return null;
    run.status = opts.status;
    run.ended_at = opts.now ?? Date.now();
    run.exit_code = opts.exit_code ?? null;
    this.backend.putRun(run);
    return cloneRun(run);
  }

  setCap(runId: string, capUsd: number | null): RunRow | null {
    const run = this.backend.getRun(runId);
    if (!run) return null;
    run.cap_usd = capUsd;
    this.backend.putRun(run);
    return cloneRun(run);
  }

  setLabel(runId: string, label: string): RunRow | null {
    const run = this.backend.getRun(runId);
    if (!run) return null;
    run.label = label;
    this.backend.putRun(run);
    return cloneRun(run);
  }

  /** Records the first cap breach only. Returns true when this call set it. */
  markCapHit(runId: string, ts: number): boolean {
    const run = this.backend.getRun(runId);
    if (!run || run.cap_hit_at !== null) return false;
    run.cap_hit_at = ts;
    this.backend.putRun(run);
    return true;
  }

  setBandStatus(runId: string, status: BandStatus, lo: number | null, hi: number | null): void {
    const run = this.backend.getRun(runId);
    if (!run) return;
    run.band_status = status;
    run.band_lo = lo;
    run.band_hi = hi;
    this.backend.putRun(run);
  }

  setCacheState(runId: string, state: CacheState): void {
    const run = this.backend.getRun(runId);
    if (!run) return;
    run.cache_state = state;
    this.backend.putRun(run);
  }

  listRuns(filter: RunListFilter): { runs: RunRow[]; next_cursor: string | null } {
    const limit = filter.limit ?? 50;
    const cursor = splitCursor(filter.cursor);
    const q: RunQuery = { limit };
    if (filter.status !== undefined) q.status = filter.status;
    if (filter.sinceMs !== undefined) q.minLastSeen = filter.sinceMs;
    if (filter.label !== undefined) q.label = filter.label;
    if (filter.source !== undefined) q.source = filter.source;
    if (filter.tag !== undefined) {
      const idx = filter.tag.indexOf(':');
      if (idx > 0) {
        q.tagKey = filter.tag.slice(0, idx);
        q.tagValue = filter.tag.slice(idx + 1);
      }
    }
    if (cursor) {
      q.cursorTs = cursor.ts;
      q.cursorId = cursor.id;
    }
    const runs = this.backend.queryRuns(q);
    const last = runs[runs.length - 1];
    const next = runs.length === limit && last ? `${last.last_seen_at}:${last.run_id}` : null;
    return { runs, next_cursor: next };
  }

  activeRuns(sinceMs: number): RunRow[] {
    return this.backend.queryRuns({ status: 'running', minLastSeen: sinceMs, limit: 1000 });
  }

  idleRuns(cutoffMs: number): RunRow[] {
    return this.backend.queryRuns({ status: 'running', maxLastSeen: cutoffMs, limit: 1000 });
  }

  childrenOf(runId: string): RunRow[] {
    return this.backend.queryRuns({ parentRunId: runId, limit: 1000 });
  }

  agentsForRun(runId: string): RunAgentRow[] {
    return this.backend.agentsForRun(runId);
  }

  listRequests(
    runId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): { requests: RunRequestRow[]; next_cursor: string | null } {
    const limit = opts.limit ?? 100;
    const cursor = splitCursor(opts.cursor);
    const requests = this.backend.listRequests(runId, limit, cursor ? cursor.ts : null, cursor ? cursor.id : null);
    const last = requests[requests.length - 1];
    const next = requests.length === limit && last ? `${last.ts}:${last.trace_id}` : null;
    return { requests, next_cursor: next };
  }

  lastRequestOnThread(runId: string, threadId: string): RunRequestRow | null {
    return this.backend.lastRequestOnThread(runId, threadId);
  }

  requestsSince(runId: string, sinceTs: number): RunRequestRow[] {
    return this.backend.requestsSince(runId, sinceTs);
  }

  // -- alerts --------------------------------------------------------------

  addAlert(a: Omit<RunAlertRow, 'id' | 'delivered'> & { delivered?: 0 | 1 }): RunAlertRow {
    return this.backend.insertAlert({
      ts: a.ts,
      kind: a.kind,
      run_id: a.run_id,
      agent_label: a.agent_label,
      severity: a.severity,
      message: a.message,
      data: a.data,
      delivered: a.delivered ?? 0,
    });
  }

  listAlerts(opts: { sinceTs?: number; limit?: number; run_id?: string } = {}): RunAlertRow[] {
    return this.backend.listAlerts(opts);
  }

  hasAlert(runId: string, kind: RunAlertKind, sinceTs?: number): boolean {
    return this.backend.hasAlert(runId, kind, sinceTs);
  }

  markAlertDelivered(id: number): void {
    this.backend.markAlertDelivered(id);
  }

  // -- label stats ---------------------------------------------------------

  upsertLabelStats(row: LabelStatsRow): void {
    this.backend.putLabelStats(row);
  }

  getLabelStats(label: string, cacheState: string, windowDays: number): LabelStatsRow | null {
    return this.backend.getLabelStats(label, cacheState, windowDays);
  }

  completedRunsForLabel(label: string, sinceMs: number): RunRow[] {
    return this.backend.queryRuns({ status: 'completed', label, minEndedAt: sinceMs, limit: 1000 });
  }

  // -- maintenance ---------------------------------------------------------

  pruneRetention(retentionDays: number, rollupRetentionDays: number, now?: number): { requests: number; runs: number } {
    const at = now ?? Date.now();
    return this.backend.prune(at - retentionDays * DAY_MS, at - rollupRetentionDays * DAY_MS);
  }

  close(): void {
    this.backend.close();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: RunStore | null = null;
let _forceMemory = false;

export function getRunStore(): RunStore {
  if (!_store) _store = new RunStore({ forceMemory: _forceMemory });
  return _store;
}

/** Test helper: close and drop the singleton so the next call re-opens it. */
export function _resetRunStore(): void {
  if (_store) {
    try { _store.close(); } catch { /* already closed */ }
    _store = null;
  }
}

/** Test helper: force the Map fallback (simulates a missing better-sqlite3). */
export function _forceMemoryForTests(force: boolean): void {
  _forceMemory = force;
  _resetRunStore();
}
