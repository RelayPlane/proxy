/**
 * TDD Phase 1: Failing tests for PR B gap - the allow_elite_auto gate is not
 * actually wired into the config that the live request path reads from.
 *
 * standalone-proxy.ts's request handlers never call resolveComplexityTier();
 * they look up the model directly via `proxyConfig.routing.complexity[complexity]`.
 * That config object is built by buildDefaultComplexityTiers(), which fills any
 * missing tier (including 'elite') straight from PROVIDER_COMPLEXITY_TIERS with
 * no awareness of routing.allow_elite_auto at all.
 *
 * Net effect: an EXISTING install with complexity routing enabled but no
 * allow_elite_auto key gets 'elite' silently populated with claude-fable-5,
 * and any request that classifies as 'elite' (score >= 16) is routed there
 * live - violating "no existing routing decision changes without opt-in."
 *
 * These tests fail today because:
 *   1. buildDefaultComplexityTiers is not exported from standalone-proxy.ts.
 *   2. Even once accessible, its signature has no allow_elite_auto parameter,
 *      so it cannot suppress the elite tier for ungated installs.
 */
import { describe, it, expect } from 'vitest';
import * as proxyMod from '../src/standalone-proxy.js';

describe('PR B gap: allow_elite_auto gate must reach the live tier-building path', () => {
  const mod = proxyMod as unknown as Record<string, unknown>;

  it('buildDefaultComplexityTiers is exported from standalone-proxy', () => {
    // Fails today: buildDefaultComplexityTiers is module-private.
    expect(typeof mod['buildDefaultComplexityTiers']).toBe('function');
  });

  it('an existing install without allow_elite_auto never gets claude-fable-5 in its built elite tier', () => {
    const fn = mod['buildDefaultComplexityTiers'] as (
      providers: string[],
      existing?: Record<string, unknown>,
      opts?: { allow_elite_auto?: boolean }
    ) => { elite: { provider: string; model: string } };
    expect(typeof fn).toBe('function');

    // Simulates a pre-existing config.json: complexity routing enabled,
    // no 'elite' key set, and no allow_elite_auto opt-in anywhere.
    const existingComplexity = {
      enabled: true,
      simple: 'claude-haiku-4-5',
      moderate: 'claude-sonnet-5',
      complex: 'claude-opus-4-6',
    };

    const tiers = fn(['anthropic'], existingComplexity, { allow_elite_auto: false });

    // Must NOT silently expose the elite model to an ungated install.
    expect(tiers.elite.model).not.toBe('claude-fable-5');
  });

  it('allow_elite_auto:true does allow the built elite tier to resolve to claude-fable-5', () => {
    const fn = mod['buildDefaultComplexityTiers'] as (
      providers: string[],
      existing?: Record<string, unknown>,
      opts?: { allow_elite_auto?: boolean }
    ) => { elite: { provider: string; model: string } };
    expect(typeof fn).toBe('function');

    const tiers = fn(['anthropic'], undefined, { allow_elite_auto: true });
    expect(tiers.elite.model).toBe('claude-fable-5');
  });

  it('calling buildDefaultComplexityTiers with today\'s two-argument call signature must still gate elite off by default', () => {
    const fn = mod['buildDefaultComplexityTiers'] as (
      providers: string[],
      existing?: Record<string, unknown>
    ) => { elite: { provider: string; model: string } };
    expect(typeof fn).toBe('function');

    // No opts object at all - the exact call shape used at today's production
    // call sites (standalone-proxy.ts:4442 and :4471). Absent any explicit
    // opt-in, the result must not carry the live elite model.
    const existingComplexity = {
      enabled: true,
      simple: 'claude-haiku-4-5',
      moderate: 'claude-sonnet-5',
      complex: 'claude-opus-4-6',
    };
    const tiers = fn(['anthropic'], existingComplexity);
    expect(tiers.elite.model).not.toBe('claude-fable-5');
  });
});
