/**
 * Concurrent admission against every cap, end to end through the BUILT proxy.
 *
 * Regression for per-run-budget-benchmark (github.com/domondi1/per-run-budget-benchmark,
 * published 2026-09-30): with a per-run cap worth exactly 10 calls, 1.9.69 let
 * 30 of 30 concurrent calls reach the provider (burst30). Sequential calls were
 * capped correctly. Cause: admission checked recorded spend, forwarded, and
 * only recorded the cost when the response came back, so every request in a
 * burst passed the same check. These tests replay the benchmark's workload
 * against a mock upstream: 1000 prompt + 500 completion tokens of gpt-4o-mini
 * per call ($0.00045), a $0.0045 budget, and an upstream delay that keeps the
 * whole burst in flight at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import {
  spawnProxy,
  startMockUpstream,
  startMockAnthropicUpstream,
  makeHome,
  request,
  passthroughAnthropicConfig,
  type MockUpstream,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import { estimateCost } from '../src/telemetry.js';

const CAP = '0.0045';
const DELAY_MS = 600;
const BENCH_USAGE = { prompt_tokens: 1000, completion_tokens: 500 };
const SMALL_USAGE = { prompt_tokens: 15, completion_tokens: 2 };

/** No rate limiting and no response cache: the only thing that may refuse a call is a budget. */
function benchConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config_version: 4,
    telemetry_enabled: false,
    cache: { enabled: false },
    rateLimit: {
      models: { 'gpt-4o-mini': { rpm: 10000 }, 'claude-sonnet-4-6': { rpm: 10000 } },
      maxQueueDepth: 1000,
    },
    ...extra,
  };
}

let seq = 0;
/** The benchmark's request: 3000-char prompt + unique suffix, max_tokens 500. */
function benchBody(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: [{ role: 'user', content: `${'x '.repeat(1500)} ${tag} #${process.pid}-${++seq}` }],
    ...extra,
  };
}

function runHeaders(runId: string): Record<string, string> {
  return {
    Authorization: 'Bearer bench',
    'X-RelayPlane-Bypass': 'true',
    'X-RelayPlane-Run': runId,
    'X-RelayPlane-Run-Cap-Usd': CAP,
  };
}

async function fireBurst(
  port: number,
  n: number,
  make: () => { body: Record<string, unknown>; headers?: Record<string, string> },
  path = '/v1/chat/completions',
): Promise<number[]> {
  const results = await Promise.all(
    Array.from({ length: n }, () => {
      const { body, headers } = make();
      return request(port, path, { body, headers }).then((r) => r.status, () => -1);
    }),
  );
  return results;
}

function count(codes: number[], code: number): number {
  return codes.filter((c) => c === code).length;
}

/** Sends a request and destroys the client socket after `afterMs`, like a client that gave up. */
function fireAndAbandon(port: number, body: Record<string, unknown>, headers: Record<string, string>, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.write(payload);
    req.end();
    setTimeout(() => req.destroy(), afterMs);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-run cap under concurrency (benchmark burst30 / wave2 / seq15)', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    upstream.usage = BENCH_USAGE;
    upstream.delays.set('x x x', DELAY_MS);
    const { home } = makeHome(benchConfig());
    proxy = await spawnProxy({
      home,
      env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('burst30: 30 simultaneous calls on a 10-call cap admit at most 10, then wave2 admits 0', async () => {
    const before = upstream.calls.length;
    const codes = await fireBurst(proxy.port, 30, () => ({ body: benchBody('burst'), headers: runHeaders('bench-burst') }));
    const reached = upstream.calls.length - before;
    expect(reached).toBeLessThanOrEqual(10);
    expect(reached).toBe(10);
    expect(count(codes, 200)).toBe(reached);
    expect(count(codes, 429)).toBe(30 - reached);

    const beforeWave = upstream.calls.length;
    const wave = await fireBurst(proxy.port, 5, () => ({ body: benchBody('wave'), headers: runHeaders('bench-burst') }));
    expect(upstream.calls.length - beforeWave).toBe(0);
    expect(count(wave, 429)).toBe(5);
  }, 30_000);

  it('the 429 says run_budget_exceeded and the cap', async () => {
    const res = await request(proxy.port, '/v1/chat/completions', { body: benchBody('probe'), headers: runHeaders('bench-burst') });
    expect(res.status).toBe(429);
    expect(res.headers['x-relayplane-run-cap-exceeded']).toBe('true');
    expect((res.json() as { type: string; cap: number }).type).toBe('run_budget_exceeded');
  });

  it('seq15: sequential calls still stop at exactly 10', async () => {
    const before = upstream.calls.length;
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await request(proxy.port, '/v1/chat/completions', { body: benchBody('seq'), headers: runHeaders('bench-seq') });
      codes.push(r.status);
    }
    expect(upstream.calls.length - before).toBe(10);
    expect(count(codes, 200)).toBe(10);
  }, 60_000);

  it('stream_burst30: streams with no usage requested by the client admit at most 10, wave admits 0', async () => {
    const before = upstream.calls.length;
    const codes = await fireBurst(proxy.port, 30, () => ({ body: benchBody('sburst', { stream: true }), headers: runHeaders('bench-sburst') }));
    expect(upstream.calls.length - before).toBe(10);
    expect(count(codes, 200)).toBe(10);

    const beforeWave = upstream.calls.length;
    await fireBurst(proxy.port, 5, () => ({ body: benchBody('swave', { stream: true }), headers: runHeaders('bench-sburst') }));
    expect(upstream.calls.length - beforeWave).toBe(0);
  }, 30_000);

  it('a 40-call burst on a fresh run still admits at most 10', async () => {
    const before = upstream.calls.length;
    await fireBurst(proxy.port, 40, () => ({ body: benchBody('b40'), headers: runHeaders('bench-40') }));
    expect(upstream.calls.length - before).toBeLessThanOrEqual(10);
  }, 30_000);
});

describe('reservations are released on failure and on client disconnect', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    upstream.delays.set('x x x', DELAY_MS);
    // Provider cooldowns off: after a burst of 500s the cooldown (not the budget) would 503 the follow-up.
    const { home } = makeHome(benchConfig({ reliability: { cooldowns: { enabled: false } } }));
    proxy = await spawnProxy({
      home,
      env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('upstream failures release their holds: a full-cap burst that fails leaves the cap open', async () => {
    upstream.failStatus = 500;
    upstream.usage = null;
    try {
      const failed = await fireBurst(proxy.port, 10, () => ({ body: benchBody('fail'), headers: runHeaders('rel-fail') }));
      expect(count(failed, 429)).toBe(0); // all 10 fit; none was refused by the budget
    } finally {
      upstream.failStatus = null;
    }
    upstream.usage = SMALL_USAGE;
    const before = upstream.calls.length;
    const ok = await fireBurst(proxy.port, 10, () => ({ body: benchBody('after-fail'), headers: runHeaders('rel-fail') }));
    expect(count(ok, 200), JSON.stringify(ok)).toBe(10);
    expect(upstream.calls.length - before).toBe(10);
  }, 30_000);

  it('client disconnect: the hold covers the upstream call still in flight, then is released', async () => {
    upstream.usage = SMALL_USAGE;
    const before = upstream.calls.length;
    const abandoned = Array.from({ length: 10 }, () => fireAndAbandon(proxy.port, benchBody('abandon'), runHeaders('rel-abandon'), 150));
    await Promise.all(abandoned);
    expect(upstream.calls.length - before).toBe(10);

    // Upstream is still generating for those 10: their spend is still reserved.
    const during = await request(proxy.port, '/v1/chat/completions', { body: benchBody('during'), headers: runHeaders('rel-abandon') });
    expect(during.status).toBe(429);

    // After the upstream calls finish, the holds are released and only the
    // small actual spend remains, so the run admits a full burst again.
    await sleep(DELAY_MS + 600);
    const after = await fireBurst(proxy.port, 10, () => ({ body: benchBody('after-abandon'), headers: runHeaders('rel-abandon') }));
    expect(count(after, 200)).toBe(10);
  }, 30_000);
});

describe('daily budget caps under concurrency share the same admission', () => {
  let upstream: MockUpstream;
  beforeAll(async () => {
    upstream = await startMockUpstream();
    upstream.usage = BENCH_USAGE;
    upstream.delays.set('x x x', DELAY_MS);
  });
  afterAll(async () => { await upstream?.close(); });

  it('budget.dailyUsd (onBreach block): 30 at once admit at most 10', async () => {
    const { home } = makeHome(benchConfig({ budget: { enabled: true, dailyUsd: Number(CAP), hourlyUsd: 1000, onBreach: 'block' } }));
    const proxy = await spawnProxy({ home, env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url } });
    try {
      const before = upstream.calls.length;
      const codes = await fireBurst(proxy.port, 30, () => ({ body: benchBody('daily'), headers: { 'X-RelayPlane-Bypass': 'true' } }));
      expect(upstream.calls.length - before).toBe(10);
      expect(count(codes, 429)).toBe(20);
    } finally {
      await proxy.stop();
    }
  }, 30_000);

  it('budget.dailyCapUSD (relayplane cap set): 30 at once admit at most 10', async () => {
    const { home } = makeHome(benchConfig({ budget: { enabled: false, dailyCapUSD: Number(CAP) } }));
    const proxy = await spawnProxy({ home, env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url } });
    try {
      const before = upstream.calls.length;
      await fireBurst(proxy.port, 30, () => ({ body: benchBody('dailycap'), headers: { 'X-RelayPlane-Bypass': 'true' } }));
      expect(upstream.calls.length - before).toBe(10);
    } finally {
      await proxy.stop();
    }
  }, 30_000);
});

describe('native /v1/messages path: per-run cap under concurrency', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    upstream.delays.set('y y y', DELAY_MS);
    const { home } = makeHome(benchConfig(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('30 simultaneous /v1/messages calls on a ~10-call run cap admit at most 10', async () => {
    const text = `${'y '.repeat(2000)}`;
    // Cap = 10.5 admission estimates (prompt chars/4 at input price + max_tokens at output price).
    const estimate = estimateCost('claude-sonnet-4-6', Math.ceil(text.length / 4), 64);
    const cap = (estimate * 10.5).toFixed(8);
    const before = upstream.calls.length;
    const codes = await fireBurst(
      proxy.port,
      30,
      () => ({
        body: { model: 'claude-sonnet-4-6', max_tokens: 64, messages: [{ role: 'user', content: `${text} #${++seq}` }] },
        headers: { 'X-RelayPlane-Run': 'native-burst', 'X-RelayPlane-Run-Cap-Usd': cap },
      }),
      '/v1/messages',
    );
    const reached = upstream.calls.length - before;
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(10);
    expect(count(codes, 429)).toBe(30 - reached);
  }, 30_000);
});
