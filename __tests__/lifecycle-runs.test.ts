/**
 * Run lifecycle telemetry (PR5).
 *
 * Three adoption pings ride the existing anonymous lifecycle channel:
 * `run.first_attributed`, `run.milestone_10` and `run.milestone_100`. They fire
 * once each per install, carry no run id, no label, no agent name and no cost,
 * and they only count runs the user tagged with an explicit X-RelayPlane-Run
 * header (inferred runs happen whether or not anyone opted in).
 *
 * `isLifecycleEnabled()` is false whenever `isCiEnvironment()` is true, and
 * VITEST is one of the CI markers, so every test here blanks the marker set
 * with `vi.stubEnv` and restores it in afterEach. `getConfigDir()` is resolved
 * at module load, so the module is imported dynamically after the temp home is
 * in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CI_ENV_MARKERS } from '../src/config.js';

type LifecycleModule = typeof import('../src/lifecycle-telemetry.js');
type AttributionModule = typeof import('../src/run-attribution.js');
type RunStoreModule = typeof import('../src/run-store.js');

const NOW = 1_800_000_000_000;

let home = '';
let posted: unknown[] = [];

/** Every `task_type` the stubbed fetch has seen, in order. */
function sentEvents(): string[] {
  const out: string[] = [];
  for (const body of posted) {
    if (body === null || typeof body !== 'object') continue;
    const events = (body as Record<string, unknown>)['events'];
    if (!Array.isArray(events)) continue;
    for (const raw of events) {
      if (raw === null || typeof raw !== 'object') continue;
      const taskType = (raw as Record<string, unknown>)['task_type'];
      if (typeof taskType === 'string') out.push(taskType);
    }
  }
  return out;
}

/** The single event payload sent for `taskType`, or null. */
function payloadFor(taskType: string): Record<string, unknown> | null {
  for (const body of posted) {
    if (body === null || typeof body !== 'object') continue;
    const events = (body as Record<string, unknown>)['events'];
    if (!Array.isArray(events)) continue;
    for (const raw of events) {
      if (raw === null || typeof raw !== 'object') continue;
      const event = raw as Record<string, unknown>;
      if (event['task_type'] === taskType) return event;
    }
  }
  return null;
}

/** The lifecycle send is fire-and-forget, so let the microtask queue drain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function lifecycleStateFile(): string {
  return path.join(home, '.relayplane', 'lifecycle.json');
}

function readLifecycleState(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(lifecycleStateFile(), 'utf-8'));
  if (parsed === null || typeof parsed !== 'object') return {};
  return parsed as Record<string, unknown>;
}

async function loadLifecycle(): Promise<LifecycleModule> {
  vi.resetModules();
  return import('../src/lifecycle-telemetry.js');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lifecycle-runs-'));
  fs.mkdirSync(path.join(home, '.relayplane'), { recursive: true });

  // Blank every CI marker: an empty value is explicitly "not CI" (config.ts).
  for (const marker of CI_ENV_MARKERS) vi.stubEnv(marker, '');
  vi.stubEnv('RELAYPLANE_CONFIG_PATH', '');
  vi.stubEnv('RELAYPLANE_HOME_OVERRIDE', home);
  vi.stubEnv('RELAYPLANE_API_URL', 'http://127.0.0.1:9');

  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body;
      posted.push(typeof body === 'string' ? JSON.parse(body) : null);
      return { ok: true, status: 200 };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = '';
});

describe('run.first_attributed', () => {
  it('sends exactly once across two calls', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunFirstAttributed();
    await flush();
    lifecycle.maybeFireRunFirstAttributed();
    await flush();

    expect(sentEvents().filter((e) => e === 'run.first_attributed')).toHaveLength(1);
  });

  it('carries no run id, no label and no cost', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunFirstAttributed();
    await flush();

    const payload = payloadFor('run.first_attributed');
    expect(payload).not.toBeNull();
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'cost_usd',
      'device_id',
      'latency_ms',
      'model',
      'success',
      'task_type',
      'timestamp',
      'tokens_in',
      'tokens_out',
    ]);
    expect(payload?.['model']).toBe('lifecycle');
    expect(payload?.['cost_usd']).toBe(0);
    expect(payload?.['tokens_in']).toBe(0);
    expect(payload?.['tokens_out']).toBe(0);
    expect(JSON.stringify(payload)).not.toMatch(/run_id|label|agent/);
  });

  it('records the flag in the state file', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunFirstAttributed();
    await flush();

    expect(readLifecycleState()['run_first_attributed_sent']).toBe(true);
  });
});

describe('run milestones', () => {
  it('fires run.milestone_10 at 10, not at 9', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunMilestone(9);
    await flush();
    expect(sentEvents()).not.toContain('run.milestone_10');

    lifecycle.maybeFireRunMilestone(10);
    await flush();
    expect(sentEvents().filter((e) => e === 'run.milestone_10')).toHaveLength(1);
  });

  it('never repeats a milestone once it has been sent', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunMilestone(10);
    await flush();
    lifecycle.maybeFireRunMilestone(11);
    await flush();
    lifecycle.maybeFireRunMilestone(42);
    await flush();

    expect(sentEvents().filter((e) => e === 'run.milestone_10')).toHaveLength(1);
  });

  it('fires run.milestone_100 at 100 and reports only the higher milestone on a jump', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunMilestone(100);
    await flush();

    expect(sentEvents()).toEqual(['run.milestone_100']);
    const state = readLifecycleState();
    expect(state['run_milestone_100_sent']).toBe(true);
    expect(state['run_milestone_10_sent']).toBe(false);
  });

  it('ignores a non-finite count', async () => {
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunMilestone(Number.NaN);
    await flush();

    expect(sentEvents()).toEqual([]);
  });
});

describe('state file compatibility', () => {
  it('loads a pre-1.10 state file with no run keys and preserves what was there', async () => {
    fs.writeFileSync(
      lifecycleStateFile(),
      JSON.stringify({ activation_sent: true, last_session_date: '2026-01-01' }),
      'utf-8',
    );
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunFirstAttributed();
    await flush();

    const state = readLifecycleState();
    expect(state['activation_sent']).toBe(true);
    expect(state['last_session_date']).toBe('2026-01-01');
    expect(state['run_first_attributed_sent']).toBe(true);
    expect(state['run_milestone_10_sent']).toBe(false);
    expect(state['run_milestone_100_sent']).toBe(false);
    expect(sentEvents()).toEqual(['run.first_attributed']);
  });

  it('does not re-send when the flag is already true in the state file', async () => {
    fs.writeFileSync(
      lifecycleStateFile(),
      JSON.stringify({ activation_sent: true, last_session_date: null, run_first_attributed_sent: true }),
      'utf-8',
    );
    const lifecycle = await loadLifecycle();

    lifecycle.maybeFireRunFirstAttributed();
    await flush();

    expect(sentEvents()).toEqual([]);
  });
});

describe('wiring: closing a header-tagged run fires the ping', () => {
  async function loadAttribution(): Promise<{ attribution: AttributionModule; store: RunStoreModule }> {
    vi.resetModules();
    const attribution = await import('../src/run-attribution.js');
    const store = await import('../src/run-store.js');
    return { attribution, store };
  }

  it('endRun on a header run with requests fires run.first_attributed', async () => {
    const { attribution } = await loadAttribution();
    attribution._resetRunAttributionForTests();

    const registered = attribution.registerRun({ run_id: 'nightly-20260905-a1b2c3', label: 'nightly' });
    expect('run' in registered).toBe(true);

    const rc = attribution.newRunRequestContext(
      { headers: { 'x-relayplane-run': 'nightly-20260905-a1b2c3' } },
      NOW,
    );
    rc.runId = 'nightly-20260905-a1b2c3';
    rc.runSource = 'header';
    rc.agentLabel = 'coder';
    rc.threadId = 'main';
    rc.traceId = 'trace-1';
    attribution.recordRunRequest(
      {
        id: 'hist-1',
        originalModel: 'claude-sonnet-4-6',
        targetModel: 'claude-sonnet-4-6',
        provider: 'anthropic',
        latencyMs: 120,
        success: true,
        timestamp: new Date(NOW).toISOString(),
        tokensIn: 1000,
        tokensOut: 100,
        costUsd: 0.01,
      },
      rc,
    );

    const before = attribution.endRun('nightly-20260905-a1b2c3', { now: NOW + 1000 });
    expect(before?.request_count).toBeGreaterThan(0);
    await flush();

    expect(sentEvents()).toContain('run.first_attributed');

    attribution._resetRunAttributionForTests();
  });

  it('does not fire for an inferred run', async () => {
    const { attribution, store } = await loadAttribution();
    attribution._resetRunAttributionForTests();

    const runs = store.getRunStore();
    runs.openRun({
      run_id: 'cc-abcdef',
      parent_run_id: null,
      depth: 0,
      label: null,
      run_source: 'inferred_cc',
      tags: {},
      cap_usd: null,
      now: NOW,
    });

    const rc = attribution.newRunRequestContext({ headers: {} }, NOW);
    rc.runId = 'cc-abcdef';
    rc.runSource = 'inferred_cc';
    rc.agentLabel = 'unknown';
    rc.threadId = 'main';
    rc.traceId = 'trace-2';
    attribution.recordRunRequest(
      {
        id: 'hist-2',
        originalModel: 'claude-sonnet-4-6',
        targetModel: 'claude-sonnet-4-6',
        provider: 'anthropic',
        latencyMs: 120,
        success: true,
        timestamp: new Date(NOW).toISOString(),
        tokensIn: 1000,
        tokensOut: 100,
        costUsd: 0.01,
      },
      rc,
    );

    attribution.endRun('cc-abcdef', { now: NOW + 1000 });
    await flush();

    expect(sentEvents()).not.toContain('run.first_attributed');

    attribution._resetRunAttributionForTests();
  });
});
