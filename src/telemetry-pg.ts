/**
 * PostgreSQL telemetry backend for RelayPlane Proxy.
 *
 * When RELAYPLANE_TELEMETRY_DB is set, this module replaces both JSONL stores
 * (history.jsonl and telemetry.jsonl) with a single PostgreSQL table.
 *
 * The `pg` package is an optional dependency — if it's not installed, the
 * backend is silently unavailable.
 *
 * @packageDocumentation
 */

let Pool: any;
let pool: any = null;
let initialized = false;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS request_history (
  id             BIGSERIAL PRIMARY KEY,
  request_id     TEXT NOT NULL,
  consumer       TEXT NOT NULL DEFAULT 'unknown',
  original_model TEXT NOT NULL,
  target_model   TEXT NOT NULL,
  provider       TEXT NOT NULL,
  latency_ms     INTEGER NOT NULL,
  success        BOOLEAN NOT NULL,
  mode           TEXT NOT NULL,
  escalated      BOOLEAN NOT NULL DEFAULT false,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  task_type      TEXT DEFAULT 'general',
  complexity     TEXT DEFAULT 'simple',
  timestamp      TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_history_timestamp ON request_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_request_history_consumer ON request_history(consumer);
CREATE INDEX IF NOT EXISTS idx_request_history_model ON request_history(target_model);
`;

/**
 * Initialize the pg backend. Returns true if the pool is ready.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initPgBackend(): Promise<boolean> {
  if (initialized) return pool !== null;

  const connString = process.env['RELAYPLANE_TELEMETRY_DB'];
  if (!connString) {
    initialized = true;
    return false;
  }

  try {
    const pg = await import('pg');
    Pool = pg.default?.Pool ?? pg.Pool;
    pool = new Pool({ connectionString: connString, max: 5 });

    // Auto-create table (idempotent)
    await pool.query(CREATE_TABLE_SQL);
    initialized = true;
    console.log('[RelayPlane] PostgreSQL telemetry backend connected');
    return true;
  } catch (err) {
    console.error('[RelayPlane] PostgreSQL backend unavailable:', (err as Error).message);
    pool = null;
    initialized = true;
    return false;
  }
}

/**
 * Returns true if the pg backend is active (pool connected and table created).
 */
export function isPgActive(): boolean {
  return pool !== null;
}

export interface PgHistoryEntry {
  requestId: string;
  consumer: string;
  originalModel: string;
  targetModel: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  mode: string;
  escalated: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  taskType: string;
  complexity: string;
  timestamp: string;
}

/**
 * Record a history entry. Async fire-and-forget — errors are logged, never thrown.
 */
export function recordHistoryPg(entry: PgHistoryEntry): void {
  if (!pool) return;
  pool.query(
    `INSERT INTO request_history
       (request_id, consumer, original_model, target_model, provider,
        latency_ms, success, mode, escalated,
        tokens_in, tokens_out, cost_usd, task_type, complexity, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      entry.requestId,
      entry.consumer,
      entry.originalModel,
      entry.targetModel,
      entry.provider,
      entry.latencyMs,
      entry.success,
      entry.mode,
      entry.escalated,
      entry.tokensIn,
      entry.tokensOut,
      entry.costUsd,
      entry.taskType,
      entry.complexity,
      entry.timestamp,
    ],
  ).catch((err: Error) => {
    console.error('[RelayPlane] pg write error:', err.message);
  });
}

/**
 * Update tokens/cost for the most recent entry matching a request_id.
 */
export function updateHistoryPg(requestId: string, tokensIn: number, tokensOut: number, costUsd: number): void {
  if (!pool) return;
  pool.query(
    `UPDATE request_history SET tokens_in = $1, tokens_out = $2, cost_usd = $3
     WHERE request_id = $4`,
    [tokensIn, tokensOut, costUsd, requestId],
  ).catch((err: Error) => {
    console.error('[RelayPlane] pg update error:', err.message);
  });
}

/**
 * Retrieve recent history entries for dashboard / API endpoints.
 */
export async function getHistoryPg(limit = 50, offset = 0): Promise<PgHistoryEntry[]> {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      `SELECT request_id, consumer, original_model, target_model, provider,
              latency_ms, success, mode, escalated,
              tokens_in, tokens_out, cost_usd, task_type, complexity, timestamp
       FROM request_history
       ORDER BY timestamp DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r: any) => ({
      requestId: r.request_id,
      consumer: r.consumer,
      originalModel: r.original_model,
      targetModel: r.target_model,
      provider: r.provider,
      latencyMs: r.latency_ms,
      success: r.success,
      mode: r.mode,
      escalated: r.escalated,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costUsd: parseFloat(r.cost_usd),
      taskType: r.task_type,
      complexity: r.complexity,
      timestamp: new Date(r.timestamp).toISOString(),
    }));
  } catch (err) {
    console.error('[RelayPlane] pg read error:', (err as Error).message);
    return [];
  }
}

/**
 * Get aggregate stats from pg (for dashboard endpoints).
 */
export async function getStatsPg(days = 7): Promise<{
  totalEvents: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  successRate: number;
  byModel: Array<{ model: string; count: number; costUsd: number }>;
  byConsumer: Array<{ consumer: string; count: number; costUsd: number }>;
}> {
  if (!pool) return { totalEvents: 0, totalCostUsd: 0, avgLatencyMs: 0, successRate: 0, byModel: [], byConsumer: [] };
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const summaryRes = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(AVG(latency_ms), 0)::int AS avg_lat,
              CASE WHEN COUNT(*) > 0
                THEN COUNT(*) FILTER (WHERE success)::float / COUNT(*)
                ELSE 0 END AS success_rate
       FROM request_history WHERE timestamp >= $1`,
      [cutoff],
    );
    const s = summaryRes.rows[0];

    const modelRes = await pool.query(
      `SELECT target_model AS model, COUNT(*)::int AS count, COALESCE(SUM(cost_usd), 0) AS cost
       FROM request_history WHERE timestamp >= $1
       GROUP BY target_model ORDER BY count DESC`,
      [cutoff],
    );

    const consumerRes = await pool.query(
      `SELECT consumer, COUNT(*)::int AS count, COALESCE(SUM(cost_usd), 0) AS cost
       FROM request_history WHERE timestamp >= $1
       GROUP BY consumer ORDER BY count DESC`,
      [cutoff],
    );

    return {
      totalEvents: s.total,
      totalCostUsd: parseFloat(s.cost),
      avgLatencyMs: s.avg_lat,
      successRate: parseFloat(s.success_rate),
      byModel: modelRes.rows.map((r: any) => ({ model: r.model, count: r.count, costUsd: parseFloat(r.cost) })),
      byConsumer: consumerRes.rows.map((r: any) => ({ consumer: r.consumer, count: r.count, costUsd: parseFloat(r.cost) })),
    };
  } catch (err) {
    console.error('[RelayPlane] pg stats error:', (err as Error).message);
    return { totalEvents: 0, totalCostUsd: 0, avgLatencyMs: 0, successRate: 0, byModel: [], byConsumer: [] };
  }
}

/**
 * Get total row count (for pagination).
 */
export async function getHistoryCountPg(): Promise<number> {
  if (!pool) return 0;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM request_history');
    return rows[0].count;
  } catch {
    return 0;
  }
}

/**
 * Gracefully close the pool.
 */
export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  initialized = false;
}
