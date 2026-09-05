/**
 * PR2 429-wave detection (plan 4.7). A burst of upstream rate limits inside one
 * run is the earliest signal that a workflow is about to burn wall-clock and
 * retry money for nothing, so it fires once per run per five minutes, not once
 * per 429.
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
  waitForRun,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

const WAVE_CONFIG = {
  ...passthroughAnthropicConfig,
  // Cooldowns would short-circuit request four with a local 503 and the run
  // would never see five upstream 429s.
  reliability: { cooldowns: { enabled: false } },
  attribution: { rateLimitWave: { enabled: true, count: 5, windowSeconds: 10 } },
};

interface AlertRow {
  kind: string;
  run_id: string;
  severity: string;
  data: Record<string, unknown>;
}

describe('429 wave inside one run', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  const waveAlerts = async (): Promise<AlertRow[]> => {
    const res = await request(proxy.port, '/v1/runs/alerts?since=1h&limit=200');
    expect(res.status, res.text).toBe(200);
    return (res.json() as { alerts: AlertRow[] }).alerts.filter(
      (a) => a.run_id === 'wave-run' && a.kind === 'run.rate_limit_wave',
    );
  };

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    upstream.failStatus = 429;
    ({ home } = makeHome(WAVE_CONFIG));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('counts five upstream 429s and fires exactly one wave alert', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(proxy.port, '/v1/messages', {
        body: messagesBody(`wave request number ${i} that the upstream refuses.`),
        headers: { 'X-RelayPlane-Run': 'wave-run', 'X-RelayPlane-Agent': 'coder' },
      });
      expect(res.status, res.text).toBe(429);
    }
    const dump = await waitForRun(home, 'wave-run', 5);
    const run = dump.runs.find((r) => r.run_id === 'wave-run');
    expect(run, `no wave-run row (runs: ${dump.runs.map((r) => r.run_id).join(',')})`).toBeTruthy();
    expect(run!.request_count).toBe(5);
    expect(run!.rate_limit_count).toBe(5);
    expect(run!.error_count).toBe(5);
    expect(run!.cost_usd).toBe(0);
    expect(dump.requests.filter((r) => r.run_id === 'wave-run').every((r) => r.status_code === 429)).toBe(true);

    const fired = await waveAlerts();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.severity).toBe('warning');
    expect(fired[0]!.data['count']).toBe(5);
    expect(fired[0]!.data['window']).toBe(10);
    expect(fired[0]!.data['agents_affected']).toEqual(['coder']);
    expect(fired[0]!.data['cost_so_far']).toBe(0);
  }, 40_000);

  it('GET /v1/runs/active flags the run as riding a wave', async () => {
    const active = (await request(proxy.port, '/v1/runs/active')).json() as {
      runs: Array<{ run_id: string; rate_limit_wave: boolean }>;
    };
    const row = active.runs.find((r) => r.run_id === 'wave-run');
    expect(row, `wave-run missing from ${active.runs.map((r) => r.run_id).join(',')}`).toBeTruthy();
    expect(row!.rate_limit_wave).toBe(true);
  }, 20_000);

  it('does not re-alert on a sixth failure inside the five minute cooldown', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('wave request number 6, still refused, still inside the cooldown.'),
      headers: { 'X-RelayPlane-Run': 'wave-run', 'X-RelayPlane-Agent': 'coder' },
    });
    expect(res.status, res.text).toBe(429);
    await waitForRun(home, 'wave-run', 6);

    const dump = readRunsDb(home);
    expect(dump.runs.find((r) => r.run_id === 'wave-run')!.rate_limit_count).toBe(6);
    expect(await waveAlerts()).toHaveLength(1);
  }, 30_000);

  it('leaves a run with no rate limits unflagged', async () => {
    upstream.failStatus = null;
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('calm run, nothing refused here at all.'),
      headers: { 'X-RelayPlane-Run': 'calm-run' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'calm-run', 1);

    const active = (await request(proxy.port, '/v1/runs/active')).json() as {
      runs: Array<{ run_id: string; rate_limit_wave: boolean }>;
    };
    expect(active.runs.find((r) => r.run_id === 'calm-run')?.rate_limit_wave).toBe(false);
  }, 30_000);
});
