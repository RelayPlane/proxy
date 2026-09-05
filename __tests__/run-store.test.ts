import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import {
  getRunStore,
  nearestRankPercentile,
  _forceMemoryForTests,
  _resetRunStore,
  type RunRequestRow,
} from '../src/run-store.js';

const require2 = createRequire(__filename);

let home = '';
let savedOverride: string | undefined;

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-run-store-'));
}

function request(over: Partial<RunRequestRow> & Pick<RunRequestRow, 'trace_id' | 'run_id'>): RunRequestRow {
  return {
    agent_label: 'coder',
    thread_id: 'thread-1',
    history_id: null,
    ts: 1_000_000,
    model: 'claude-sonnet-4-6',
    requested_model: null,
    provider: 'anthropic',
    attempt: 1,
    is_retry: 0,
    retry_reason: null,
    cache_state: 'cold',
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_creation: 0,
    cost_usd: 0,
    cost_estimated: 0,
    latency_ms: 10,
    success: 1,
    status_code: 200,
    complexity: null,
    task_type: null,
    ...over,
  };
}

beforeEach(() => {
  savedOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  home = makeHome();
  process.env['RELAYPLANE_HOME_OVERRIDE'] = home;
  _forceMemoryForTests(false);
  _resetRunStore();
});

afterEach(() => {
  _forceMemoryForTests(false);
  _resetRunStore();
  if (savedOverride === undefined) delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  else process.env['RELAYPLANE_HOME_OVERRIDE'] = savedOverride;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('RunStore schema', () => {
  it('creates runs.db and every table from an empty home', () => {
    const store = getRunStore();
    expect(store.isSqlite).toBe(true);
    expect(fs.existsSync(path.join(home, '.relayplane', 'runs.db'))).toBe(true);

    const opened = store.openRun({ run_id: 'r1', run_source: 'header', tags: { env: 'ci' }, now: 1000 });
    expect(opened.created).toBe(true);
    expect(opened.run.status).toBe('running');
    expect(opened.run.tags).toEqual({ env: 'ci' });
    expect(opened.run.band_status).toBe('none');

    store.upsertRequest(request({ trace_id: 't1', run_id: 'r1', cost_usd: 0.5 }), { agent_source: 'inferred' });
    store.addAlert({
      ts: 1000, kind: 'run.cap_hit', run_id: 'r1', agent_label: 'coder',
      severity: 'critical', message: 'capped', data: { spent: 1 },
    });
    store.upsertLabelStats({
      label: 'nightly', cache_state: 'cold', window_days: 30, n: 5,
      p25: 1, p50: 2, p75: 3, p90: 4, dominant_models: { coder: 'claude-sonnet-4-6' }, updated_at: 1000,
    });

    expect(store.listRequests('r1').requests).toHaveLength(1);
    expect(store.listAlerts({}).length).toBe(1);
    expect(store.getLabelStats('nightly', 'cold', 30)?.dominant_models).toEqual({ coder: 'claude-sonnet-4-6' });
    expect(store.agentsForRun('r1')).toHaveLength(1);
  });

  it('parses JSON columns back into objects, never strings', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'r1', run_source: 'header', tags: { team: 'core', env: 'prod' }, now: 1 });
    store.upsertRequest(request({ trace_id: 't1', run_id: 'r1', model: 'm1' }), { agent_source: 'header' });
    _resetRunStore();

    const reopened = getRunStore();
    const run = reopened.getRun('r1');
    expect(run).not.toBeNull();
    expect(typeof run!.tags).toBe('object');
    expect(run!.tags).toEqual({ team: 'core', env: 'prod' });
    const agent = reopened.agentsForRun('r1')[0];
    expect(agent.models_seen).toEqual({ m1: 1 });
    const alert = reopened.addAlert({
      ts: 5, kind: 'run.stale_closed', run_id: 'r1', agent_label: null,
      severity: 'info', message: 'idle', data: { nested: { ok: true } },
    });
    expect(reopened.listAlerts({ run_id: 'r1' })[0].data).toEqual({ nested: { ok: true } });
    expect(alert.id).toBeGreaterThan(0);
  });

  it('migrates a legacy database that predates the client_key column', () => {
    const dir = path.join(home, '.relayplane');
    fs.mkdirSync(dir, { recursive: true });
    const Database = require2('better-sqlite3') as typeof import('better-sqlite3');
    const raw = new Database(path.join(dir, 'runs.db'));
    // v1 shape: identical to today minus `client_key`.
    raw.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, parent_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0, label TEXT,
        run_source TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER,
        reopen_count INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0, rate_limit_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0, retry_cost_usd REAL NOT NULL DEFAULT 0,
        drift_count INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
        cache_creation INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        baseline_usd REAL NOT NULL DEFAULT 0, cap_usd REAL, cap_hit_at INTEGER, cache_state TEXT,
        band_lo REAL, band_hi REAL, band_status TEXT NOT NULL DEFAULT 'none',
        tags TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
      INSERT INTO runs (run_id, run_source, status, started_at, last_seen_at, created_at)
      VALUES ('legacy', 'header', 'running', 10, 10, 10);
    `);
    const columnsBefore = raw.prepare(`PRAGMA table_info(runs)`).all();
    raw.close();
    expect(JSON.stringify(columnsBefore)).not.toContain('client_key');

    const store = getRunStore();
    expect(store.isSqlite).toBe(true);
    const legacy = store.getRun('legacy');
    expect(legacy).not.toBeNull();
    expect(legacy!.client_key).toBeNull();

    // The added column is writable and readable.
    store.openRun({ run_id: 'legacy', run_source: 'header', client_key: 'abcd1234', now: 20 });
    expect(store.getRun('legacy')!.client_key).toBe('abcd1234');

    const verify = new Database(path.join(dir, 'runs.db'), { readonly: true });
    const columnsAfter = verify.prepare(`PRAGMA table_info(runs)`).all();
    verify.close();
    expect(JSON.stringify(columnsAfter)).toContain('client_key');
  });
});

describe('RunStore rollups', () => {
  it('accumulates exact per-run sums across 50 interleaved requests on 3 runs', () => {
    const store = getRunStore();
    const runIds = ['run-a', 'run-b', 'run-c'];
    for (const id of runIds) store.openRun({ run_id: id, run_source: 'header', now: 1 });

    const expected = new Map<string, {
      tokens_in: number; tokens_out: number; cache_read: number; cache_creation: number;
      cost_usd: number; request_count: number; error_count: number; rate_limit_count: number;
      retry_count: number; retry_cost_usd: number; drift_count: number;
    }>();
    for (const id of runIds) {
      expected.set(id, {
        tokens_in: 0, tokens_out: 0, cache_read: 0, cache_creation: 0, cost_usd: 0,
        request_count: 0, error_count: 0, rate_limit_count: 0, retry_count: 0,
        retry_cost_usd: 0, drift_count: 0,
      });
    }

    for (let i = 0; i < 50; i++) {
      const runId = runIds[i % 3];
      const failed = i % 7 === 0;
      const rateLimited = i % 11 === 0;
      const retry = i % 5 === 0;
      const drift = i % 4 === 0;
      const row = request({
        trace_id: `trace-${i}`,
        run_id: runId,
        agent_label: `agent-${i % 2}`,
        thread_id: `thread-${i % 2}`,
        ts: 1_000_000 + i,
        tokens_in: 100 + i,
        tokens_out: 10 + i,
        cache_read: i,
        cache_creation: 2 * i,
        cost_usd: 0.001 * (i + 1),
        model: 'claude-sonnet-4-6',
        requested_model: drift ? 'claude-opus-4-6' : null,
        is_retry: retry ? 1 : 0,
        retry_reason: retry ? 'header' : null,
        success: failed ? 0 : 1,
        status_code: rateLimited ? 429 : failed ? 500 : 200,
      });
      store.upsertRequest(row, { agent_source: 'inferred', agent_fingerprint: 'fp' });

      const acc = expected.get(runId)!;
      acc.tokens_in += row.tokens_in;
      acc.tokens_out += row.tokens_out;
      acc.cache_read += row.cache_read;
      acc.cache_creation += row.cache_creation;
      acc.cost_usd += row.cost_usd;
      acc.request_count += 1;
      if (row.success === 0) acc.error_count += 1;
      if (row.status_code === 429 || row.status_code === 529) acc.rate_limit_count += 1;
      if (row.is_retry === 1) { acc.retry_count += 1; acc.retry_cost_usd += row.cost_usd; }
      if (row.requested_model !== null && row.requested_model !== row.model) acc.drift_count += 1;
    }

    for (const id of runIds) {
      const run = store.getRun(id)!;
      const acc = expected.get(id)!;
      expect(run.tokens_in).toBe(acc.tokens_in);
      expect(run.tokens_out).toBe(acc.tokens_out);
      expect(run.cache_read).toBe(acc.cache_read);
      expect(run.cache_creation).toBe(acc.cache_creation);
      expect(run.cost_usd).toBeCloseTo(acc.cost_usd, 10);
      expect(run.request_count).toBe(acc.request_count);
      expect(run.error_count).toBe(acc.error_count);
      expect(run.rate_limit_count).toBe(acc.rate_limit_count);
      expect(run.retry_count).toBe(acc.retry_count);
      expect(run.retry_cost_usd).toBeCloseTo(acc.retry_cost_usd, 10);
      expect(run.drift_count).toBe(acc.drift_count);
      expect(run.last_seen_at).toBeGreaterThanOrEqual(1_000_000);
    }

    // Agent rollups sum to the run rollups.
    const agents = store.agentsForRun('run-a');
    const agentRequests = agents.reduce((sum, a) => sum + a.request_count, 0);
    expect(agentRequests).toBe(expected.get('run-a')!.request_count);
    expect(agents[0].cost_usd).toBeGreaterThanOrEqual(agents[agents.length - 1].cost_usd);
  });

  it('is idempotent per trace id (INSERT OR REPLACE, rollups by delta)', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'r1', run_source: 'header', now: 1 });

    store.upsertRequest(
      request({ trace_id: 'same', run_id: 'r1', cost_usd: 0.01, tokens_in: 100, tokens_out: 10, success: 0, status_code: 500 }),
      { agent_source: 'inferred' },
    );
    const second = store.upsertRequest(
      request({ trace_id: 'same', run_id: 'r1', cost_usd: 0.04, tokens_in: 400, tokens_out: 40, success: 1, status_code: 200 }),
      { agent_source: 'inferred' },
    );

    expect(second.prev).not.toBeNull();
    const run = store.getRun('r1')!;
    expect(run.request_count).toBe(1);
    expect(run.cost_usd).toBeCloseTo(0.04, 10);
    expect(run.tokens_in).toBe(400);
    expect(run.tokens_out).toBe(40);
    expect(run.error_count).toBe(0);
    expect(store.listRequests('r1').requests).toHaveLength(1);
    const agent = store.agentsForRun('r1')[0];
    expect(agent.request_count).toBe(1);
    expect(agent.cost_usd).toBeCloseTo(0.04, 10);
    expect(agent.models_seen).toEqual({ 'claude-sonnet-4-6': 1 });
  });

  it('reopens a closed run and tracks ancestors for a nested id', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'nightly/researcher/sub', parent_run_id: 'nightly/researcher', depth: 2, run_source: 'header', now: 100 });

    const parent = store.getRun('nightly/researcher');
    const grandparent = store.getRun('nightly');
    expect(parent).not.toBeNull();
    expect(parent!.depth).toBe(1);
    expect(parent!.parent_run_id).toBe('nightly');
    expect(grandparent!.depth).toBe(0);
    expect(grandparent!.parent_run_id).toBeNull();
    expect(store.childrenOf('nightly').map((r) => r.run_id)).toEqual(['nightly/researcher']);

    store.closeRun('nightly/researcher/sub', { status: 'completed', now: 200 });
    const reopened = store.openRun({ run_id: 'nightly/researcher/sub', run_source: 'header', now: 300 });
    expect(reopened.reopened).toBe(true);
    expect(reopened.created).toBe(false);
    expect(reopened.run.status).toBe('running');
    expect(reopened.run.ended_at).toBeNull();
    expect(reopened.run.reopen_count).toBe(1);
  });

  it('keeps the highest cap, the first label and existing tags on reopen', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'r1', run_source: 'header', cap_usd: 1, label: 'first', tags: { env: 'prod' }, now: 1 });
    store.openRun({ run_id: 'r1', run_source: 'header', cap_usd: 0.5, label: 'second', tags: { env: 'dev', team: 'core' }, now: 2 });
    const run = store.getRun('r1')!;
    expect(run.cap_usd).toBe(1);
    expect(run.label).toBe('first');
    expect(run.tags).toEqual({ env: 'prod', team: 'core' });

    store.openRun({ run_id: 'r1', run_source: 'header', cap_usd: 9, now: 3 });
    expect(store.getRun('r1')!.cap_usd).toBe(9);
    expect(store.markCapHit('r1', 42)).toBe(true);
    expect(store.markCapHit('r1', 99)).toBe(false);
    expect(store.getRun('r1')!.cap_hit_at).toBe(42);
  });

  it('lists, filters, paginates and finds runs', () => {
    const store = getRunStore();
    for (let i = 0; i < 5; i++) {
      store.openRun({
        run_id: `r${i}`,
        run_source: i === 0 ? 'inferred_gap' : 'header',
        label: i < 3 ? 'nightly' : 'adhoc',
        tags: { env: i % 2 === 0 ? 'prod' : 'dev' },
        now: 1000 + i,
      });
    }
    const page1 = store.listRuns({ limit: 2 });
    expect(page1.runs.map((r) => r.run_id)).toEqual(['r4', 'r3']);
    expect(page1.next_cursor).toBe('1003:r3');
    const page2 = store.listRuns({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.runs.map((r) => r.run_id)).toEqual(['r2', 'r1']);

    expect(store.listRuns({ label: 'nightly' }).runs).toHaveLength(3);
    expect(store.listRuns({ source: 'inferred_gap' }).runs.map((r) => r.run_id)).toEqual(['r0']);
    expect(store.listRuns({ tag: 'env:dev' }).runs.map((r) => r.run_id)).toEqual(['r3', 'r1']);
    expect(store.activeRuns(1002).map((r) => r.run_id)).toEqual(['r4', 'r3', 'r2']);
    expect(store.idleRuns(1002).map((r) => r.run_id)).toEqual(['r1', 'r0']);

    store.closeRun('r0', { status: 'completed', now: 5000 });
    expect(store.completedRunsForLabel('nightly', 1).map((r) => r.run_id)).toEqual(['r0']);
  });

  it('finds the last request on a thread and requests since a timestamp', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'r1', run_source: 'header', now: 1 });
    for (let i = 0; i < 4; i++) {
      store.upsertRequest(
        request({ trace_id: `t${i}`, run_id: 'r1', thread_id: i % 2 === 0 ? 'even' : 'odd', ts: 100 + i, status_code: 200 + i }),
        { agent_source: 'inferred' },
      );
    }
    expect(store.lastRequestOnThread('r1', 'even')?.trace_id).toBe('t2');
    expect(store.lastRequestOnThread('r1', 'odd')?.trace_id).toBe('t3');
    expect(store.lastRequestOnThread('r1', 'missing')).toBeNull();
    expect(store.requestsSince('r1', 102).map((r) => r.trace_id)).toEqual(['t2', 't3']);
    const page = store.listRequests('r1', { limit: 2 });
    expect(page.requests.map((r) => r.trace_id)).toEqual(['t0', 't1']);
    expect(store.listRequests('r1', { limit: 2, cursor: page.next_cursor! }).requests.map((r) => r.trace_id)).toEqual(['t2', 't3']);
  });

  it('tracks alerts and delivery', () => {
    const store = getRunStore();
    store.openRun({ run_id: 'r1', run_source: 'header', now: 1 });
    const alert = store.addAlert({
      ts: 500, kind: 'run.cost_exceeded', run_id: 'r1', agent_label: 'coder',
      severity: 'warning', message: 'over', data: { cost_usd: 3 },
    });
    expect(alert.delivered).toBe(0);
    expect(store.hasAlert('r1', 'run.cost_exceeded')).toBe(true);
    expect(store.hasAlert('r1', 'run.cap_hit')).toBe(false);
    expect(store.hasAlert('r1', 'run.cost_exceeded', 600)).toBe(false);
    store.markAlertDelivered(alert.id);
    expect(store.listAlerts({ run_id: 'r1' })[0].delivered).toBe(1);
  });

  it('prunes requests on the short window and rollups on the long one', () => {
    const store = getRunStore();
    const now = 1_700_000_000_000;
    const day = 86_400_000;
    store.openRun({ run_id: 'old', run_source: 'header', now: now - 40 * day });
    store.openRun({ run_id: 'fresh', run_source: 'header', now: now - day });
    store.upsertRequest(request({ trace_id: 'old-1', run_id: 'old', ts: now - 40 * day }), { agent_source: 'inferred' });
    store.upsertRequest(request({ trace_id: 'fresh-1', run_id: 'fresh', ts: now - day }), { agent_source: 'inferred' });

    const first = store.pruneRetention(30, 365, now);
    expect(first.requests).toBe(1);
    expect(first.runs).toBe(0);
    expect(store.listRequests('old').requests).toHaveLength(0);
    expect(store.listRequests('fresh').requests).toHaveLength(1);
    expect(store.getRun('old')).not.toBeNull();

    const second = store.pruneRetention(30, 20, now);
    expect(second.runs).toBe(1);
    expect(store.getRun('old')).toBeNull();
    expect(store.getRun('fresh')).not.toBeNull();
    expect(store.agentsForRun('old')).toHaveLength(0);
  });
});

describe('nearestRankPercentile and label stats', () => {
  it('matches a hand-computed nearest-rank set', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRankPercentile(sorted, 25)).toBe(3);
    expect(nearestRankPercentile(sorted, 50)).toBe(5);
    expect(nearestRankPercentile(sorted, 75)).toBe(8);
    expect(nearestRankPercentile(sorted, 90)).toBe(9);
    expect(nearestRankPercentile(sorted, 100)).toBe(10);
    expect(nearestRankPercentile(sorted, 0)).toBe(1);
    expect(nearestRankPercentile([42], 50)).toBe(42);
    expect(nearestRankPercentile([1, 2, 3], 50)).toBe(2);
    expect(nearestRankPercentile([], 50)).toBeNull();
  });

  it('round-trips label stats built from run costs', () => {
    const store = getRunStore();
    const costs = [1.5, 2.5, 3.5, 4.5, 5.5];
    store.upsertLabelStats({
      label: 'nightly',
      cache_state: 'cold',
      window_days: 30,
      n: costs.length,
      p25: nearestRankPercentile(costs, 25),
      p50: nearestRankPercentile(costs, 50),
      p75: nearestRankPercentile(costs, 75),
      p90: nearestRankPercentile(costs, 90),
      dominant_models: { coder: 'claude-sonnet-4-6', researcher: 'claude-opus-4-6' },
      updated_at: 99,
    });
    const stats = store.getLabelStats('nightly', 'cold', 30)!;
    expect(stats.n).toBe(5);
    expect(stats.p25).toBe(2.5);
    expect(stats.p50).toBe(3.5);
    expect(stats.p75).toBe(4.5);
    expect(stats.p90).toBe(5.5);
    expect(stats.dominant_models).toEqual({ coder: 'claude-sonnet-4-6', researcher: 'claude-opus-4-6' });
    expect(store.getLabelStats('nightly', 'warm', 30)).toBeNull();
  });
});

describe('RunStore memory fallback', () => {
  it('implements the same behaviour without better-sqlite3', () => {
    _forceMemoryForTests(true);
    const store = getRunStore();
    expect(store.isSqlite).toBe(false);
    expect(fs.existsSync(path.join(home, '.relayplane', 'runs.db'))).toBe(false);

    store.openRun({ run_id: 'r1', run_source: 'inferred_cc', tags: { env: 'ci' }, cap_usd: 2, now: 10 });
    store.upsertRequest(
      request({ trace_id: 't1', run_id: 'r1', cost_usd: 0.25, tokens_in: 10, is_retry: 1, retry_reason: 'header' }),
      { agent_source: 'inferred', agent_fingerprint: 'fp' },
    );
    store.upsertRequest(
      request({ trace_id: 't1', run_id: 'r1', cost_usd: 0.75, tokens_in: 30, is_retry: 1, retry_reason: 'header' }),
      { agent_source: 'inferred', agent_fingerprint: 'fp' },
    );

    const run = store.getRun('r1')!;
    expect(run.request_count).toBe(1);
    expect(run.cost_usd).toBeCloseTo(0.75, 10);
    expect(run.retry_cost_usd).toBeCloseTo(0.75, 10);
    expect(run.tags).toEqual({ env: 'ci' });
    expect(store.agentsForRun('r1')[0].models_seen).toEqual({ 'claude-sonnet-4-6': 1 });
    expect(store.lastRequestOnThread('r1', 'thread-1')?.trace_id).toBe('t1');

    store.setCacheState('r1', 'warm');
    store.setBandStatus('r1', 'over', 1, 2);
    expect(store.getRun('r1')!.cache_state).toBe('warm');
    expect(store.getRun('r1')!.band_status).toBe('over');
    expect(store.closeRun('r1', { status: 'failed', exit_code: 2, now: 50 })!.exit_code).toBe(2);
    expect(store.listRuns({ status: 'failed' }).runs).toHaveLength(1);

    const alert = store.addAlert({
      ts: 60, kind: 'run.stale_closed', run_id: 'r1', agent_label: null,
      severity: 'info', message: 'idle', data: {},
    });
    store.markAlertDelivered(alert.id);
    expect(store.listAlerts({})[0].delivered).toBe(1);
    const pruned = store.pruneRetention(0, 0, 2_000_000);
    expect(pruned.requests).toBe(1);
    expect(pruned.runs).toBe(1);
    expect(store.getRun('r1')).toBeNull();
  });

  it('returns null and empty lists for unknown ids in both backends', () => {
    const sqliteStore = getRunStore();
    expect(sqliteStore.getRun('nope')).toBeNull();
    expect(sqliteStore.closeRun('nope', { status: 'completed' })).toBeNull();
    expect(sqliteStore.setCap('nope', 1)).toBeNull();
    expect(sqliteStore.setLabel('nope', 'x')).toBeNull();
    expect(sqliteStore.markCapHit('nope', 1)).toBe(false);
    expect(sqliteStore.agentsForRun('nope')).toEqual([]);

    _forceMemoryForTests(true);
    const memStore = getRunStore();
    expect(memStore.getRun('nope')).toBeNull();
    expect(memStore.closeRun('nope', { status: 'completed' })).toBeNull();
    expect(memStore.markCapHit('nope', 1)).toBe(false);
    expect(memStore.listRuns({}).runs).toEqual([]);
  });
});
