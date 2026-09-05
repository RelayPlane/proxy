/**
 * PR2 `/v1/runs*` API surface. Every route is exercised against a real spawned
 * proxy (dist/cli.js) with a mock Anthropic upstream, because the point of the
 * API is that an operator can ask "what did this run cost" and get an answer
 * that matches the money the proxy actually recorded.
 */
import * as http from 'node:http';
import * as os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  allUserText,
  anthropicMockUsage,
  passthroughAnthropicConfig,
  waitForRun,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import { estimateCost } from '../src/telemetry.js';
import { EXPORT_COLUMNS } from '../src/run-export.js';

const NATIVE_MODEL = 'claude-sonnet-4-6';

interface RunListRow {
  run_id: string;
  label: string | null;
  status: string;
  cost_usd: number;
  baseline_usd: number;
  agent_count: number;
  savings_usd: number;
  retry_pct: number;
  band_status: string;
}

interface RunDetail {
  run: { run_id: string; status: string; cost_usd: number; exit_code: number | null; request_count: number };
  agents: Array<{ agent_label: string; cost_usd: number; models_seen: Record<string, number>; retry_cost_usd: number }>;
  by_model: Array<{ model: string; request_count: number; cost_usd: number; tokens_in: number; tokens_out: number }>;
  children: Array<{ run_id: string }>;
  retries: { count: number; cost_usd: number; pct: number };
  band: { lo: number | null; hi: number | null; status: string; cache_state: string | null };
  drift: Array<{ agent_label: string; requested_model: string; model: string; count: number }>;
  alerts: Array<{ kind: string; run_id: string }>;
  total_with_children_usd: number;
}

/** First non-internal IPv4 of this machine, or null on a loopback-only box. */
function externalIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** The shared `request` helper always dials 127.0.0.1; the guard needs another source address. */
function requestFrom(hostname: string, port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

describe('/v1/runs API', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('POST /v1/runs mints a run id and hands back a dashboard url', async () => {
    const res = await request(proxy.port, '/v1/runs', { body: { label: 'minted' } });
    expect(res.status, res.text).toBe(200);
    const body = res.json() as { run_id: string; dashboard_url: string; run: { label: string; status: string } };
    expect(body.run_id).toMatch(/^minted-\d{8}-[0-9a-f]{6}$/);
    expect(body.dashboard_url).toContain(`http://localhost:${proxy.port}/dashboard#run=`);
    expect(body.run.label).toBe('minted');
    expect(body.run.status).toBe('running');
  }, 20_000);

  it('registers a run, prices two requests into it, and closes it as failed on exit 2', async () => {
    const register = await request(proxy.port, '/v1/runs', { body: { run_id: 'ep-run', label: 'ep-lab' } });
    expect(register.status, register.text).toBe(200);

    // Both turns share a first user message, so they land on one thread and
    // therefore one agent row: the same shape a real multi-turn agent produces.
    const opener = 'ep-run opens the thread and keeps it open.';
    const turns = ['ep-run first prompt about routing.', 'ep-run second, slightly longer prompt about cost.'];
    for (const text of turns) {
      const res = await request(proxy.port, '/v1/messages', {
        body: messagesBody(opener, {
          messages: [
            { role: 'user', content: opener },
            { role: 'assistant', content: 'PONG' },
            { role: 'user', content: text },
          ],
        }),
        headers: { 'X-RelayPlane-Run': 'ep-run', 'X-RelayPlane-Agent': 'coder' },
      });
      expect(res.status, res.text).toBe(200);
      expect(res.headers['x-relayplane-run-id']).toBe('ep-run');
    }
    await waitForRun(home, 'ep-run', 2);

    let expectedCost = 0;
    for (const text of turns) {
      const call = upstream.calls.find((c) => allUserText(c.body).includes(text));
      expect(call, `no upstream call for ${text}`).toBeTruthy();
      const usage = anthropicMockUsage(allUserText(call!.body));
      expectedCost += estimateCost(NATIVE_MODEL, usage.input_tokens, usage.output_tokens);
    }

    const detail = (await request(proxy.port, '/v1/runs/ep-run')).json() as RunDetail;
    expect(detail.run.request_count).toBe(2);
    expect(detail.run.cost_usd).toBeCloseTo(expectedCost, 10);
    expect(detail.agents).toHaveLength(1);
    expect(detail.agents[0]!.agent_label).toBe('coder');
    expect(detail.agents[0]!.models_seen[NATIVE_MODEL]).toBe(2);
    expect(detail.by_model).toHaveLength(1);
    expect(detail.by_model[0]!.model).toBe(NATIVE_MODEL);
    expect(detail.by_model[0]!.request_count).toBe(2);
    expect(detail.by_model[0]!.cost_usd).toBeCloseTo(expectedCost, 10);
    expect(detail.by_model[0]!.tokens_out).toBe(14);
    expect(detail.children).toEqual([]);
    expect(detail.retries).toEqual({ count: 0, cost_usd: 0, pct: 0 });
    expect(detail.band.status).toBe('none');
    expect(detail.band.cache_state).toBe('cold');
    expect(detail.drift).toEqual([]);
    expect(Array.isArray(detail.alerts)).toBe(true);
    expect(detail.total_with_children_usd).toBeCloseTo(expectedCost, 10);

    const ended = await request(proxy.port, '/v1/runs/ep-run/end', { body: { exit_code: 2 } });
    expect(ended.status, ended.text).toBe(200);
    const closed = ended.json() as RunDetail;
    expect(closed.run.status).toBe('failed');
    expect(closed.run.exit_code).toBe(2);
    expect(closed.run.cost_usd).toBeCloseTo(expectedCost, 10);
    // The close response carries the same detail shape as GET /v1/runs/:id.
    expect(closed.by_model[0]!.model).toBe(NATIVE_MODEL);
    expect(closed.retries.pct).toBe(0);
    expect(closed.band).toBeTruthy();
  }, 40_000);

  it('GET /v1/runs enriches each row with agent_count, savings and retry_pct', async () => {
    const res = await request(proxy.port, '/v1/runs?days=1&limit=100');
    expect(res.status, res.text).toBe(200);
    const body = res.json() as { runs: RunListRow[]; next_cursor: string | null };
    const row = body.runs.find((r) => r.run_id === 'ep-run');
    expect(row, `ep-run missing from ${body.runs.map((r) => r.run_id).join(',')}`).toBeTruthy();
    expect(row!.agent_count).toBe(1);
    expect(row!.savings_usd).toBeCloseTo(Math.max(0, row!.baseline_usd - row!.cost_usd), 12);
    expect(row!.savings_usd).toBeGreaterThan(0);
    expect(row!.retry_pct).toBe(0);
    expect(row!.band_status).toBe('none');
    expect(body.next_cursor).toBeNull();
  }, 20_000);

  it('filters by status, label and source', async () => {
    const byLabel = (await request(proxy.port, '/v1/runs?label=ep-lab&days=1')).json() as { runs: RunListRow[] };
    expect(byLabel.runs.map((r) => r.run_id)).toEqual(['ep-run']);

    const byStatus = (await request(proxy.port, '/v1/runs?status=failed&days=1')).json() as { runs: RunListRow[] };
    expect(byStatus.runs.every((r) => r.status === 'failed')).toBe(true);
    expect(byStatus.runs.some((r) => r.run_id === 'ep-run')).toBe(true);

    const bySource = (await request(proxy.port, '/v1/runs?source=inferred_cc&days=1')).json() as { runs: RunListRow[] };
    expect(bySource.runs).toEqual([]);
  }, 20_000);

  it('walks five runs with limit=2 and never repeats one', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(proxy.port, '/v1/runs', { body: { run_id: `page-${i}`, label: 'page-lab' } });
      expect(res.status, res.text).toBe(200);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const path: string = `/v1/runs?label=page-lab&days=1&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = (await request(proxy.port, path)).json() as { runs: RunListRow[]; next_cursor: string | null };
      seen.push(...body.runs.map((r) => r.run_id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(['page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
  }, 30_000);

  it('GET /v1/runs/active reports burn rate, the idle projection and the wave flag', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('ep-active keeps burning while we look at it.'),
      headers: { 'X-RelayPlane-Run': 'ep-active' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'ep-active', 1);

    const active = (await request(proxy.port, '/v1/runs/active')).json() as {
      runs: Array<{
        run_id: string;
        cost_usd: number;
        cost_per_minute: number;
        projected_cost_at_idle_close: number;
        rate_limit_wave: boolean;
        band_status: string;
        agent_count: number;
      }>;
    };
    const row = active.runs.find((r) => r.run_id === 'ep-active');
    expect(row, `ep-active missing from ${active.runs.map((r) => r.run_id).join(',')}`).toBeTruthy();
    expect(row!.cost_per_minute).toBeCloseTo(row!.cost_usd / 5, 12);
    // Default idleCloseSeconds is 600, so the projection adds ten minutes of burn.
    expect(row!.projected_cost_at_idle_close).toBeCloseTo(row!.cost_usd + row!.cost_per_minute * 10, 10);
    expect(row!.rate_limit_wave).toBe(false);
    expect(row!.band_status).toBe('none');
    expect(row!.agent_count).toBeGreaterThanOrEqual(1);
    // The closed run must not show up as active.
    expect(active.runs.some((r) => r.run_id === 'ep-run')).toBe(false);
  }, 30_000);

  it('GET /v1/runs/:id/requests paginates and omits content by default', async () => {
    const first = await request(proxy.port, '/v1/runs/ep-run/requests?limit=1');
    expect(first.status, first.text).toBe(200);
    const page1 = first.json() as {
      requests: Array<{ trace_id: string; model: string; content?: unknown }>;
      next_cursor: string | null;
    };
    expect(page1.requests).toHaveLength(1);
    expect(page1.requests[0]!.model).toBe(NATIVE_MODEL);
    expect(page1.requests[0]!.content).toBeUndefined();
    expect(page1.next_cursor).toBeTruthy();

    const page2 = (await request(
      proxy.port,
      `/v1/runs/ep-run/requests?limit=1&cursor=${encodeURIComponent(page1.next_cursor!)}`,
    )).json() as { requests: Array<{ trace_id: string }>; next_cursor: string | null };
    expect(page2.requests).toHaveLength(1);
    expect(page2.requests[0]!.trace_id).not.toBe(page1.requests[0]!.trace_id);
  }, 20_000);

  it('GET /v1/runs/bands answers with a null suggestion before there is history', async () => {
    const res = await request(proxy.port, '/v1/runs/bands?label=ep-lab');
    expect(res.status, res.text).toBe(200);
    const body = res.json() as {
      label: string;
      configured: unknown;
      suggested: unknown;
      n: { cold: number; warm: number };
    };
    expect(body.label).toBe('ep-lab');
    expect(body.configured).toBeNull();
    expect(body.suggested).toBeNull();
    expect(body.n.cold).toBeLessThan(5);
  }, 20_000);

  it('GET /v1/runs/alerts accepts relative, epoch and ISO since values', async () => {
    for (const since of ['1h', '30m', '2d', String(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000).toISOString()]) {
      const res = await request(proxy.port, `/v1/runs/alerts?since=${encodeURIComponent(since)}&limit=10`);
      expect(res.status, `${since}: ${res.text}`).toBe(200);
      const body = res.json() as { alerts: Array<{ kind: string; run_id: string; ts: number }> };
      expect(Array.isArray(body.alerts)).toBe(true);
    }
    const future = await request(proxy.port, `/v1/runs/alerts?since=${Date.now() + 600_000}`);
    expect((future.json() as { alerts: unknown[] }).alerts).toEqual([]);
  }, 20_000);

  it('404s an unknown run on every :id route', async () => {
    for (const path of ['/v1/runs/nope-nope', '/v1/runs/nope-nope/requests']) {
      const res = await request(proxy.port, path);
      expect(res.status, path).toBe(404);
      expect((res.json() as { error: string }).error).toBe('run_not_found');
    }
    const ended = await request(proxy.port, '/v1/runs/nope-nope/end', { body: {} });
    expect(ended.status).toBe(404);
  }, 20_000);

  it('POST /v1/runs/export honours the run_ids selector', async () => {
    const res = await request(proxy.port, '/v1/runs/export', { body: { run_ids: ['ep-run'], format: 'csv' } });
    expect(res.status, res.text).toBe(200);
    expect(res.text.split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','));
    const rows = res.text.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.startsWith('ep-run,'))).toBe(true);
  }, 20_000);
});

describe('/v1/runs/:id/requests with dashboard.showRequestContent', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome({ ...passthroughAnthropicConfig, dashboard: { showRequestContent: true } }));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('joins the recorded prompt content onto each request row', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('content-run wants its prompt echoed back in the ledger.'),
      headers: { 'X-RelayPlane-Run': 'content-run' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'content-run', 1);

    const body = (await request(proxy.port, '/v1/runs/content-run/requests')).json() as {
      requests: Array<{ trace_id: string; content?: { userMessage?: string; responsePreview?: string } }>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.content).toBeTruthy();
    expect(body.requests[0]!.content!.userMessage).toContain('content-run wants its prompt echoed');
  }, 30_000);
});

describe('/v1/runs localhost guard', () => {
  const externalIp = externalIpv4();
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy | undefined;
  let home: string;

  beforeAll(async () => {
    if (!externalIp) return;
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url, args: ['--host', '0.0.0.0'] });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it.skipIf(!externalIp)('403s a caller whose socket address is not loopback', async () => {
    expect(proxy).toBeTruthy();
    // Same proxy, loopback first: the routes answer normally.
    const loopback = await requestFrom('127.0.0.1', proxy!.port, '/v1/runs?days=1');
    expect(loopback.status).toBe(200);

    const external = await requestFrom(externalIp!, proxy!.port, '/v1/runs?days=1');
    expect(external.status).toBe(403);
    expect(JSON.parse(external.text) as { error: string }).toEqual({ error: 'Run endpoints are localhost-only' });
  }, 30_000);
});
