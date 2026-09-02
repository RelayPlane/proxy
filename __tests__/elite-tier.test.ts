/**
 * TDD Phase 1: Failing tests for PR B, elite complexity tier (Fable 5)
 *
 * Tests verify:
 * 1. classifyComplexity returns 'elite' when score >= 12
 * 2. Elite is absent from classifyComplexity without a high-enough score
 * 3. Regression: configs without allow_elite_auto never get elite routing
 * 4. PROVIDER_COMPLEXITY_TIERS includes 'elite' for anthropic and openai
 */
import { describe, it, expect } from 'vitest';
import { classifyComplexity, PROVIDER_COMPLEXITY_TIERS } from '../src/standalone-proxy.js';
import * as proxyMod from '../src/standalone-proxy.js';

// Build a message array that triggers a very high complexity score (>= 12)
// so elite tier would be reached.
function buildEliteMessages(): Array<{ role: string; content: string }> {
  // architect + implement + analyze + large context = score well above 12
  const massiveContent =
    'Architect and implement a distributed microservice infrastructure. ' +
    'First analyze the existing system, then design a scalable strategy, ' +
    'then implement and refactor the authentication module using OAuth2. ' +
    'Evaluate and compare the three candidate approaches: JWT, session tokens, ' +
    'and mutual TLS. ' +
    'a '.repeat(6000); // push tokens > 5000 for extra score
  return [{ role: 'user', content: massiveContent }];
}

describe('elite complexity tier (PR B)', () => {
  describe('classifyComplexity returns elite at score >= 12', () => {
    it('classifies a very high-complexity message as elite', () => {
      const messages = buildEliteMessages();
      const result = classifyComplexity(messages);
      // Implementation must return 'elite' when score >= 12; currently fails
      // because 'elite' tier does not exist yet.
      expect(result).toBe('elite');
    });

    it('does not classify moderate complexity as elite', () => {
      const messages = [{ role: 'user', content: 'What is 2 + 2?' }];
      const result = classifyComplexity(messages);
      expect(result).not.toBe('elite');
    });

    it('does not classify high-but-not-elite complexity as elite (score 4-11 = complex)', () => {
      // triggers a few signals but well below 12
      const messages = [
        {
          role: 'user',
          content:
            'Implement a login function and compare it with the existing one. ' +
            'Analyze the security trade-offs.',
        },
      ];
      const result = classifyComplexity(messages);
      // Should be 'complex' not 'elite'
      expect(result).toBe('complex');
      expect(result).not.toBe('elite');
    });
  });

  describe('PROVIDER_COMPLEXITY_TIERS includes elite', () => {
    it('classifyComplexity reaches the elite tier (anthropic elite = claude-fable-5-1, ban lifted 2026-07-02)', async () => {
      // We import the module and inspect the exported constant.
      // This will fail until PROVIDER_COMPLEXITY_TIERS is extended.
      const mod = await import('../src/standalone-proxy.js');
      // The constant is not exported yet; this import will succeed for the file
      // but the property check below will fail once we can inspect it.
      // We test via the public classifyComplexity + routing behavior instead,
      // but we need the tiers to be accessible. For now we assert via a
      // round-trip: if the module exports a getEliteTier helper or if the
      // internal constant is reflected we'll use it. The failing assertion
      // below tests the contract without needing a named export.

      // Verify that 'elite' is a valid Complexity value by asserting the
      // classify function can produce it (already tested above, repeated
      // here as a clear contract assertion).
      const eliteMessages = buildEliteMessages();
      const tier = mod.classifyComplexity(eliteMessages);
      expect(tier).toBe('elite');
    });
  });

  describe('regression: configs without allow_elite_auto never route to elite', () => {
    it('classifyComplexity still returns complex (not elite) for high-score content when elite is disabled', () => {
      // Before implementation, classifyComplexity has no elite tier,
      // so this test currently PASSES (result is 'complex').
      // After implementation, classifyComplexity may return 'elite',
      // but the ROUTING layer must suppress it when allow_elite_auto is false.
      // This test specifically checks the classification boundary:
      // a message that scores 4-11 must never become elite regardless of config.
      const messages = [
        {
          role: 'user',
          content:
            'Implement a caching layer for our Node.js API. First define the ' +
            'interface, then compare Redis versus in-memory options, and evaluate ' +
            'the trade-offs. Calculate the estimated latency savings. ' +
            'a '.repeat(600), // push tokens ~500 but not 5000
        },
      ];
      const result = classifyComplexity(messages);
      // Must be 'complex' or lower, never 'elite'
      expect(['simple', 'moderate', 'complex']).toContain(result);
    });

    it('a config without allow_elite_auto sees identical 3-tier behavior to current', () => {
      // Verify the three canonical tiers still work as before.
      const simpleMsg = [{ role: 'user', content: 'Hello' }];
      const moderateMsg = [{ role: 'user', content: 'Analyze this code snippet for bugs: ' + '`function foo() {}'  }];
      const complexMsg = [
        {
          role: 'user',
          content:
            'Implement and refactor the authentication module. ' +
            'a '.repeat(2500), // > 2000 tokens
        },
      ];

      const simpleResult = classifyComplexity(simpleMsg);
      const moderateResult = classifyComplexity(moderateMsg);
      const complexResult = classifyComplexity(complexMsg);

      // All three canonical tiers must still be reachable.
      expect(['simple', 'moderate', 'complex']).toContain(simpleResult);
      expect(['simple', 'moderate', 'complex']).toContain(moderateResult);
      expect(['simple', 'moderate', 'complex']).toContain(complexResult);

      // None of them should be elite when the content doesn't push score >= 12.
      expect(simpleResult).not.toBe('elite');
      expect(moderateResult).not.toBe('elite');
    });
  });

  describe('elite classifier threshold is >= 12 (very rare)', () => {
    it('content that scores exactly around 11 is NOT elite', () => {
      // architect (3) + implement (2) + analyze (2) + refactor (2) + 500 tokens (1) + and x3 (1)
      // = ~11 - should be 'complex', not 'elite'
      const messages = [
        {
          role: 'user',
          content:
            'Architect and implement a microservice solution. Analyze the approach ' +
            'and refactor where needed. What do you think about scalability and ' +
            'performance and cost? ' +
            'a '.repeat(500),
        },
      ];
      const result = classifyComplexity(messages);
      // Until implementation exists, this is 'complex' (current max).
      // After implementation, if score reaches 12 it becomes elite. This test
      // acts as a boundary guard to ensure elite is truly rare.
      expect(result).not.toBe('elite');
    });
  });

  // ---------------------------------------------------------------------------
  // FAILING TESTS: resolveComplexityTier + allow_elite_auto gate + opus drift fix
  //
  // These tests cover the unimplemented routing-layer behaviors:
  //   1. resolveComplexityTier must be exported (does not exist yet)
  //   2. allow_elite_auto:true gates elite model routing
  //   3. allow_elite_auto absent/false suppresses elite -> falls back to complex
  //   4. PROVIDER_COMPLEXITY_TIERS elite entries (claude-fable-5-1, gpt-5.5)
  //   5. Opus drift fix: complex -> claude-opus-4-8 when allow_elite_auto:true
  // ---------------------------------------------------------------------------
  describe('resolveComplexityTier (allow_elite_auto gate)', () => {
    const mod = proxyMod as unknown as Record<string, unknown>;

    it('resolveComplexityTier is exported from the proxy module', () => {
      // Fails until the function is implemented and exported
      expect(typeof mod['resolveComplexityTier']).toBe('function');
    });

    it('elite + allow_elite_auto:true + anthropic resolves to claude-fable-5-1', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      // Fails at this expect if function is not yet exported
      expect(typeof fn).toBe('function');
      const result = fn('elite', { provider: 'anthropic', allow_elite_auto: true });
      expect(result).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5-1' });
    });

    it('elite + allow_elite_auto:true + openai resolves to gpt-5.5', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      const result = fn('elite', { provider: 'openai', allow_elite_auto: true });
      expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
    });

    it('elite + allow_elite_auto:false suppresses elite and falls back to complex tier', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      const result = fn('elite', { provider: 'anthropic', allow_elite_auto: false });
      // Must NOT route to the elite model when the gate is off.
      // Guard both the old and the new Fable id.
      expect(result.model).not.toBe('claude-fable-5');
      expect(result.model).not.toBe('claude-fable-5-1');
      expect(result.model).not.toBe('gpt-5.5');
      // Must be a real model (non-empty string)
      expect(typeof result.model).toBe('string');
      expect(result.model.length).toBeGreaterThan(0);
    });

    it('elite with allow_elite_auto absent (default OFF) falls back to complex tier', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      // allow_elite_auto key is entirely absent - must behave identically to false
      const result = fn('elite', { provider: 'anthropic' });
      expect(result.model).not.toBe('claude-fable-5');
      expect(result.model).not.toBe('claude-fable-5-1');
      expect(result.model).not.toBe('gpt-5.5');
    });

    it('complex + allow_elite_auto:true + anthropic resolves to claude-opus-5 (flagship promotion)', () => {
      // Opus 5 (May 2026) is the flagship agentic-coding model, the successor to
      // Opus 4.8 at the same $5/$25 pricing; the gated complex path resolves to it.
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      const result = fn('complex', { provider: 'anthropic', allow_elite_auto: true });
      expect(result).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    });

    it('complex WITHOUT allow_elite_auto preserves existing model (no backwards-compat breakage)', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      const result = fn('complex', { provider: 'anthropic', allow_elite_auto: false });
      // The drift fix MUST NOT apply without opt-in; existing routing is unchanged.
      expect(result.model).not.toBe('claude-opus-4-8');
    });

    it('PROVIDER_COMPLEXITY_TIERS anthropic elite maps to claude-fable-5-1 (via resolveComplexityTier)', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      // Both Anthropic API-key and Max OAuth paths share 'anthropic' provider
      const result = fn('elite', { provider: 'anthropic', allow_elite_auto: true });
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-fable-5-1' });
    });

    it('PROVIDER_COMPLEXITY_TIERS openai elite maps to gpt-5.5 (via resolveComplexityTier)', () => {
      const fn = mod['resolveComplexityTier'] as (...args: unknown[]) => { provider: string; model: string };
      expect(typeof fn).toBe('function');
      const result = fn('elite', { provider: 'openai', allow_elite_auto: true });
      expect(result).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    });
  });

  // ---------------------------------------------------------------------------
  // FAILING TEST: PROVIDER_COMPLEXITY_TIERS must literally carry an 'elite'
  // entry for the anthropic and openai tables (not just special-cased inside
  // resolveComplexityTier). The acceptance criteria for PR B requires elite
  // to be added directly to PROVIDER_COMPLEXITY_TIERS "for all three auth
  // paths (Anthropic + API key, Anthropic Max OAuth, OpenAI)". Anthropic API
  // key and Anthropic Max OAuth both resolve through the single 'anthropic'
  // provider table entry, so both auth paths are covered by that one entry.
  //
  // PROVIDER_COMPLEXITY_TIERS is not currently exported and its ComplexityTiers
  // shape has no 'elite' field, so this import and these assertions fail today.
  // ---------------------------------------------------------------------------
  describe('PROVIDER_COMPLEXITY_TIERS table carries elite directly (not just via resolveComplexityTier)', () => {
    it('anthropic tier table has an elite entry mapping to claude-fable-5-1 (covers both Anthropic auth paths)', () => {
      expect(PROVIDER_COMPLEXITY_TIERS.anthropic.elite).toEqual({
        provider: 'anthropic',
        model: 'claude-fable-5-1',
      });
    });

    it('openai tier table has an elite entry mapping to gpt-5.5', () => {
      expect(PROVIDER_COMPLEXITY_TIERS.openai.elite).toEqual({
        provider: 'openai',
        model: 'gpt-5.5',
      });
    });

    it('static complex tier resolves to claude-opus-5 (flagship agentic-coding model)', () => {
      // The static table's complex tier was promoted to Opus 5 (May 2026), the
      // successor to Opus 4.8, so gated and ungated paths both land on the
      // current flagship instead of the stale Opus 4.6.
      expect(PROVIDER_COMPLEXITY_TIERS.anthropic.complex.model).toBe('claude-opus-5');
    });
  });
});
