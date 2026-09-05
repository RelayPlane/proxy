/**
 * PR1, run attribution: a per-run spend cap has to stop the run, not just
 * report on it after the money is gone. The daily budget cap is too coarse
 * for a fan-out; one runaway agent burns the whole day's budget while every
 * other run is still cheap.
 *
 * Contract: X-RelayPlane-Run-Cap-Usd arms a cap on the run. Once the run's
 * spend plus the projected cost of the next request would cross it, the proxy
 * answers 429 run_budget_exceeded with the run id, flags the response, and
 * records the block in the kill audit so `relayplane kills` shows why the
 * agent stopped. In warn mode the request goes through with a warning header
 * instead, so a team can measure a cap before enforcing it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  passthroughAnthropicConfig,
  readRunsDb,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

/** ~40 chars, so the projected cost of request 1 stays under the cap. */
const SHORT_PROMPT = 'cap-1 first request, cheap and short.';
/** Long enough that the projected input cost alone blows through the cap. */
const LONG_PROMPT = `cap-1 second request. ${'expensive padding token stream. '.repeat(80)}`;

describe('per-run cap in block mode', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('the first request under the cap goes through and arms the cap on the run', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody(SHORT_PROMPT),
      headers: { 'X-RelayPlane-Run': 'cap-1', 'X-RelayPlane-Run-Cap-Usd': '0.0001' },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.headers['x-relayplane-run-id']).toBe('cap-1');
    expect(upstream.calls).toHaveLength(1);

    const run = readRunsDb(home).runs.find((r) => r.run_id === 'cap-1');
    expect(run, 'no run row for cap-1').toBeTruthy();
    expect(run!.cap_usd).toBeCloseTo(0.0001, 10);
  }, 30_000);

  it('the second request over the cap is blocked with 429 run_budget_exceeded and never reaches the upstream', async () => {
    const before = upstream.calls.length;
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody(LONG_PROMPT),
      headers: { 'X-RelayPlane-Run': 'cap-1' },
    });

    expect(res.status, res.text).toBe(429);
    const body = res.json() as { type?: string; run_id?: string; cap_usd?: number; spent_usd?: number };
    expect(body.type).toBe('run_budget_exceeded');
    expect(body.run_id).toBe('cap-1');
    expect(res.headers['x-relayplane-run-cap-exceeded']).toBe('true');
    expect(res.headers['x-relayplane-run-id']).toBe('cap-1');
    // Blocked means blocked: no upstream spend.
    expect(upstream.calls.length).toBe(before);

    const run = readRunsDb(home).runs.find((r) => r.run_id === 'cap-1');
    expect(run!.cap_hit_at).toBeTruthy();
  }, 30_000);

  it('the block shows up in the kill audit with the run id', async () => {
    const res = await request(proxy.port, '/control/kills?limit=50');
    expect(res.status).toBe(200);
    const { events } = res.json() as { events: { reason?: string; run_id?: string }[] };
    const capEvents = events.filter((e) => e.reason === 'cap_exceeded');
    expect(capEvents.length).toBeGreaterThan(0);
    expect(capEvents.some((e) => e.run_id === 'cap-1')).toBe(true);
  }, 30_000);
});

describe('per-run cap in warn mode', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome({ ...passthroughAnthropicConfig, attribution: { runCapAction: 'warn' } }));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('warns instead of blocking: 200 with a warning header, and the request still reaches the upstream', async () => {
    const first = await request(proxy.port, '/v1/messages', {
      body: messagesBody(SHORT_PROMPT.replace('cap-1', 'cap-2')),
      headers: { 'X-RelayPlane-Run': 'cap-2', 'X-RelayPlane-Run-Cap-Usd': '0.0001' },
    });
    expect(first.status, first.text).toBe(200);

    const second = await request(proxy.port, '/v1/messages', {
      body: messagesBody(LONG_PROMPT.replace('cap-1', 'cap-2')),
      headers: { 'X-RelayPlane-Run': 'cap-2' },
    });
    expect(second.status, second.text).toBe(200);
    expect(second.headers['x-relayplane-run-cap-warning']).toBe('true');
    expect(second.headers['x-relayplane-run-cap-exceeded']).toBeUndefined();
    expect(upstream.calls).toHaveLength(2);
  }, 30_000);
});
