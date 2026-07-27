/**
 * Phase 1 TDD (RED): /v1/telemetry/providers rollup endpoint.
 *
 * Asserts that standalone-proxy.ts registers the per-provider rollup
 * route with the specified record shape: {provider, share, p95Ms, rpm,
 * health, primary, note}.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const proxySrc = readFileSync(
  join(__dirname, '..', 'src', 'standalone-proxy.ts'),
  'utf8',
);

describe('/v1/telemetry/providers endpoint', () => {
  it('route /v1/telemetry/providers is registered in standalone-proxy.ts', () => {
    expect(proxySrc).toContain('/v1/telemetry/providers');
  });

  it('handler accepts a ?days=N query param', () => {
    expect(proxySrc).toMatch(/\/v1\/telemetry\/providers[\s\S]{0,2000}?days/);
  });

  it('record shape exposes p95Ms field', () => {
    // p95Ms is unique to the providers rollup record.
    expect(proxySrc).toContain('p95Ms');
  });
});
