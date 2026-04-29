/**
 * Background Activity Detector Tests
 *
 * Tests for classifyActivity() which uses heuristics to split
 * foreground vs suspected background AI agent spend.
 *
 * Heuristics:
 *   H1: inter-request gap < 2s with input_tokens > 2000 → background
 *   H2: post-midnight window (00:00–05:00) + density > 5 req / 10 min → background
 *   H3: no stop_reason variation across ≥ 5 consecutive calls → loop / background
 */

import { describe, it, expect } from 'vitest';
import {
  classifyActivity,
  type ActivityRequest,
  type BgFgResult,
} from '../src/background-detector';

// ─── helpers ─────────────────────────────────────────────────────────────────

const MS = 1;
const SEC = 1000 * MS;
const MIN = 60 * SEC;

/** Build a timestamp for a given hour:minute today (UTC). */
function todayAt(hour: number, minute = 0, second = 0): number {
  const d = new Date();
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/** Build a timestamp for a given hour:minute in the post-midnight window. */
function midnightAt(hour: number, minute = 0, second = 0): number {
  // Use a fixed past date so tests are deterministic.
  // 2026-04-01T02:30:00Z falls squarely in the 00:00–05:00 window.
  const d = new Date('2026-04-01T00:00:00Z');
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

function makeRequest(
  overrides: Partial<ActivityRequest> & { timestamp: number }
): ActivityRequest {
  return {
    request_id: crypto.randomUUID(),
    input_tokens: 500,
    output_tokens: 200,
    stop_reason: 'end_turn',
    cost_usd: 0.001,
    ...overrides,
  };
}

// ─── case 1: clear foreground ─────────────────────────────────────────────────

describe('classifyActivity – clear foreground', () => {
  it('classifies requests spaced > 30 s apart as foreground', () => {
    const base = todayAt(14, 0); // 2 PM UTC – normal working hours
    const requests: ActivityRequest[] = [
      makeRequest({ timestamp: base, input_tokens: 800 }),
      makeRequest({ timestamp: base + 45 * SEC, input_tokens: 600 }),
      makeRequest({ timestamp: base + 2 * MIN, input_tokens: 900 }),
    ];

    const result: BgFgResult = classifyActivity(requests);

    expect(result.foreground_requests).toBe(3);
    expect(result.background_requests).toBe(0);
    expect(result.background_spend_pct).toBe(0);
    expect(result.background_request_pct).toBe(0);
    expect(result.signals).toEqual(expect.arrayContaining([]));
  });

  it('returns a well-formed BgFgResult with all required fields', () => {
    const requests: ActivityRequest[] = [
      makeRequest({ timestamp: todayAt(10), input_tokens: 300 }),
    ];

    const result = classifyActivity(requests);

    expect(typeof result.foreground_requests).toBe('number');
    expect(typeof result.background_requests).toBe('number');
    expect(typeof result.background_spend_pct).toBe('number');
    expect(typeof result.background_request_pct).toBe('number');
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.background_spend_pct).toBeGreaterThanOrEqual(0);
    expect(result.background_spend_pct).toBeLessThanOrEqual(100);
  });
});

// ─── case 2: clear background – post-midnight burst ──────────────────────────

describe('classifyActivity – post-midnight burst (H2)', () => {
  it('flags burst of > 5 requests within 10 min at 02:00 UTC as background', () => {
    const base = midnightAt(2, 0); // 02:00 UTC
    const requests: ActivityRequest[] = Array.from({ length: 8 }, (_, i) =>
      makeRequest({
        timestamp: base + i * 60 * SEC, // one per minute, 8 in 8 min
        input_tokens: 1200,
        stop_reason: 'end_turn',
      })
    );

    const result = classifyActivity(requests);

    expect(result.background_requests).toBeGreaterThan(0);
    expect(result.background_request_pct).toBeGreaterThan(50);
    expect(result.signals).toContain('post_midnight_burst');
  });

  it('does NOT flag sparse post-midnight requests (≤ 5 in 10 min) as background', () => {
    const base = midnightAt(3, 0); // 03:00 UTC
    // Only 3 requests in 10 minutes – below density threshold
    const requests: ActivityRequest[] = [
      makeRequest({ timestamp: base, input_tokens: 800 }),
      makeRequest({ timestamp: base + 3 * MIN, input_tokens: 700 }),
      makeRequest({ timestamp: base + 8 * MIN, input_tokens: 900 }),
    ];

    const result = classifyActivity(requests);

    expect(result.background_requests).toBe(0);
  });
});

// ─── case 3: inter-request burst heuristic (H1) ───────────────────────────────

describe('classifyActivity – rapid inter-request bursts (H1)', () => {
  it('flags sub-2s gaps with > 2000 input_tokens as background', () => {
    const base = todayAt(10, 0); // daytime – no post-midnight bonus
    const requests: ActivityRequest[] = [
      makeRequest({ timestamp: base, input_tokens: 3000 }),
      makeRequest({ timestamp: base + 800 * MS, input_tokens: 2500 }), // 0.8 s gap
      makeRequest({ timestamp: base + 1600 * MS, input_tokens: 2800 }), // 0.8 s gap
    ];

    const result = classifyActivity(requests);

    expect(result.background_requests).toBeGreaterThan(0);
    expect(result.signals).toContain('rapid_burst');
  });

  it('does NOT flag sub-2s gaps with low token counts (≤ 2000) as background', () => {
    const base = todayAt(10, 0);
    const requests: ActivityRequest[] = [
      makeRequest({ timestamp: base, input_tokens: 400 }),
      makeRequest({ timestamp: base + 900 * MS, input_tokens: 300 }), // fast but cheap
    ];

    const result = classifyActivity(requests);

    expect(result.background_requests).toBe(0);
  });
});

// ─── case 4: ambiguous / mixed session ───────────────────────────────────────

describe('classifyActivity – ambiguous / mixed session', () => {
  it('splits correctly when foreground and background requests are interleaved', () => {
    const base = todayAt(11, 0); // daytime, normal
    const bgBase = midnightAt(2, 30); // post-midnight burst

    const foregroundReqs: ActivityRequest[] = [
      makeRequest({ timestamp: base, input_tokens: 800, cost_usd: 0.002 }),
      makeRequest({ timestamp: base + 2 * MIN, input_tokens: 600, cost_usd: 0.001 }),
      makeRequest({ timestamp: base + 5 * MIN, input_tokens: 900, cost_usd: 0.002 }),
    ];

    // 6 rapid post-midnight requests → triggers H2
    const backgroundReqs: ActivityRequest[] = Array.from({ length: 6 }, (_, i) =>
      makeRequest({
        timestamp: bgBase + i * 60 * SEC,
        input_tokens: 2500,
        cost_usd: 0.008,
        stop_reason: 'max_tokens', // no end_turn variation
      })
    );

    const result = classifyActivity([...foregroundReqs, ...backgroundReqs]);

    // Should detect some background
    expect(result.background_requests).toBeGreaterThan(0);
    expect(result.foreground_requests).toBeGreaterThan(0);
    // Both sets are present → neither should be 0 %
    expect(result.background_request_pct).toBeGreaterThan(0);
    expect(result.background_request_pct).toBeLessThan(100);
    expect(result.background_spend_pct).toBeGreaterThan(0);
  });

  it('handles empty request array without throwing', () => {
    expect(() => classifyActivity([])).not.toThrow();
    const result = classifyActivity([]);
    expect(result.background_requests).toBe(0);
    expect(result.foreground_requests).toBe(0);
    expect(result.background_spend_pct).toBe(0);
  });

  it('classifies consecutive calls with no stop_reason variation as a loop (H3)', () => {
    const base = todayAt(14, 0);
    // 6 consecutive calls, all stop_reason='max_tokens', spaced 3 s apart
    const requests: ActivityRequest[] = Array.from({ length: 6 }, (_, i) =>
      makeRequest({
        timestamp: base + i * 3 * SEC,
        input_tokens: 2100, // > 2000
        stop_reason: 'max_tokens',
        cost_usd: 0.005,
      })
    );

    const result = classifyActivity(requests);

    expect(result.background_requests).toBeGreaterThan(0);
    expect(result.signals).toContain('stop_reason_loop');
  });
});
