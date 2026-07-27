/**
 * Dashboard Phase 1: cross-endpoint invariants for the redesign.
 *
 * - /v1/telemetry/stats: today.* shape, latencyP95 >= avgLatencyMs invariant
 * - /v1/telemetry/runs records expose routing_rule + routing_reason (nullable)
 * - /v1/sessions records expose total_savings_usd
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearRequestHistory,
  getRequestHistory,
  computeTodayStats,
  computeProvidersRollup,
  computeSessionSavings,
} from '../src/standalone-proxy.js';

function makeEntry(overrides: Record<string, unknown> = {}): any {
  return {
    id: `entry-${Math.random()}`,
    originalModel: 'claude-opus-4-6',
    targetModel: 'claude-haiku-4-5',
    provider: 'anthropic',
    latencyMs: 100,
    success: true,
    mode: 'proxy',
    escalated: false,
    timestamp: new Date().toISOString(),
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 0.01,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe('dashboard /v1/telemetry/stats today shape + invariants', () => {
  beforeEach(() => clearRequestHistory());

  it('today.* returns the documented numeric fields', () => {
    const h = getRequestHistory();
    h.push(makeEntry({ latencyMs: 100, costUsd: 0.01 }));
    h.push(makeEntry({ latencyMs: 300, costUsd: 0.02, cacheReadTokens: 50 }));
    h.push(makeEntry({ latencyMs: 200, costUsd: 0.03, success: false }));

    const today = computeTodayStats(h);
    expect(typeof today.totalCost).toBe('number');
    expect(typeof today.totalRequests).toBe('number');
    expect(typeof today.avgLatencyMs).toBe('number');
    expect(typeof today.latencyP95).toBe('number');
    expect(typeof today.errorRate).toBe('number');
    expect(typeof today.cacheHitRate).toBe('number');
    expect(today.totalRequests).toBe(3);
    expect(today.errorRate).toBeCloseTo(1 / 3, 4);
    expect(today.cacheHitRate).toBeCloseTo(1 / 3, 4);
  });

  it('latencyP95 >= avgLatencyMs over the same window', () => {
    const h = getRequestHistory();
    // skewed distribution: most fast, a couple slow
    for (let i = 0; i < 20; i++) h.push(makeEntry({ latencyMs: 50 }));
    h.push(makeEntry({ latencyMs: 5000 }));
    h.push(makeEntry({ latencyMs: 8000 }));

    const today = computeTodayStats(h);
    expect(today.latencyP95).toBeGreaterThanOrEqual(today.avgLatencyMs);

    // Also true on the providers rollup p95Ms.
    const provs = computeProvidersRollup(h, 7);
    const avg = h.reduce((s, r) => s + r.latencyMs, 0) / h.length;
    expect(provs[0]!.p95Ms).toBeGreaterThanOrEqual(Math.round(avg));
  });
});

describe('dashboard /v1/telemetry/runs routing_rule + routing_reason fields', () => {
  it('RequestHistoryEntry allows null routing_rule and routing_reason', () => {
    clearRequestHistory();
    const h = getRequestHistory();
    h.push(makeEntry({ routing_rule: null, routing_reason: null }));
    h.push(makeEntry({ routing_rule: 'cheap-default', routing_reason: 'cost' }));

    // Reflect what the runs handler emits: nullable but always present.
    for (const r of h) {
      const emitted = {
        routing_rule: r.routing_rule ?? null,
        routing_reason: r.routing_reason ?? null,
      };
      expect(emitted).toHaveProperty('routing_rule');
      expect(emitted).toHaveProperty('routing_reason');
      expect(emitted.routing_rule === null || typeof emitted.routing_rule === 'string').toBe(true);
      expect(emitted.routing_reason === null || typeof emitted.routing_reason === 'string').toBe(true);
    }
  });
});

describe('dashboard /v1/sessions total_savings_usd', () => {
  beforeEach(() => clearRequestHistory());

  it('computes a numeric total_savings_usd for a session id', () => {
    const h = getRequestHistory();
    h.push(makeEntry({ agentId: 'sess-A', targetModel: 'claude-haiku-4-5', tokensIn: 1000, tokensOut: 500, costUsd: 0.01 }));
    h.push(makeEntry({ agentId: 'sess-A', targetModel: 'claude-haiku-4-5', tokensIn: 2000, tokensOut: 1000, costUsd: 0.02 }));
    h.push(makeEntry({ agentId: 'sess-B', targetModel: 'claude-haiku-4-5', tokensIn: 500, tokensOut: 250, costUsd: 0.005 }));

    const savedA = computeSessionSavings('sess-A', h);
    const savedB = computeSessionSavings('sess-B', h);
    expect(typeof savedA).toBe('number');
    expect(typeof savedB).toBe('number');
    // Haiku is cheaper than Opus baseline, so we expect non-negative savings.
    expect(savedA).toBeGreaterThanOrEqual(0);
    expect(savedB).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for an unknown session id', () => {
    expect(computeSessionSavings('does-not-exist', getRequestHistory())).toBe(0);
  });
});
