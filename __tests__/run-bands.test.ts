/**
 * PR2 expected-cost bands (plan 4.5). A band is the cheapest possible form of
 * "this run cost what it always costs": two numbers per label per cache state.
 * Over fires once and only once while the run is still going; under fires on
 * close, because a workflow that came in cheap usually skipped a step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import {
  bandForRun,
  suggestedBands,
  configureRunAttribution,
  endRun,
  _resetRunAttributionForTests,
} from '../src/run-attribution.js';
import { getRunStore, _forceMemoryForTests, type RunRequestRow } from '../src/run-store.js';

const NATIVE_MODEL = 'claude-sonnet-4-6';
const BAND_CONFIG = {
  ...passthroughAnthropicConfig,
  attribution: {
    bands: {
      'band-lab': { cold: [0.0001, 0.0002] },
      'band-under': { cold: [0.01, 0.02] },
    },
  },
};

interface AlertRow {
  kind: string;
  run_id: string;
  severity: string;
  data: Record<string, unknown>;
}

interface RunDetail {
  run: { cost_usd: number; band_status: string };
  band: { lo: number | null; hi: number | null; status: string; cache_state: string | null };
}

async function alertsFor(port: number, runId: string, kind: string): Promise<AlertRow[]> {
  const res = await request(port, '/v1/runs/alerts?since=1h&limit=200');
  expect(res.status, res.text).toBe(200);
  const body = res.json() as { alerts: AlertRow[] };
  return body.alerts.filter((a) => a.run_id === runId && a.kind === kind);
}

describe('cost bands over a live proxy', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(BAND_CONFIG));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('crosses hi on the second request, flips to over, and alerts exactly once', async () => {
    const prompts = [
      'band one asks about cache warming here.',
      'band two asks about cache warming again.',
      'band three asks a third short question!',
    ];
    const costs: number[] = [];
    const statuses: string[] = [];
    for (const text of prompts) {
      const res = await request(proxy.port, '/v1/messages', {
        body: messagesBody(text),
        headers: { 'X-RelayPlane-Run': 'band-run', 'X-RelayPlane-Run-Label': 'band-lab' },
      });
      expect(res.status, res.text).toBe(200);
      await waitForRun(home, 'band-run', costs.length + 1);
      const call = upstream.calls.find((c) => allUserText(c.body) === text);
      expect(call, `no upstream call for ${text}`).toBeTruthy();
      const usage = anthropicMockUsage(allUserText(call!.body));
      costs.push(estimateCost(NATIVE_MODEL, usage.input_tokens, usage.output_tokens));
      const detail = (await request(proxy.port, '/v1/runs/band-run')).json() as RunDetail;
      statuses.push(detail.band.status);
      expect(detail.band.lo).toBe(0.0001);
      expect(detail.band.hi).toBe(0.0002);
    }

    // The band boundaries only mean something if the costs really straddle them.
    expect(costs[0]!).toBeGreaterThan(0.0001);
    expect(costs[0]!).toBeLessThanOrEqual(0.0002);
    expect(costs[0]! + costs[1]!).toBeGreaterThan(0.0002);

    expect(statuses).toEqual(['in', 'over', 'over']);

    const fired = await alertsFor(proxy.port, 'band-run', 'run.over_band');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.severity).toBe('warning');
    expect(fired[0]!.data['band_hi']).toBe(0.0002);
    expect(fired[0]!.data['label']).toBe('band-lab');
  }, 40_000);

  it('flips to under on close and says something was skipped', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('band-under does a single cheap step.'),
      headers: { 'X-RelayPlane-Run': 'band-under-run', 'X-RelayPlane-Run-Label': 'band-under' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'band-under-run', 1);

    const before = (await request(proxy.port, '/v1/runs/band-under-run')).json() as RunDetail;
    expect(before.band.status).toBe('none');
    expect(before.run.cost_usd).toBeLessThan(0.01);

    const ended = await request(proxy.port, '/v1/runs/band-under-run/end', { body: { exit_code: 0 } });
    expect(ended.status, ended.text).toBe(200);
    const closed = ended.json() as RunDetail;
    expect(closed.band.status).toBe('under');
    expect(closed.band.lo).toBe(0.01);

    const fired = await alertsFor(proxy.port, 'band-under-run', 'run.under_band');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.severity).toBe('info');
  }, 40_000);

  it('GET /v1/runs/bands returns the configured pair and no suggestion yet', async () => {
    const res = await request(proxy.port, '/v1/runs/bands?label=band-lab');
    expect(res.status, res.text).toBe(200);
    const body = res.json() as {
      label: string;
      configured: { cold?: [number, number] } | null;
      suggested: unknown;
      n: { cold: number; warm: number };
    };
    expect(body.label).toBe('band-lab');
    expect(body.configured?.cold).toEqual([0.0001, 0.0002]);
    expect(body.suggested).toBeNull();
    expect(body.n.cold).toBeLessThan(5);
  }, 20_000);
});

describe('band lookup and suggestion, unit level', () => {
  beforeEach(() => {
    _resetRunAttributionForTests();
    _forceMemoryForTests(true);
  });

  it('falls back to the "*" band for an unlabeled run', () => {
    configureRunAttribution({ bands: { '*': { cold: [1, 2] } } });
    expect(bandForRun({ label: null, cache_state: 'cold' })).toEqual([1, 2]);
    expect(bandForRun({ label: 'anything', cache_state: null })).toEqual([1, 2]);

    configureRunAttribution({ bands: { nightly: { cold: [3, 4] }, '*': { cold: [1, 2] } } });
    expect(bandForRun({ label: 'nightly', cache_state: 'cold' })).toEqual([3, 4]);
    expect(bandForRun({ label: 'other', cache_state: 'cold' })).toEqual([1, 2]);
  });

  it('reads the warm pair for a warm run and no band when the pair is missing', () => {
    configureRunAttribution({ bands: { nightly: { cold: [1, 2], warm: [5, 6] } } });
    expect(bandForRun({ label: 'nightly', cache_state: 'warm' })).toEqual([5, 6]);
    expect(bandForRun({ label: 'nightly', cache_state: 'mixed' })).toEqual([1, 2]);

    configureRunAttribution({ bands: { nightly: { cold: [1, 2] } } });
    expect(bandForRun({ label: 'nightly', cache_state: 'warm' })).toBeNull();
    expect(bandForRun({ label: 'unknown-label', cache_state: 'cold' })).toBeNull();
  });

  it('suggests [p25, p75] only once five runs of the label have closed', () => {
    configureRunAttribution({});
    const store = getRunStore();
    const seed = (id: string, cost: number): void => {
      store.openRun({ run_id: id, label: 'seed-lab', run_source: 'header' });
      const row: RunRequestRow = {
        trace_id: `${id}-trace`,
        run_id: id,
        agent_label: 'coder',
        thread_id: 'main',
        history_id: null,
        ts: Date.now(),
        model: NATIVE_MODEL,
        requested_model: NATIVE_MODEL,
        provider: 'anthropic',
        attempt: 1,
        is_retry: 0,
        retry_reason: null,
        cache_state: 'cold',
        tokens_in: 100,
        tokens_out: 10,
        cache_read: 0,
        cache_creation: 0,
        cost_usd: cost,
        cost_estimated: 0,
        latency_ms: 10,
        success: 1,
        status_code: 200,
        complexity: null,
        task_type: null,
      };
      store.upsertRequest(row, { agent_source: 'header', agent_fingerprint: null });
      endRun(id, { exitCode: 0 });
    };

    for (const [i, cost] of [1, 2, 3, 4].entries()) {
      seed(`seed-${i + 1}`, cost);
      const stats = store.getLabelStats('seed-lab', 'cold', 30);
      expect(stats?.n).toBe(i + 1);
      expect(suggestedBands(stats)).toBeNull();
    }

    seed('seed-5', 5);
    const stats = store.getLabelStats('seed-lab', 'cold', 30);
    expect(stats?.n).toBe(5);
    expect(stats?.p50).toBe(3);
    expect(stats?.p90).toBe(5);
    // Nearest rank over [1,2,3,4,5]: p25 is the 2nd value, p75 the 4th.
    expect(suggestedBands(stats)).toEqual([2, 4]);
    expect(stats?.dominant_models).toEqual({ coder: NATIVE_MODEL });
  });

  it('returns null for a missing stats row', () => {
    expect(suggestedBands(null)).toBeNull();
  });
});
