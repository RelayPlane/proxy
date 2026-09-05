/**
 * TraceWriter, deterministic per-request trace files for RelayPlane.
 *
 * Writes structured JSONL trace files to ~/.relayplane/traces/{sessionId}/{YYYY-MM-DD}/{traceId}.jsonl
 * and maintains a SQLite index at ~/.relayplane/traces/index.db.
 *
 * CAP 3: Deterministic Traces (Phase 2, Session 2)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';

// ── Public Types ─────────────────────────────────────────────────────────────

export type TraceEventType =
  | 'request.start'
  | 'request.end'
  | 'tool.call'
  | 'tool.result'
  | 'tool.denied'
  | 'model.response.start'
  | 'model.response.end'
  | 'budget.checkpoint'
  | 'budget.threshold.hit'
  | 'model.switch'
  | 'memory.read'
  | 'memory.write'
  | 'session.start'
  | 'session.end';

export interface TracePayload {
  /** Run attribution (request.start) */
  runId?: string;
  agentLabel?: string;
  threadId?: string;
  model?: string;
  modelUsed?: string;
  systemPromptHash?: string;
  messageCount?: number;
  requestedTools?: string[];
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  finishReason?: string;
  toolName?: string;
  toolInputHash?: string;
  toolOutputHash?: string;
  toolInputPreview?: string;
  sessionCostUsd?: number;
  sessionCapUsd?: number;
  sessionPct?: number;
  fromModel?: string;
  toModel?: string;
  switchReason?: string;
  memoryLayer?: 'semantic' | 'episodic' | 'procedural';
  memoryKeysAccessed?: string[];
}

export interface TraceEvent {
  traceId: string;
  sessionId: string;
  parentTraceId?: string;
  agentId?: string;
  sequence: number;
  timestamp: number;
  eventType: TraceEventType;
  durationMs?: number;
  error?: { code: string; message: string; retryable: boolean };
  payload: TracePayload;
}

export interface SessionGraph {
  sessionId: string;
  rootTraceId: string;
  startedAt: number;
  endedAt?: number;
  nodes: Array<{
    id: string;
    type: 'request' | 'tool-call' | 'subagent';
    label: string;
    startedAt: number;
    durationMs?: number;
    costUsd?: number;
    outcome?: 'success' | 'failure' | 'denied';
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: 'spawned' | 'called' | 'replied';
    timestamp: number;
  }>;
}

export interface TracesConfig {
  enabled: boolean;
  /** Store full request bodies for replay (default: false, hashes only) */
  storeFullRequests: boolean;
  retentionDays: number;
  directory: string;
  maxDiskMb: number;
}

export interface ReplayResult {
  originalTraceId: string;
  replayTraceId: string;
  matchScore: number;
  diffs: Array<{ field: string; original: unknown; replayed: unknown }>;
}

export interface ExportOptions {
  format: 'jsonl' | 'csv' | 'markdown' | 'traceops';
  sessionIds?: string[];
  fromTimestamp?: number;
  toTimestamp?: number;
  includeToolInputs?: boolean;
  outputPath?: string;
}

/** Input type for write(), partial event (traceId, sessionId, sequence, timestamp filled in) */
export interface WriteEventInput {
  eventType: TraceEventType;
  parentTraceId?: string;
  agentId?: string;
  durationMs?: number;
  error?: { code: string; message: string; retryable: boolean };
  payload?: TracePayload;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export function defaultTracesConfig(): TracesConfig {
  return {
    enabled: true,
    storeFullRequests: false,
    retentionDays: 30,
    directory: path.join(os.homedir(), '.relayplane', 'traces'),
    maxDiskMb: 500,
  };
}

// ── TraceWriter ───────────────────────────────────────────────────────────────

export class TraceWriter {
  private static _instance: TraceWriter | null = null;

  private db: Database.Database | null = null;
  private readonly config: TracesConfig;
  private readonly baseDir: string;

  // Per-session monotonic sequence (across all traces in a session)
  private readonly sessionSequences = new Map<string, number>();
  // Per-trace event count (for trace_index.event_count)
  private readonly traceEventCounts = new Map<string, number>();
  // Per-trace start timestamp
  private readonly traceStartTimes = new Map<string, number>();
  // In-memory session graphs (flushed on session.end or shutdown)
  private readonly sessionGraphs = new Map<string, SessionGraph>();
  // Per-session idle timers (emit session.end after 60s of inactivity)
  private readonly sessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Sessions already announced with session.start
  private readonly knownSessions = new Set<string>();

  private constructor(config: TracesConfig) {
    this.config = config;
    // Normalise ~ to home dir
    this.baseDir = config.directory.startsWith('~')
      ? config.directory.replace(/^~/, os.homedir())
      : config.directory;

    if (config.enabled) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
        this.initDb();
        this.pruneOldFiles();
      } catch (err) {
        console.error('[trace-writer] init failed:', err);
      }
    }
  }

  static getInstance(config?: TracesConfig): TraceWriter {
    if (!TraceWriter._instance) {
      TraceWriter._instance = new TraceWriter(config ?? defaultTracesConfig());
    }
    return TraceWriter._instance;
  }

  /** Replace the singleton (for testing / config reload) */
  static reset(): void {
    if (TraceWriter._instance) {
      TraceWriter._instance.shutdown();
      TraceWriter._instance = null;
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── DB ───────────────────────────────────────────────────────────────────

  private initDb(): void {
    const dbPath = path.join(this.baseDir, 'index.db');
    try {
      this.db = new Database(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trace_index (
          trace_id        TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL,
          parent_trace_id TEXT,
          event_count     INTEGER DEFAULT 0,
          started_at      INTEGER NOT NULL,
          ended_at        INTEGER,
          duration_ms     INTEGER,
          cost_usd        REAL,
          model_used      TEXT,
          tool_names      TEXT,
          trace_file      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_index(session_id);
        CREATE INDEX IF NOT EXISTS idx_trace_started  ON trace_index(started_at);

        CREATE TABLE IF NOT EXISTS session_graphs (
          session_id        TEXT PRIMARY KEY,
          root_trace_id     TEXT,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER,
          trace_count       INTEGER DEFAULT 0,
          tool_call_count   INTEGER DEFAULT 0,
          total_cost_usd    REAL    DEFAULT 0,
          graph_json        TEXT
        );
      `);
    } catch (err) {
      console.error('[trace-writer] DB init failed:', err);
      this.db = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private traceFilePath(sessionId: string, traceId: string, ts: number): string {
    const d = new Date(ts);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const resolved = path.resolve(this.baseDir, sessionId, dateStr, `${traceId}.jsonl`);
    // Guard against path traversal via malformed sessionId or traceId
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new Error(`[trace-writer] path traversal detected: ${resolved}`);
    }
    return resolved;
  }

  private traceRelPath(sessionId: string, traceId: string, ts: number): string {
    const d = new Date(ts);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${sessionId}/${dateStr}/${traceId}.jsonl`;
  }

  /** Estimate total size of baseDir in bytes (best-effort, non-recursive to keep it fast). */
  private estimateDirSizeBytes(): number {
    try {
      let total = 0;
      const walk = (dir: string, depth: number): void => {
        if (depth > 5) return; // cap recursion
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isFile()) {
            try { total += fs.statSync(full).size; } catch {}
          } else if (entry.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      };
      walk(this.baseDir, 0);
      return total;
    } catch {
      return 0;
    }
  }

  /** Returns true if writing is allowed under the maxDiskMb cap. */
  private isDiskBudgetOk(): boolean {
    const limitBytes = this.config.maxDiskMb * 1024 * 1024;
    return this.estimateDirSizeBytes() < limitBytes;
  }

  private nextSequence(sessionId: string): number {
    const n = (this.sessionSequences.get(sessionId) ?? 0) + 1;
    this.sessionSequences.set(sessionId, n);
    return n;
  }

  private resetIdleTimer(sessionId: string): void {
    const existing = this.sessionIdleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.endSession(sessionId);
    }, 60_000);
    // Allow process to exit without waiting for idle timers
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.sessionIdleTimers.set(sessionId, timer);
  }

  // ── Session Graph ────────────────────────────────────────────────────────

  private updateGraph(sessionId: string, traceId: string, event: TraceEvent): void {
    let graph = this.sessionGraphs.get(sessionId);
    if (!graph) {
      graph = {
        sessionId,
        rootTraceId: traceId,
        startedAt: event.timestamp,
        nodes: [],
        edges: [],
      };
      this.sessionGraphs.set(sessionId, graph);
    }

    if (event.eventType === 'request.start') {
      graph.nodes.push({
        id: traceId,
        type: 'request',
        label: event.payload.model ?? 'unknown',
        startedAt: event.timestamp,
      });
    } else if (event.eventType === 'request.end') {
      const node = graph.nodes.find(n => n.id === traceId);
      if (node) {
        node.durationMs = event.durationMs;
        node.costUsd = event.payload.costUsd;
        node.outcome = event.error ? 'failure' : 'success';
      }
    } else if (event.eventType === 'tool.call' || event.eventType === 'tool.denied') {
      const nodeId = `${traceId}:tool:${event.sequence}`;
      graph.nodes.push({
        id: nodeId,
        type: 'tool-call',
        label: event.payload.toolName ?? 'unknown',
        startedAt: event.timestamp,
        outcome: event.eventType === 'tool.denied' ? 'denied' : undefined,
      });
      graph.edges.push({
        from: traceId,
        to: nodeId,
        type: 'called',
        timestamp: event.timestamp,
      });
    }
  }

  // ── Core write ───────────────────────────────────────────────────────────

  async write(sessionId: string, traceId: string, input: WriteEventInput): Promise<void> {
    if (!this.config.enabled) return;

    const now = Date.now();

    // Track trace start time on first event for this trace
    if (!this.traceStartTimes.has(traceId)) {
      this.traceStartTimes.set(traceId, now);
    }

    // Emit session.start the first time we see this session
    if (input.eventType === 'request.start' && !this.knownSessions.has(sessionId)) {
      this.knownSessions.add(sessionId);
      this.upsertSessionGraphRecord(sessionId, traceId, now);
      // Write session.start synchronously (avoids recursive async)
      this.writeEventSync(sessionId, traceId, now, {
        eventType: 'session.start',
        payload: {},
      });
    }

    this.writeEventSync(sessionId, traceId, now, input);
    this.resetIdleTimer(sessionId);
  }

  private writeEventSync(
    sessionId: string,
    traceId: string,
    now: number,
    input: WriteEventInput,
  ): void {
    const sequence = this.nextSequence(sessionId);
    const event: TraceEvent = {
      traceId,
      sessionId,
      parentTraceId: input.parentTraceId,
      agentId: input.agentId,
      sequence,
      timestamp: now,
      eventType: input.eventType,
      durationMs: input.durationMs,
      error: input.error,
      payload: input.payload ?? {},
    };

    this.updateGraph(sessionId, traceId, event);

    const startTs = this.traceStartTimes.get(traceId) ?? now;
    let filePath: string;
    try {
      filePath = this.traceFilePath(sessionId, traceId, startTs);
    } catch (err) {
      console.error('[trace-writer] write rejected:', err);
      return;
    }

    if (!this.isDiskBudgetOk()) {
      console.error(`[trace-writer] disk budget exceeded (maxDiskMb=${this.config.maxDiskMb}); dropping event`);
      return;
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    } catch (err) {
      console.error('[trace-writer] write failed:', err);
    }

    const count = (this.traceEventCounts.get(traceId) ?? 0) + 1;
    this.traceEventCounts.set(traceId, count);
  }

  // ── Finalize (update index.db after response sent) ───────────────────────

  async finalizeTrace(
    traceId: string,
    sessionId: string,
    meta: { costUsd?: number; modelUsed?: string; durationMs?: number },
  ): Promise<void> {
    if (!this.config.enabled || !this.db) return;

    const startedAt = this.traceStartTimes.get(traceId) ?? Date.now();
    const endedAt = Date.now();
    const eventCount = this.traceEventCounts.get(traceId) ?? 0;

    const graph = this.sessionGraphs.get(sessionId);
    const toolCalls = graph?.nodes.filter(n => n.type === 'tool-call') ?? [];
    const toolNames = [...new Set(toolCalls.map(n => n.label))];

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO trace_index
            (trace_id, session_id, event_count, started_at, ended_at, duration_ms, cost_usd, model_used, tool_names, trace_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          traceId,
          sessionId,
          eventCount,
          startedAt,
          endedAt,
          meta.durationMs ?? null,
          meta.costUsd ?? null,
          meta.modelUsed ?? null,
          JSON.stringify(toolNames),
          this.traceRelPath(sessionId, traceId, startedAt),
        );

      this.db
        .prepare(
          `UPDATE session_graphs
           SET trace_count = trace_count + 1,
               tool_call_count = tool_call_count + ?,
               total_cost_usd  = total_cost_usd  + ?
           WHERE session_id = ?`,
        )
        .run(toolCalls.length, meta.costUsd ?? 0, sessionId);
    } catch (err) {
      console.error('[trace-writer] finalizeTrace failed:', err);
    }
  }

  // ── Session end ──────────────────────────────────────────────────────────

  async endSession(sessionId: string): Promise<void> {
    if (!this.config.enabled || !this.db) return;

    const graph = this.sessionGraphs.get(sessionId);
    if (!graph) return;

    graph.endedAt = Date.now();

    try {
      this.db
        .prepare(
          `UPDATE session_graphs SET ended_at = ?, graph_json = ? WHERE session_id = ?`,
        )
        .run(graph.endedAt, JSON.stringify(graph), sessionId);
    } catch (err) {
      console.error('[trace-writer] endSession failed:', err);
    }

    this.sessionGraphs.delete(sessionId);
    this.sessionSequences.delete(sessionId);
    const timer = this.sessionIdleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.sessionIdleTimers.delete(sessionId);
  }

  private upsertSessionGraphRecord(sessionId: string, rootTraceId: string, startedAt: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_graphs (session_id, root_trace_id, started_at)
           VALUES (?, ?, ?)`,
        )
        .run(sessionId, rootTraceId, startedAt);
    } catch (err) {
      console.error('[trace-writer] upsertSessionGraphRecord failed:', err);
    }
  }

  // ── REST / MCP queries ───────────────────────────────────────────────────

  getRecentTraces(limit = 20): unknown[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT trace_id, session_id, started_at, ended_at, duration_ms, cost_usd, model_used, tool_names, event_count
           FROM trace_index
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(Math.min(limit, 100)) as unknown[];
    } catch {
      return [];
    }
  }

  getSessionGraph(sessionId: string): SessionGraph | null {
    // In-memory first (session still active)
    const live = this.sessionGraphs.get(sessionId);
    if (live) return live;

    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(`SELECT graph_json FROM session_graphs WHERE session_id = ?`)
        .get(sessionId) as { graph_json: string | null } | undefined;
      if (row?.graph_json) return JSON.parse(row.graph_json) as SessionGraph;
    } catch {}
    return null;
  }

  // ── Events reader ────────────────────────────────────────────────────────

  /** Read raw JSONL events for a trace by traceId. Returns parsed events array. */
  getTraceEvents(traceId: string): TraceEvent[] {
    if (!this.db) return [];
    try {
      const row = this.db
        .prepare(`SELECT trace_file FROM trace_index WHERE trace_id = ?`)
        .get(traceId) as { trace_file: string } | undefined;
      if (!row) return [];
      const fullPath = path.join(this.baseDir, row.trace_file);
      if (!fs.existsSync(fullPath)) return [];
      const content = fs.readFileSync(fullPath, 'utf-8');
      return content
        .split('\n')
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l) as TraceEvent; } catch { return null; }
        })
        .filter((e): e is TraceEvent => e !== null);
    } catch {
      return [];
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────

  async export(options: ExportOptions): Promise<string> {
    if (!this.db) {
      if (options.format === 'markdown') {
        return '# RelayPlane Trace Export\n\nTrace index DB not available.\n';
      }
      return '';
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sessionIds?.length) {
      conditions.push(`session_id IN (${options.sessionIds.map(() => '?').join(',')})`);
      params.push(...options.sessionIds);
    }
    if (options.fromTimestamp != null) {
      conditions.push('started_at >= ?');
      params.push(options.fromTimestamp);
    }
    if (options.toTimestamp != null) {
      conditions.push('started_at <= ?');
      params.push(options.toTimestamp);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM trace_index ${where} ORDER BY started_at DESC`)
      .all(...params) as Record<string, unknown>[];

    switch (options.format) {
      case 'jsonl':
        return rows.map(r => JSON.stringify(r)).join('\n');

      case 'markdown': {
        const lines = [
          '# RelayPlane Trace Export',
          '',
          `Exported: ${new Date().toISOString()}`,
          `Total traces: ${rows.length}`,
          '',
          '| Trace ID | Session | Started | Duration | Cost | Model | Tools |',
          '|----------|---------|---------|----------|------|-------|-------|',
        ];
        for (const row of rows) {
          const started = new Date(row['started_at'] as number).toISOString();
          const dur = row['duration_ms'] != null ? `${row['duration_ms']}ms` : '-';
          const cost =
            row['cost_usd'] != null ? `$${(row['cost_usd'] as number).toFixed(4)}` : '-';
          const tools = row['tool_names']
            ? (JSON.parse(row['tool_names'] as string) as string[]).join(', ') || '-'
            : '-';
          lines.push(
            `| ${(row['trace_id'] as string).slice(0, 8)}… | ${(row['session_id'] as string).slice(0, 8)}… | ${started} | ${dur} | ${cost} | ${row['model_used'] ?? '-'} | ${tools} |`,
          );
        }
        return lines.join('\n');
      }

      case 'traceops': {
        // OTLP-like spans
        const spans = rows.map(row => ({
          traceId: row['trace_id'],
          spanId: (row['trace_id'] as string).replace(/-/g, '').slice(0, 16),
          parentSpanId: null,
          startTimeUnixNano: (row['started_at'] as number) * 1_000_000,
          durationNano: ((row['duration_ms'] as number | null) ?? 0) * 1_000_000,
          attributes: [
            { key: 'session.id', value: { stringValue: row['session_id'] } },
            { key: 'model.used', value: { stringValue: row['model_used'] ?? '' } },
            { key: 'cost.usd', value: { doubleValue: row['cost_usd'] ?? 0 } },
          ],
        }));
        return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }, null, 2);
      }

      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  replay(_traceId: string): Promise<ReplayResult> {
    if (!this.config.storeFullRequests) {
      return Promise.reject(
        new Error(
          'Replay requires storeFullRequests=true. ' +
            'Set config.traces.storeFullRequests = true to enable replay.',
        ),
      );
    }
    return Promise.reject(new Error('Replay not yet implemented for storeFullRequests=true'));
  }

  // ── Retention ────────────────────────────────────────────────────────────

  pruneOldFiles(): void {
    if (!this.db) return;
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    try {
      const old = this.db
        .prepare(`SELECT trace_file, trace_id FROM trace_index WHERE started_at < ?`)
        .all(cutoff) as { trace_file: string; trace_id: string }[];

      for (const row of old) {
        try {
          fs.unlinkSync(path.join(this.baseDir, row.trace_file));
        } catch {}
      }

      if (old.length > 0) {
        this.db.prepare(`DELETE FROM trace_index WHERE started_at < ?`).run(cutoff);
      }

      this.db
        .prepare(
          `DELETE FROM session_graphs WHERE ended_at IS NOT NULL AND ended_at < ?`,
        )
        .run(cutoff);
    } catch (err) {
      console.error('[trace-writer] pruneOldFiles failed:', err);
    }
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  shutdown(): void {
    for (const timer of this.sessionIdleTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionIdleTimers.clear();

    for (const [sessionId, graph] of this.sessionGraphs) {
      if (this.db) {
        graph.endedAt = Date.now();
        try {
          this.db
            .prepare(
              `UPDATE session_graphs SET ended_at = ?, graph_json = ? WHERE session_id = ?`,
            )
            .run(graph.endedAt, JSON.stringify(graph), sessionId);
        } catch {}
      }
    }
    this.sessionGraphs.clear();

    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }
}

// ── Convenience hash helpers (exported for standalone-proxy.ts) ──────────────

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
