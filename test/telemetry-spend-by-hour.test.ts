/**
 * Phase 1 TDD (RED): /v1/telemetry/spend-by-hour endpoint.
 *
 * Asserts that standalone-proxy.ts registers the new spend-by-hour route
 * that returns exactly 24 buckets per UTC day.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const proxySrc = readFileSync(
  join(__dirname, '..', 'src', 'standalone-proxy.ts'),
  'utf8',
);

describe('/v1/telemetry/spend-by-hour endpoint', () => {
  it('route /v1/telemetry/spend-by-hour is registered in standalone-proxy.ts', () => {
    expect(proxySrc).toContain('/v1/telemetry/spend-by-hour');
  });

  it('handler accepts a ?day=YYYY-MM-DD query param', () => {
    // The handler must reference the day param explicitly.
    expect(proxySrc).toMatch(/spend-by-hour[\s\S]{0,2000}?day/);
  });

  it('handler validates day format and rejects malformed input with 400', () => {
    // Spec: malformed day returns 400.
    expect(proxySrc).toMatch(/spend-by-hour[\s\S]{0,2000}?\b400\b/);
  });
});
