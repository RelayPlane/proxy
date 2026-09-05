/**
 * PR2 drift tracking (plan 4.8). Two exact signals, no heuristics:
 *  1. inside a run, the proxy served a different model than the caller asked for
 *  2. across runs of one label, an agent's dominant model changed
 * Both are the "a step quietly moved models" question that today needs a human
 * to diff two log files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  passthroughAnthropicConfig,
  waitForRun,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import {
  configureRunAttribution,
  dominantModels,
  endRun,
  _resetRunAttributionForTests,
} from '../src/run-attribution.js';
import { getRunStore, _forceMemoryForTests, type RunRequestRow } from '../src/run-store.js';

const REQUESTED = 'claude-sonnet-4-6';
const SERVED = 'claude-haiku-4-5';

const DRIFT_CONFIG = {
  ...passthroughAnthropicConfig,
  // The deterministic in-proxy model move: no classifier, no budget state.
  modelOverrides: { [REQUESTED]: SERVED },
};

interface RunDetail {
  run: { drift_count: number };
  drift: Array<{ agent_label: string; requested_model: string; model: string; count: number }>;
  by_model: Array<{ model: string; request_count: number }>;
}

describe('within-run drift: served model differs from requested', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(DRIFT_CONFIG));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('counts the move and surfaces it on the run detail', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('drift-run asked for sonnet and got something else.'),
      headers: { 'X-RelayPlane-Run': 'drift-run', 'X-RelayPlane-Agent': 'coder' },
    });
    expect(res.status, res.text).toBe(200);
    // The upstream saw the overridden model, which is what makes this drift.
    expect(upstream.calls.at(-1)!.body['model']).toBe(SERVED);
    await waitForRun(home, 'drift-run', 1);

    const detail = (await request(proxy.port, '/v1/runs/drift-run')).json() as RunDetail;
    expect(detail.run.drift_count).toBe(1);
    expect(detail.drift).toHaveLength(1);
    expect(detail.drift[0]).toEqual({
      agent_label: 'coder',
      requested_model: REQUESTED,
      model: SERVED,
      count: 1,
    });
    expect(detail.by_model.map((m) => m.model)).toEqual([SERVED]);
  }, 30_000);

  it('does not count a request the proxy served as asked', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: { ...messagesBody('no-drift run asks for haiku directly.'), model: SERVED },
      headers: { 'X-RelayPlane-Run': 'no-drift-run' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'no-drift-run', 1);

    const detail = (await request(proxy.port, '/v1/runs/no-drift-run')).json() as RunDetail;
    expect(detail.run.drift_count).toBe(0);
    expect(detail.drift).toEqual([]);
  }, 30_000);
});

describe('cross-run drift: an agent changed its dominant model', () => {
  const now = Date.now();

  const seedRun = (runId: string, model: string, agentLabel = 'coder'): void => {
    const store = getRunStore();
    store.openRun({ run_id: runId, label: 'drift-lab', run_source: 'header' });
    const row: RunRequestRow = {
      trace_id: `${runId}-trace`,
      run_id: runId,
      agent_label: agentLabel,
      thread_id: 'main',
      history_id: null,
      ts: now,
      model,
      requested_model: model,
      provider: 'anthropic',
      attempt: 1,
      is_retry: 0,
      retry_reason: null,
      cache_state: 'cold',
      tokens_in: 100,
      tokens_out: 10,
      cache_read: 0,
      cache_creation: 0,
      cost_usd: 0.5,
      cost_estimated: 0,
      latency_ms: 10,
      success: 1,
      status_code: 200,
      complexity: null,
      task_type: null,
    };
    store.upsertRequest(row, { agent_source: 'header', agent_fingerprint: null });
    endRun(runId, { exitCode: 0 });
  };

  beforeEach(() => {
    _resetRunAttributionForTests();
    _forceMemoryForTests(true);
  });

  it('picks the highest request_count model per agent', () => {
    configureRunAttribution({});
    expect(
      dominantModels([
        {
          run_id: 'r', agent_label: 'coder', thread_id: 'main', agent_source: 'header', agent_fingerprint: null,
          first_seen_at: now, last_seen_at: now, request_count: 15, error_count: 0, retry_count: 0, retry_cost_usd: 0,
          tokens_in: 0, tokens_out: 0, cost_usd: 0, models_seen: { [REQUESTED]: 12, [SERVED]: 3 },
          last_msg_hash: null, repeat_count: 0, last_status_code: null,
        },
      ]),
    ).toEqual({ coder: REQUESTED });
    expect(dominantModels([])).toEqual({});
  });

  it('fires run.model_drift with from and to when the dominant model changes', () => {
    configureRunAttribution({ alerts: { modelDrift: true } });
    const store = getRunStore();

    seedRun('drift-a', REQUESTED);
    expect(store.getLabelStats('drift-lab', 'cold', 30)?.dominant_models).toEqual({ coder: REQUESTED });
    expect(store.listAlerts({ run_id: 'drift-a' }).filter((a) => a.kind === 'run.model_drift')).toHaveLength(0);

    seedRun('drift-b', SERVED);
    const fired = store.listAlerts({ run_id: 'drift-b' }).filter((a) => a.kind === 'run.model_drift');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.severity).toBe('info');
    expect(fired[0]!.data).toMatchObject({
      label: 'drift-lab',
      agent_label: 'coder',
      from: REQUESTED,
      to: SERVED,
    });
    // The stats row now carries the new dominant model for the next comparison.
    expect(store.getLabelStats('drift-lab', 'cold', 30)?.dominant_models).toEqual({ coder: SERVED });
  });

  it('stays quiet when the dominant model did not move', () => {
    configureRunAttribution({ alerts: { modelDrift: true } });
    const store = getRunStore();
    seedRun('same-a', REQUESTED);
    seedRun('same-b', REQUESTED);
    expect(store.listAlerts({ run_id: 'same-b' }).filter((a) => a.kind === 'run.model_drift')).toHaveLength(0);
  });

  it('stays quiet when alerts.modelDrift is false', () => {
    configureRunAttribution({ alerts: { modelDrift: false } });
    const store = getRunStore();
    seedRun('off-a', REQUESTED);
    seedRun('off-b', SERVED);
    expect(store.listAlerts({ run_id: 'off-b' }).filter((a) => a.kind === 'run.model_drift')).toHaveLength(0);
    // The stats row still tracks the change, only the alert is suppressed.
    expect(store.getLabelStats('drift-lab', 'cold', 30)?.dominant_models).toEqual({ coder: SERVED });
  });
});
