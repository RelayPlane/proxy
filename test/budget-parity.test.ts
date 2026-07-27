/**
 * Budget parity: useLiveToday MUST derive budget cap from /control/budget,
 * not from any hardcoded literal. fixtures.ts.RP_TODAY.budget is 0; the
 * hero card's budget value should come from a live fetch of /control/budget.
 *
 * Also asserts the days->cap mapping:
 *   days=1  -> limit_usd
 *   days=7  -> this_week_usd  (fallback: limit_usd * 7)
 *   days=30 -> this_month_usd (fallback: limit_usd * 30)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error - JS module without types
import { budgetCapFor, fetchToday } from '../dashboard/src/useLiveToday.js';
// @ts-expect-error - JS module without types
import { RP_TODAY } from '../dashboard/src/fixtures.ts';

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function mockRoutes(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    for (const key of Object.keys(routes)) {
      if (url.startsWith(key)) return jsonResponse(routes[key]);
    }
    return jsonResponse({}, false);
  });
}

describe('useLiveToday budget parity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fixtures.RP_TODAY.budget is 0 (no hardcoded literal)', () => {
    expect(RP_TODAY.budget).toBe(0);
  });

  it('budgetCapFor: days=1 returns limit_usd', () => {
    expect(budgetCapFor({ limit_usd: 42 }, 1)).toBe(42);
  });

  it('budgetCapFor: days=7 prefers this_week_usd, falls back to limit_usd*7', () => {
    expect(budgetCapFor({ limit_usd: 42, this_week_usd: 300 }, 7)).toBe(300);
    expect(budgetCapFor({ limit_usd: 42 }, 7)).toBe(294);
  });

  it('budgetCapFor: days=30 prefers this_month_usd, falls back to limit_usd*30', () => {
    expect(budgetCapFor({ limit_usd: 42, this_month_usd: 1000 }, 30)).toBe(1000);
    expect(budgetCapFor({ limit_usd: 42 }, 30)).toBe(1260);
  });

  it('budgetCapFor: missing budget returns 0', () => {
    expect(budgetCapFor(null, 1)).toBe(0);
    expect(budgetCapFor(undefined, 7)).toBe(0);
  });

  it('fetchToday days=1 wires budget from /control/budget.limit_usd', async () => {
    const fetchMock = mockRoutes({
      '/v1/telemetry/stats': { today: { totalCost: 1.23, totalRequests: 5, avgLatencyMs: 800, latencyP95: 1500, errorRate: 0, cacheHitRate: 0.1 } },
      '/v1/telemetry/savings': { savedAmount: 0.5, percentage: 30 },
      '/control/budget': { limit_usd: 42, today_usd: 1.23, hourly_usd: 0.05, this_week_usd: 0, this_month_usd: 0 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const today = await fetchToday(1);
    expect(today.budget).toBe(42);
    expect(today.burn).toBe(0.05);
    expect(today.cost).toBe(1.23);
    expect(today.requests).toBe(5);
    expect(today.latencyAvg).toBeCloseTo(0.8);
    expect(today.latencyP95).toBeCloseTo(1.5);
  });

  it('fetchToday days=7 derives cap from this_week_usd when present', async () => {
    const fetchMock = mockRoutes({
      '/v1/telemetry/stats': { today: { totalCost: 0, totalRequests: 0, avgLatencyMs: 0 } },
      '/v1/telemetry/savings': { savedAmount: 0, percentage: 0 },
      '/control/budget': { limit_usd: 42, this_week_usd: 250, this_month_usd: 1000 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const today = await fetchToday(7);
    expect(today.budget).toBe(250);
  });

  it('fetchToday days=30 derives cap from this_month_usd when present', async () => {
    const fetchMock = mockRoutes({
      '/v1/telemetry/stats': { today: { totalCost: 0, totalRequests: 0, avgLatencyMs: 0 } },
      '/v1/telemetry/savings': { savedAmount: 0, percentage: 0 },
      '/control/budget': { limit_usd: 42, this_week_usd: 250, this_month_usd: 1000 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const today = await fetchToday(30);
    expect(today.budget).toBe(1000);
  });
});
