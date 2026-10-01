/**
 * Reserve-then-reconcile admission (per-run-budget-benchmark burst30,
 * 2026-09-30: 1.9.69 let 30 of 30 concurrent calls through a 10-call run cap).
 *
 * Unit level: every cap type checks recorded spend PLUS live reservations,
 * an admitted request reserves in the same synchronous step, and releases
 * are idempotent and expire so nothing can leak a cap shut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ReservationPool,
  KeyedReservationPool,
  RequestHolds,
  requestedMaxOutputTokens,
  reserveOutputTokens,
  RESERVE_DEFAULT_OUTPUT_TOKENS,
  RESERVE_MAX_OUTPUT_TOKENS,
} from '../src/budget-reservations.js';
import { BudgetManager, BudgetTracker } from '../src/budget.js';
import {
  newRunRequestContext,
  attachRunIdentity,
  checkRunCap,
  recordRunRequest,
  releaseBudgetHolds,
  runReservedUsd,
  configureRunAttribution,
  _resetRunAttributionForTests,
  type RunRequestContext,
} from '../src/run-attribution.js';

const CALL = 0.00045; // the benchmark's true cost per call
const CAP = 0.0045; // exactly 10 calls

describe('ReservationPool', () => {
  it('sums live holds, release is idempotent', () => {
    const pool = new ReservationPool();
    const a = pool.reserve(1);
    const b = pool.reserve(2);
    expect(pool.reserved()).toBe(3);
    a();
    a();
    expect(pool.reserved()).toBe(2);
    b();
    expect(pool.reserved()).toBe(0);
    expect(pool.size()).toBe(0);
  });

  it('ignores non-finite and negative amounts', () => {
    const pool = new ReservationPool();
    pool.reserve(Number.NaN);
    pool.reserve(-5);
    expect(pool.reserved()).toBe(0);
  });

  it('a hold that outlives its TTL expires instead of wedging the cap', () => {
    const pool = new ReservationPool(1000);
    pool.reserve(5, 0);
    expect(pool.reserved(999)).toBe(5);
    expect(pool.reserved(1000)).toBe(0);
    expect(pool.size(1000)).toBe(0);
  });

  it('keyed pools are independent and dropped when empty', () => {
    const keyed = new KeyedReservationPool();
    const r1 = keyed.reserve('run-a', 1);
    keyed.reserve('run-b', 2);
    expect(keyed.reserved('run-a')).toBe(1);
    expect(keyed.reserved('run-b')).toBe(2);
    r1();
    expect(keyed.reserved('run-a')).toBe(0);
    expect(keyed.size('run-a')).toBe(0);
  });

  it('RequestHolds releases everything once', () => {
    const pool = new ReservationPool();
    const holds = new RequestHolds();
    holds.add(pool.reserve(1));
    holds.add(pool.reserve(1));
    expect(pool.reserved()).toBe(2);
    holds.releaseAll();
    holds.releaseAll();
    expect(pool.reserved()).toBe(0);
  });
});

describe('output-token reservation', () => {
  it('reads every dialect of the output limit', () => {
    expect(requestedMaxOutputTokens({ max_tokens: 500 })).toBe(500);
    expect(requestedMaxOutputTokens({ max_completion_tokens: 300 })).toBe(300);
    expect(requestedMaxOutputTokens({ max_output_tokens: 200 })).toBe(200);
    expect(requestedMaxOutputTokens({ generationConfig: { maxOutputTokens: 100 } })).toBe(100);
    expect(requestedMaxOutputTokens({})).toBeUndefined();
    expect(requestedMaxOutputTokens(null)).toBeUndefined();
  });

  it('defaults when unstated and clamps huge limits', () => {
    expect(reserveOutputTokens({})).toBe(RESERVE_DEFAULT_OUTPUT_TOKENS);
    expect(reserveOutputTokens({ max_tokens: 64000 })).toBe(RESERVE_MAX_OUTPUT_TOKENS);
    expect(reserveOutputTokens({ max_tokens: 500 })).toBe(500);
  });
});

/** 30 admissions in one tick, as 30 concurrent requests reach admission before any finishes. */
function burst(admit: () => boolean, n = 30): number {
  let admitted = 0;
  for (let i = 0; i < n; i++) if (admit()) admitted++;
  return admitted;
}

describe('BudgetManager daily/hourly budget under a burst', () => {
  it('admits at most cap/estimate requests while none has recorded spend yet', () => {
    const bm = new BudgetManager({ enabled: true, dailyUsd: CAP, hourlyUsd: 1000, onBreach: 'block' });
    const releases: Array<() => void> = [];
    const admitted = burst(() => {
      const r = bm.checkBudget(undefined, { projectedCost: CALL });
      if (!r.allowed) return false;
      releases.push(bm.reserveSpend(CALL));
      return true;
    });
    expect(admitted).toBe(10);
    expect(bm.getReservedSpend()).toBeCloseTo(CAP, 12);

    // Reconcile: actual spend recorded, reservations released -> still capped.
    for (const release of releases) { bm.recordSpend(CALL, 'gpt-4o-mini'); release(); }
    expect(bm.getReservedSpend()).toBe(0);
    expect(bm.checkBudget(undefined, { projectedCost: CALL }).allowed).toBe(false);
  });

  it('a failed request releases its reservation and frees the headroom', () => {
    const bm = new BudgetManager({ enabled: true, dailyUsd: CAP, hourlyUsd: 1000, onBreach: 'block' });
    const releases: Array<() => void> = [];
    burst(() => {
      if (!bm.checkBudget(undefined, { projectedCost: CALL }).allowed) return false;
      releases.push(bm.reserveSpend(CALL));
      return true;
    });
    expect(bm.checkBudget(undefined, { projectedCost: CALL }).allowed).toBe(false);
    for (const release of releases) release(); // all failed upstream, nothing recorded
    expect(bm.checkBudget(undefined, { projectedCost: CALL }).allowed).toBe(true);
  });

  it('hourly limit counts reservations too', () => {
    const bm = new BudgetManager({ enabled: true, dailyUsd: 1000, hourlyUsd: CAP, onBreach: 'block' });
    const admitted = burst(() => {
      const r = bm.checkBudget(undefined, { projectedCost: CALL });
      if (!r.allowed) return false;
      bm.reserveSpend(CALL);
      return true;
    });
    expect(admitted).toBe(10);
  });

  it('disabled budget reserves nothing', () => {
    const bm = new BudgetManager({ enabled: false });
    bm.reserveSpend(5);
    expect(bm.getReservedSpend()).toBe(0);
  });
});

describe('BudgetManager per-session cap under a burst', () => {
  it('admits at most cap/estimate requests per session, other sessions unaffected', () => {
    const bm = new BudgetManager({ enabled: true, sessionCapUsd: CAP });
    const admitted = burst(() => {
      const r = bm.checkSessionBudget('s-1', 'claude-sonnet-4-6', CALL);
      if (!r.allowed) return false;
      bm.reserveSession('s-1', CALL);
      return true;
    });
    expect(admitted).toBe(10);
    expect(bm.checkSessionBudget('s-2', 'claude-sonnet-4-6', CALL).allowed).toBe(true);
  });

  it('without a projection it still blocks once spend reaches the cap (old contract)', () => {
    const bm = new BudgetManager({ enabled: true, sessionCapUsd: 1 });
    bm.updateSessionBudget('s-3', 1, 'm');
    expect(bm.checkSessionBudget('s-3', 'm').allowed).toBe(false);
  });
});

describe('BudgetTracker daily cap under a burst', () => {
  let home = '';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['RELAYPLANE_HOME_OVERRIDE'];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-reserve-tracker-'));
    process.env['RELAYPLANE_HOME_OVERRIDE'] = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['RELAYPLANE_HOME_OVERRIDE'];
    else process.env['RELAYPLANE_HOME_OVERRIDE'] = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('admits at most cap/estimate requests', () => {
    const t = new BudgetTracker({ dailyCapUSD: CAP });
    t.init();
    const admitted = burst(() => {
      if (!t.check(CALL).allowed) return false;
      t.reserve(CALL);
      return true;
    });
    expect(admitted).toBe(10);
    t.close();
  });
});

describe('checkRunCap reserves atomically', () => {
  let home = '';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['RELAYPLANE_HOME_OVERRIDE'];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-reserve-run-'));
    process.env['RELAYPLANE_HOME_OVERRIDE'] = home;
    _resetRunAttributionForTests();
    configureRunAttribution(undefined);
  });
  afterEach(() => {
    _resetRunAttributionForTests();
    if (saved === undefined) delete process.env['RELAYPLANE_HOME_OVERRIDE'];
    else process.env['RELAYPLANE_HOME_OVERRIDE'] = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function ctx(runId: string, i: number): RunRequestContext {
    const rc = newRunRequestContext({ headers: { 'x-relayplane-run': runId, 'x-relayplane-run-cap-usd': String(CAP) } });
    attachRunIdentity(rc, {
      sessionId: 'sess',
      sessionSource: 'header',
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: `call ${i}` }] },
      requestedModel: 'gpt-4o-mini',
    });
    return rc;
  }

  it('30 concurrent admissions on a 10-call cap admit exactly 10', () => {
    const contexts = Array.from({ length: 30 }, (_, i) => ctx('burst-run', i));
    const verdicts = contexts.map((rc) => checkRunCap(rc, CALL));
    expect(verdicts.filter((v) => !v.blocked)).toHaveLength(10);
    expect(runReservedUsd('burst-run')).toBeCloseTo(CAP, 12);
  });

  it('reconcile: recorded actual cost replaces the reservation, the cap still holds', () => {
    const contexts = Array.from({ length: 10 }, (_, i) => ctx('rec-run', i));
    for (const rc of contexts) expect(checkRunCap(rc, CALL).blocked).toBe(false);
    contexts.forEach((rc, i) => {
      rc.traceId = `t-${i}`;
      recordRunRequest({
        id: `h-${i}`, originalModel: 'gpt-4o-mini', targetModel: 'gpt-4o-mini', provider: 'openai',
        latencyMs: 1, success: true, timestamp: new Date().toISOString(),
        tokensIn: 1000, tokensOut: 500, costUsd: CALL,
      }, rc);
      releaseBudgetHolds(rc);
    });
    expect(runReservedUsd('rec-run')).toBe(0);
    expect(checkRunCap(ctx('rec-run', 99), CALL).blocked).toBe(true);
  });

  it('a released (failed) request frees its slot', () => {
    const contexts = Array.from({ length: 10 }, (_, i) => ctx('fail-run', i));
    for (const rc of contexts) checkRunCap(rc, CALL);
    expect(checkRunCap(ctx('fail-run', 50), CALL).blocked).toBe(true);
    releaseBudgetHolds(contexts[0]);
    expect(checkRunCap(ctx('fail-run', 51), CALL).blocked).toBe(false);
  });

  it('warn mode admits and still reserves', () => {
    configureRunAttribution({ runCapAction: 'warn' });
    const contexts = Array.from({ length: 12 }, (_, i) => ctx('warn-run', i));
    const verdicts = contexts.map((rc) => checkRunCap(rc, CALL));
    expect(verdicts.every((v) => !v.blocked)).toBe(true);
    expect(verdicts.filter((v) => v.warn)).toHaveLength(2);
    expect(runReservedUsd('warn-run')).toBeCloseTo(12 * CALL, 12);
  });
});
