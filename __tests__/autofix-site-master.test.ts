/**
 * Failing test for: [autofix] Fix broken tests in proxy (relayplane-site)
 *
 * The proxy package's test suite previously contained a hard-coded
 * `expect(false).toBe(true)` placeholder that cascaded into the
 * relayplane-site master autofix pipeline as ECONNREFUSED:4100.
 *
 * Phase 2 will replace this failing assertion with a real check that
 * the proxy suite runs green without requiring a live server bound to
 * port 4100. For now, Phase 1 asserts a condition that must be false
 * until the fix lands.
 */

import { describe, it, expect } from 'vitest';

describe('autofix-relayplane-site-proxy-test-suite', () => {
  it('proxy unit tests must not require a live server on port 4100', () => {
    // Phase 1 placeholder: this assertion fails on purpose so Phase 2
    // can replace it with a real check (e.g. that the proxy package
    // exposes a testable factory that does not bind to a port).
    const proxyTestsAreServerFree = false;
    expect(proxyTestsAreServerFree).toBe(true);
  });
});
