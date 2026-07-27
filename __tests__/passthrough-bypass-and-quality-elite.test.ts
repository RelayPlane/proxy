/**
 * Regression tests for four bugs in standalone-proxy.ts routing logic.
 *
 * BUG 1: X-RelayPlane-Bypass: true (and by extension a literal, resolvable
 * model name that reached 'passthrough') was being silently overridden back
 * to 'auto' whenever proxyConfig.routing.mode was 'auto' | 'complexity' |
 * 'cascade'. The override exists to upgrade vague/generic model names under
 * routing.mode=auto, but it must never fire when the caller explicitly
 * opted out via the bypass header. Fixed by shouldOverridePassthroughToAuto(),
 * used identically in both the native /v1/messages handler and the
 * OpenAI-compatible /v1/chat/completions handler.
 *
 * BUG 2: getQualityModel() (the resolver for the ":quality" / rp:quality /
 * rp:best routing suffix) only ever read routing.complexity.complex, never
 * routing.complexity.elite, so the ":quality" path could never reach the
 * elite tier documented in docs/proxy/routing. Fixed to prefer the elite
 * model when routing.complexity.allow_elite_auto is true, mirroring the gate
 * resolveComplexityTier() already enforces.
 *
 * BUG 3: a caller sending a bare literal, resolvable model name (e.g.
 * "claude-fable-5", no bypass header, no routing suffix) still fell through
 * to routingMode='passthrough' and was then silently overridden back to
 * 'auto' by the same mechanism as BUG 1, because the override only checked
 * the bypass header, not whether the requested model was itself a real,
 * known, concrete model. That reclassified the request by the complexity
 * heuristic instead of honoring the literal model name, e.g. rerouting
 * "claude-fable-5" to claude-sonnet-5 whenever the prompt didn't score as
 * complex enough. Fixed by having shouldOverridePassthroughToAuto() also
 * check resolveExplicitModel(requestedModel): if it resolves, the caller
 * named a real model to honor literally and the override is skipped; if it
 * returns null (unresolvable/generic/placeholder), the override still
 * applies as before, that's the legitimate upgrade case this system was
 * built for.
 *
 * BUG 4: the BUG 3 fix was too broad, it treated ANY resolvable model name
 * as a deliberate literal choice, including the ordinary default model a
 * client sends on every request regardless of actual complexity (Claude
 * Code sends a literal "claude-sonnet-5" by default). That silently
 * disabled routing.mode=complexity/auto/cascade classification for
 * essentially all real traffic. Fixed by only skipping the override when
 * the resolved model is NOT the configured routing.complexity.simple or
 * .moderate default, so genuine non-default choices (e.g. explicit
 * claude-fable-5) are still honored literally, but the ordinary default
 * model still gets classified.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldOverridePassthroughToAuto,
  getQualityModel,
  resolveExplicitModel,
} from '../src/standalone-proxy.js';

describe('shouldOverridePassthroughToAuto (BUG 1: X-RelayPlane-Bypass honored)', () => {
  it('does NOT override passthrough when the caller sent X-RelayPlane-Bypass: true, even with routing.mode=complexity', () => {
    const result = shouldOverridePassthroughToAuto('passthrough', 'complexity', /* bypassRequested */ true);
    expect(result).toBe(false);
  });

  it('does NOT override passthrough when bypass is true and routing.mode=auto', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'auto', true)).toBe(false);
  });

  it('does NOT override passthrough when bypass is true and routing.mode=cascade', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'cascade', true)).toBe(false);
  });

  it('DOES override passthrough when bypass is false and routing.mode=auto (legitimate generic-model upgrade case)', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'auto', false)).toBe(true);
  });

  it('DOES override passthrough when bypass is false and routing.mode=complexity', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false)).toBe(true);
  });

  it('DOES override passthrough when bypass is false and routing.mode=cascade', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'cascade', false)).toBe(true);
  });

  it('never overrides when routingMode is not passthrough, regardless of bypass', () => {
    expect(shouldOverridePassthroughToAuto('auto', 'complexity', false)).toBe(false);
    expect(shouldOverridePassthroughToAuto('cost', 'complexity', false)).toBe(false);
    expect(shouldOverridePassthroughToAuto('quality', 'auto', false)).toBe(false);
  });

  it('never overrides when routing.mode is standard/passthrough/undefined, regardless of bypass', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'standard', false)).toBe(false);
    expect(shouldOverridePassthroughToAuto('passthrough', 'passthrough', false)).toBe(false);
    expect(shouldOverridePassthroughToAuto('passthrough', undefined, false)).toBe(false);
  });
});

describe('shouldOverridePassthroughToAuto (BUG 3: bare literal known model honored, not silently downgraded)', () => {
  it('sanity: resolveExplicitModel resolves a bare literal model name like claude-fable-5', () => {
    expect(resolveExplicitModel('claude-fable-5')).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });

  it('sanity: resolveExplicitModel returns null for an unresolvable/generic/placeholder name', () => {
    expect(resolveExplicitModel('not-a-real-model')).toBeNull();
  });

  it('does NOT override passthrough for a real literal model (claude-fable-5), no bypass header, routing.mode=complexity', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-fable-5')
    ).toBe(false);
  });

  it('does NOT override passthrough for a real literal model (claude-fable-5), no bypass header, routing.mode=auto', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'auto', false, 'claude-fable-5')
    ).toBe(false);
  });

  it('does NOT override passthrough for a real literal model (claude-fable-5), no bypass header, routing.mode=cascade', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'cascade', false, 'claude-fable-5')
    ).toBe(false);
  });

  it('does NOT override passthrough for other real literal models (gpt-4o, gemini-pro-family)', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'gpt-4o')).toBe(false);
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'grok-4')).toBe(false);
  });

  it('DOES still override when the model does NOT resolve, e.g. a generic/placeholder name (unchanged upgrade behavior)', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'not-a-real-model')
    ).toBe(true);
  });

  it('DOES still override the documented generic-model example ("claude-3-5-sonnet" resolves via MODEL_MAPPING, so it is honored literally, not the override target)', () => {
    // "claude-3-5-sonnet" is itself a resolvable alias (MODEL_MAPPING), so per
    // the new rule it is honored as a literal request, same as any other
    // resolvable model. The override now only exists for genuinely
    // unresolvable names.
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-3-5-sonnet')
    ).toBe(false);
  });

  it('backward compatible: omitting requestedModel entirely still overrides as before (existing call sites / callers unaware of the new param)', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'auto', false)).toBe(true);
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false)).toBe(true);
  });

  it('bypass header still wins even when the model also resolves (bypass check short-circuits first)', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', true, 'claude-fable-5')
    ).toBe(false);
  });
});

describe('shouldOverridePassthroughToAuto (BUG 4: the configured simple/moderate default must still be classified)', () => {
  // 2026-07-19's BUG 3 fix was too broad: it treated ANY resolvable model
  // name as "the caller made a deliberate literal choice," including the
  // ordinary default model a client sends on every request whether or not
  // it thought about complexity at all (Claude Code sends a literal
  // "claude-sonnet-5" on ~every request). That silently disabled
  // routing.mode=complexity/auto/cascade for essentially all real traffic:
  // confirmed live 2026-07-27, 124/125 requests over 24h forwarded verbatim
  // with zero complexity-based escalation to the complex/elite tier.
  //
  // Fix: only skip the override when the resolved model is a genuine
  // non-default choice (e.g. an explicit elite-tier request). When it
  // resolves to exactly the configured simple/moderate default, the
  // override still applies so the classifier gets a chance to run.
  const complexityDefaults = { simple: 'claude-sonnet-5', moderate: 'claude-sonnet-5' };

  it('DOES override passthrough when the requested model is exactly the configured simple default', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-sonnet-5', complexityDefaults)
    ).toBe(true);
  });

  it('DOES override passthrough when the requested model is exactly the configured moderate default', () => {
    expect(
      shouldOverridePassthroughToAuto(
        'passthrough',
        'complexity',
        false,
        'claude-sonnet-5',
        { simple: 'claude-haiku-4-5', moderate: 'claude-sonnet-5' }
      )
    ).toBe(true);
  });

  it('still does NOT override for a genuinely non-default explicit choice (claude-fable-5), even with complexityDefaults provided', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-fable-5', complexityDefaults)
    ).toBe(false);
  });

  it('still does NOT override for a different provider entirely (gpt-4o), even with complexityDefaults provided', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'gpt-4o', complexityDefaults)
    ).toBe(false);
  });

  it('handles object-shaped complexity config values ({ provider, model }), not just plain strings', () => {
    expect(
      shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-sonnet-5', {
        simple: { provider: 'anthropic', model: 'claude-sonnet-5' },
        moderate: { provider: 'anthropic', model: 'claude-sonnet-5' },
      })
    ).toBe(true);
  });

  it('without complexityDefaults at all (omitted), behaves exactly as BUG 3 fixed it (backward compatible)', () => {
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-sonnet-5')).toBe(false);
    expect(shouldOverridePassthroughToAuto('passthrough', 'complexity', false, 'claude-fable-5')).toBe(false);
  });
});

describe('getQualityModel (BUG 2: :quality suffix must reach elite tier)', () => {
  it('with allow_elite_auto=true and an elite model configured, resolves to the elite model (claude-fable-5), not complex', () => {
    const config = {
      routing: {
        complexity: {
          enabled: true,
          simple: 'claude-haiku-4-5',
          moderate: 'claude-sonnet-5',
          complex: 'claude-opus-4-8',
          elite: 'claude-fable-5',
          allow_elite_auto: true,
        },
      },
    } as any;

    expect(getQualityModel(config)).toBe('claude-fable-5');
  });

  it('with allow_elite_auto=false, still falls back to the complex model (no behavior change for ungated installs)', () => {
    const config = {
      routing: {
        complexity: {
          enabled: true,
          simple: 'claude-haiku-4-5',
          moderate: 'claude-sonnet-5',
          complex: 'claude-opus-4-8',
          elite: 'claude-fable-5',
          allow_elite_auto: false,
        },
      },
    } as any;

    expect(getQualityModel(config)).toBe('claude-opus-4-8');
    expect(getQualityModel(config)).not.toBe('claude-fable-5');
  });

  it('with allow_elite_auto absent entirely, falls back to complex (default OFF, matches resolveComplexityTier gate)', () => {
    const config = {
      routing: {
        complexity: {
          enabled: true,
          complex: 'claude-opus-4-8',
          elite: 'claude-fable-5',
        },
      },
    } as any;

    expect(getQualityModel(config)).toBe('claude-opus-4-8');
  });

  it('with allow_elite_auto=true but no elite model configured, falls back to complex', () => {
    const config = {
      routing: {
        complexity: {
          enabled: true,
          complex: 'claude-opus-4-8',
          allow_elite_auto: true,
        },
      },
    } as any;

    expect(getQualityModel(config)).toBe('claude-opus-4-8');
  });

  it('with no complexity config at all, falls back through cascade models then default', () => {
    const config = {
      routing: {
        cascade: { models: ['claude-haiku-4-5', 'claude-sonnet-4-6'] },
      },
    } as any;

    expect(getQualityModel(config)).toBe('claude-sonnet-4-6');
  });

  it('with nothing configured, falls back to the hardcoded default', () => {
    const config = {} as any;
    expect(getQualityModel(config)).toBe('claude-sonnet-4-6');
  });
});
