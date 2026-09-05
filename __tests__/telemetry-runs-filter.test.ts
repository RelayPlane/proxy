/**
 * PR1, run attribution: the dashboard and the CLI both read
 * /v1/telemetry/runs. Once requests carry a run id, that endpoint has to be
 * filterable by run and by session, otherwise a fan-out is an unreadable
 * interleaved list and "what did this agent cost" has no answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  passthroughAnthropicConfig,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

interface TelemetryRun {
  id: string;
  run_id?: string;
  session_id?: string;
  agent_label?: string;
  agentId?: string | null;
  costUsd: number;
}

const SESSION_ONE = 'sess-11111111-1111-4111-8111-111111111111';
const SESSION_TWO = 'sess-22222222-2222-4222-8222-222222222222';

async function runs(port: number, qs: string): Promise<TelemetryRun[]> {
  const res = await request(port, `/v1/telemetry/runs?${qs}`);
  expect(res.status, res.text).toBe(200);
  return (res.json() as { runs: TelemetryRun[] }).runs;
}

describe('/v1/telemetry/runs filters by run_id and session_id', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    const { home } = makeHome(passthroughAnthropicConfig);
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });

    const first = await request(proxy.port, '/v1/messages', {
      body: messagesBody('telemetry filter, first session.'),
      headers: { 'X-Claude-Code-Session-Id': SESSION_ONE, 'X-RelayPlane-Run': 'tel-r1' },
    });
    expect(first.status, first.text).toBe(200);

    const second = await request(proxy.port, '/v1/messages', {
      body: messagesBody('telemetry filter, second session, a different prompt.'),
      headers: { 'X-Claude-Code-Session-Id': SESSION_TWO, 'X-RelayPlane-Run': 'tel-r2' },
    });
    expect(second.status, second.text).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('unfiltered returns both rows, each tagged with its run and session', async () => {
    const all = await runs(proxy.port, 'limit=50');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const byRun = new Map(all.map((r) => [r.run_id, r]));
    expect(byRun.has('tel-r1')).toBe(true);
    expect(byRun.has('tel-r2')).toBe(true);
    expect(byRun.get('tel-r1')!.session_id).toBe(SESSION_ONE);
    expect(byRun.get('tel-r2')!.session_id).toBe(SESSION_TWO);
  }, 20_000);

  it('session_id returns only that session', async () => {
    const filtered = await runs(proxy.port, `session_id=${SESSION_ONE}&limit=50`);
    expect(filtered.length).toBe(1);
    expect(filtered.every((r) => r.session_id === SESSION_ONE)).toBe(true);
    expect(filtered.every((r) => r.run_id === 'tel-r1')).toBe(true);
  }, 20_000);

  it('run_id returns only that run', async () => {
    const filtered = await runs(proxy.port, 'run_id=tel-r2&limit=50');
    expect(filtered.length).toBe(1);
    expect(filtered.every((r) => r.run_id === 'tel-r2')).toBe(true);
    expect(filtered.every((r) => r.session_id === SESSION_TWO)).toBe(true);
  }, 20_000);

  it('an unknown run_id returns an empty list, not everything', async () => {
    const filtered = await runs(proxy.port, 'run_id=tel-nope&limit=50');
    expect(filtered).toHaveLength(0);
  }, 20_000);
});
