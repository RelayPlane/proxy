/**
 * Tests for the /v1/estimate per-IP rate limiter.
 *
 * Covers Fix A (memory-leak purge) and Fix B/C (extracted, testable rate limit logic).
 *
 * Tests:
 * 1. 60 requests from same IP all succeed
 * 2. 61st request returns { allowed: false }
 * 3. Window reset — requests succeed again after the window expires
 * 4. Different IPs have independent buckets
 * 5. purgeExpiredRateLimitEntries removes expired entries, keeps active ones
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkEstimateRateLimit,
  purgeExpiredRateLimitEntries,
  type EstimateRateLimitEntry,
} from '../src/estimate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMap(): Map<string, EstimateRateLimitEntry> {
  return new Map<string, EstimateRateLimitEntry>();
}

const WINDOW_MS = 60_000; // 1 minute (same default as the function)
const MAX_REQUESTS = 60;  // same default

// ---------------------------------------------------------------------------
// 1. 60 requests from same IP all succeed
// ---------------------------------------------------------------------------

describe('checkEstimateRateLimit — within limit', () => {
  it('allows exactly 60 requests from the same IP within one window', () => {
    const rateMap = makeMap();
    const ip = '127.0.0.1';
    const now = Date.now();

    for (let i = 1; i <= MAX_REQUESTS; i++) {
      const result = checkEstimateRateLimit(rateMap, ip, now, WINDOW_MS, MAX_REQUESTS);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 61st request returns { allowed: false }
// ---------------------------------------------------------------------------

describe('checkEstimateRateLimit — over limit', () => {
  it('blocks the 61st request', () => {
    const rateMap = makeMap();
    const ip = '10.0.0.1';
    const now = Date.now();

    // Burn through all 60 slots
    for (let i = 0; i < MAX_REQUESTS; i++) {
      checkEstimateRateLimit(rateMap, ip, now, WINDOW_MS, MAX_REQUESTS);
    }

    // 61st should be denied
    const result = checkEstimateRateLimit(rateMap, ip, now, WINDOW_MS, MAX_REQUESTS);
    expect(result.allowed).toBe(false);
  });

  it('continues blocking beyond the 61st request in the same window', () => {
    const rateMap = makeMap();
    const ip = '10.0.0.2';
    const now = Date.now();

    for (let i = 0; i < MAX_REQUESTS; i++) {
      checkEstimateRateLimit(rateMap, ip, now, WINDOW_MS, MAX_REQUESTS);
    }

    // All subsequent requests in the same window are blocked
    for (let extra = 0; extra < 5; extra++) {
      const result = checkEstimateRateLimit(rateMap, ip, now, WINDOW_MS, MAX_REQUESTS);
      expect(result.allowed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Window reset — requests succeed again after window expires
// ---------------------------------------------------------------------------

describe('checkEstimateRateLimit — window reset', () => {
  it('resets the counter when the window expires', () => {
    const rateMap = makeMap();
    const ip = '192.168.1.1';
    const t0 = Date.now();

    // Fill up the window
    for (let i = 0; i < MAX_REQUESTS; i++) {
      checkEstimateRateLimit(rateMap, ip, t0, WINDOW_MS, MAX_REQUESTS);
    }

    // Confirm blocked in the same window
    expect(checkEstimateRateLimit(rateMap, ip, t0, WINDOW_MS, MAX_REQUESTS).allowed).toBe(false);

    // Advance time past the window
    const t1 = t0 + WINDOW_MS + 1;
    const result = checkEstimateRateLimit(rateMap, ip, t1, WINDOW_MS, MAX_REQUESTS);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1); // counter reset
  });

  it('allows a full 60 more requests after window reset', () => {
    const rateMap = makeMap();
    const ip = '192.168.1.2';
    const t0 = Date.now();

    // Fill window
    for (let i = 0; i < MAX_REQUESTS; i++) {
      checkEstimateRateLimit(rateMap, ip, t0, WINDOW_MS, MAX_REQUESTS);
    }

    // New window
    const t1 = t0 + WINDOW_MS + 1;
    for (let i = 1; i <= MAX_REQUESTS; i++) {
      const result = checkEstimateRateLimit(rateMap, ip, t1, WINDOW_MS, MAX_REQUESTS);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i);
    }

    // Blocked again after filling the new window
    const overflow = checkEstimateRateLimit(rateMap, ip, t1, WINDOW_MS, MAX_REQUESTS);
    expect(overflow.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Different IPs have independent buckets
// ---------------------------------------------------------------------------

describe('checkEstimateRateLimit — independent IP buckets', () => {
  it('does not share counters between different IPs', () => {
    const rateMap = makeMap();
    const ipA = '1.2.3.4';
    const ipB = '5.6.7.8';
    const now = Date.now();

    // Fill up ipA
    for (let i = 0; i < MAX_REQUESTS; i++) {
      checkEstimateRateLimit(rateMap, ipA, now, WINDOW_MS, MAX_REQUESTS);
    }

    // ipA is blocked
    expect(checkEstimateRateLimit(rateMap, ipA, now, WINDOW_MS, MAX_REQUESTS).allowed).toBe(false);

    // ipB is unaffected and can make requests
    const resultB = checkEstimateRateLimit(rateMap, ipB, now, WINDOW_MS, MAX_REQUESTS);
    expect(resultB.allowed).toBe(true);
    expect(resultB.count).toBe(1);
  });

  it('tracks three IPs independently', () => {
    const rateMap = makeMap();
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const now = Date.now();

    // Make different numbers of requests per IP
    for (let i = 0; i < 10; i++) checkEstimateRateLimit(rateMap, ips[0], now, WINDOW_MS, MAX_REQUESTS);
    for (let i = 0; i < 30; i++) checkEstimateRateLimit(rateMap, ips[1], now, WINDOW_MS, MAX_REQUESTS);
    for (let i = 0; i < 60; i++) checkEstimateRateLimit(rateMap, ips[2], now, WINDOW_MS, MAX_REQUESTS);

    expect(rateMap.get(ips[0])?.count).toBe(10);
    expect(rateMap.get(ips[1])?.count).toBe(30);
    expect(rateMap.get(ips[2])?.count).toBe(60);

    // Only ips[2] is blocked
    expect(checkEstimateRateLimit(rateMap, ips[0], now, WINDOW_MS, MAX_REQUESTS).allowed).toBe(true);
    expect(checkEstimateRateLimit(rateMap, ips[1], now, WINDOW_MS, MAX_REQUESTS).allowed).toBe(true);
    expect(checkEstimateRateLimit(rateMap, ips[2], now, WINDOW_MS, MAX_REQUESTS).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Purge removes expired entries, keeps active ones
// ---------------------------------------------------------------------------

describe('purgeExpiredRateLimitEntries', () => {
  it('removes entries whose window has expired', () => {
    const rateMap = makeMap();
    const now = Date.now();

    // Add an entry that started more than WINDOW_MS ago (expired)
    rateMap.set('expired-ip', { windowStart: now - WINDOW_MS - 1, count: 5 });
    expect(rateMap.has('expired-ip')).toBe(true);

    purgeExpiredRateLimitEntries(rateMap, now, WINDOW_MS);

    expect(rateMap.has('expired-ip')).toBe(false);
  });

  it('keeps entries whose window is still active', () => {
    const rateMap = makeMap();
    const now = Date.now();

    // Active entry (window started just now)
    rateMap.set('active-ip', { windowStart: now - 1000, count: 10 });

    purgeExpiredRateLimitEntries(rateMap, now, WINDOW_MS);

    expect(rateMap.has('active-ip')).toBe(true);
    expect(rateMap.get('active-ip')?.count).toBe(10);
  });

  it('purges expired entries and keeps active ones in the same map', () => {
    const rateMap = makeMap();
    const now = Date.now();

    // Two expired IPs
    rateMap.set('old-1', { windowStart: now - WINDOW_MS - 100, count: 3 });
    rateMap.set('old-2', { windowStart: now - WINDOW_MS - 500, count: 60 });
    // Two active IPs
    rateMap.set('new-1', { windowStart: now - 5000, count: 15 });
    rateMap.set('new-2', { windowStart: now - 30_000, count: 59 });

    purgeExpiredRateLimitEntries(rateMap, now, WINDOW_MS);

    // Expired entries removed
    expect(rateMap.has('old-1')).toBe(false);
    expect(rateMap.has('old-2')).toBe(false);
    // Active entries kept
    expect(rateMap.has('new-1')).toBe(true);
    expect(rateMap.has('new-2')).toBe(true);
    // Map size reduced from 4 to 2
    expect(rateMap.size).toBe(2);
  });

  it('handles an empty map without errors', () => {
    const rateMap = makeMap();
    expect(() => purgeExpiredRateLimitEntries(rateMap, Date.now(), WINDOW_MS)).not.toThrow();
    expect(rateMap.size).toBe(0);
  });

  it('handles a map where all entries are active (nothing purged)', () => {
    const rateMap = makeMap();
    const now = Date.now();

    rateMap.set('ip-a', { windowStart: now - 1000, count: 1 });
    rateMap.set('ip-b', { windowStart: now - 2000, count: 2 });

    purgeExpiredRateLimitEntries(rateMap, now, WINDOW_MS);

    expect(rateMap.size).toBe(2);
  });

  it('handles a map where all entries are expired (all purged)', () => {
    const rateMap = makeMap();
    const now = Date.now();

    rateMap.set('ip-a', { windowStart: now - WINDOW_MS - 1, count: 60 });
    rateMap.set('ip-b', { windowStart: now - WINDOW_MS * 2, count: 30 });

    purgeExpiredRateLimitEntries(rateMap, now, WINDOW_MS);

    expect(rateMap.size).toBe(0);
  });
});
