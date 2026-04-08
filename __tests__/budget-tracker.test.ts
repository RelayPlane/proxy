import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BudgetTracker,
  MODEL_PRICING,
  estimateCostFromTokens,
  getBudgetTracker,
  resetBudgetTracker,
  getDailyWindow,
} from '../src/budget.js';

// ─── MODEL_PRICING ───────────────────────────────────────────────────

describe('MODEL_PRICING constants', () => {
  it('contains Opus pricing', () => {
    expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-6']!.inputPer1M).toBe(5.00);
    expect(MODEL_PRICING['claude-opus-4-6']!.outputPer1M).toBe(25.00);
  });

  it('contains Sonnet pricing', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-6']!.inputPer1M).toBe(3.00);
    expect(MODEL_PRICING['claude-sonnet-4-6']!.outputPer1M).toBe(15.00);
  });

  it('contains Haiku pricing', () => {
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']!.inputPer1M).toBe(0.80);
    expect(MODEL_PRICING['claude-haiku-4-5']!.outputPer1M).toBe(4.00);
  });

  it('Opus 4.6 is cheaper than old claude-3-opus', () => {
    expect(MODEL_PRICING['claude-opus-4-6']!.inputPer1M).toBeLessThan(
      MODEL_PRICING['claude-3-opus-20240229']!.inputPer1M,
    );
  });
});

// ─── estimateCostFromTokens ──────────────────────────────────────────

describe('estimateCostFromTokens', () => {
  it('computes cost for Sonnet 4.6', () => {
    // 1M input + 1M output at $3/$15
    const cost = estimateCostFromTokens('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.00, 4);
  });

  it('computes cost for Haiku', () => {
    // 100k input + 50k output at $0.80/$4.00
    const cost = estimateCostFromTokens('claude-haiku-4-5', 100_000, 50_000);
    expect(cost).toBeCloseTo(0.08 + 0.20, 5); // 0.28
  });

  it('returns 0 for unknown model', () => {
    expect(estimateCostFromTokens('gpt-4o', 1_000_000, 1_000_000)).toBe(0);
  });

  it('handles zero tokens', () => {
    expect(estimateCostFromTokens('claude-opus-4-6', 0, 0)).toBe(0);
  });
});

// ─── BudgetTracker (memory-only, no SQLite) ──────────────────────────

describe('BudgetTracker — unlimited (no cap)', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker(); // no dailyCapUSD → unlimited
  });

  afterEach(() => {
    tracker.close();
  });

  it('always allows when unlimited', () => {
    const result = tracker.check();
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(false);
    expect(result.cap).toBeNull();
  });

  it('record() is a no-op when unlimited', () => {
    tracker.record(100, 'claude-opus-4-6');
    expect(tracker.getDailySpend()).toBe(0);
  });

  it('getHistory() returns empty when unlimited', () => {
    expect(tracker.getHistory(7)).toEqual([]);
  });

  it('getCap() returns null', () => {
    expect(tracker.getCap()).toBeNull();
  });
});

describe('BudgetTracker — with dailyCapUSD', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    // Don't init() — skip SQLite, use memory-only
    tracker = new BudgetTracker({ dailyCapUSD: 10.00, warningThreshold: 0.8 });
  });

  afterEach(() => {
    tracker.close();
  });

  it('allows when under cap', () => {
    const result = tracker.check();
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(false);
    expect(result.cap).toBe(10.00);
    expect(result.spent).toBe(0);
  });

  it('warns when approaching cap (>=80%)', () => {
    tracker.record(8.5, 'claude-opus-4-6'); // 85%
    const result = tracker.check();
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(true);
  });

  it('does not warn below threshold', () => {
    tracker.record(7.0, 'claude-sonnet-4-6'); // 70%
    const result = tracker.check();
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(false);
  });

  it('blocks when cap exceeded', () => {
    tracker.record(10.01, 'claude-opus-4-6');
    const result = tracker.check();
    expect(result.allowed).toBe(false);
    expect(result.warn).toBe(false);
  });

  it('blocks at exact cap', () => {
    tracker.record(10.0, 'claude-opus-4-6');
    const result = tracker.check();
    expect(result.allowed).toBe(false);
  });

  it('accumulates spend correctly', () => {
    tracker.record(3.0, 'claude-opus-4-6');
    tracker.record(4.0, 'claude-sonnet-4-6');
    expect(tracker.getDailySpend()).toBe(7.0);
  });

  it('includes today in getHistory (memory-only fallback)', () => {
    tracker.record(2.5, 'claude-sonnet-4-6');
    const history = tracker.getHistory(7);
    expect(history).toHaveLength(1);
    expect(history[0]!.totalSpend).toBe(2.5);
    expect(history[0]!.date).toBe(getDailyWindow());
  });
});

describe('BudgetTracker — updateConfig', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker({ dailyCapUSD: 10.00 });
  });

  afterEach(() => {
    tracker.close();
  });

  it('switches from capped to unlimited', () => {
    tracker.updateConfig({ dailyCapUSD: undefined });
    const result = tracker.check();
    expect(result.cap).toBeNull();
    expect(result.allowed).toBe(true);
  });

  it('updates warningThreshold', () => {
    tracker.updateConfig({ warningThreshold: 0.5 });
    tracker.record(6.0, 'claude-haiku-4-5'); // 60% of $10
    const result = tracker.check();
    expect(result.warn).toBe(true); // >50% threshold
  });

  it('updating cap to a lower value can cause block', () => {
    tracker.record(5.0, 'claude-sonnet-4-6'); // $5 of $10 cap
    tracker.updateConfig({ dailyCapUSD: 3.00 }); // reduce cap to $3
    const result = tracker.check();
    expect(result.allowed).toBe(false); // $5 > $3
  });
});

// ─── Singleton ───────────────────────────────────────────────────────

describe('getBudgetTracker / resetBudgetTracker', () => {
  afterEach(() => {
    resetBudgetTracker();
  });

  it('returns same instance on repeated calls', () => {
    const a = getBudgetTracker({ dailyCapUSD: 5 });
    const b = getBudgetTracker({ dailyCapUSD: 99 }); // config ignored after first call
    expect(a).toBe(b);
  });

  it('resetBudgetTracker creates fresh instance', () => {
    const a = getBudgetTracker({ dailyCapUSD: 5 });
    resetBudgetTracker();
    const b = getBudgetTracker({ dailyCapUSD: 20 });
    expect(a).not.toBe(b);
    expect(b.getCap()).toBe(20);
    b.close();
  });
});

// ─── Performance ─────────────────────────────────────────────────────

describe('BudgetTracker performance', () => {
  it('check() completes in <5ms', () => {
    const tracker = new BudgetTracker({ dailyCapUSD: 100 });
    // warm-up
    tracker.check();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      tracker.check();
    }
    const elapsed = performance.now() - start;
    expect(elapsed / 1000).toBeLessThan(5);
    tracker.close();
  });
});
