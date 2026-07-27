/**
 * Autofix: resolveComplexityTier with allow_elite_auto=false must NOT return
 * claude-opus-4-8. The opus drift fix is opt-in only; without the flag,
 * existing installs must retain the pre-drift model.
 *
 * Root cause: PROVIDER_COMPLEXITY_TIERS.anthropic.complex was updated to
 * claude-opus-4-8, which makes the allow_elite_auto gate in resolveComplexityTier
 * a no-op for the complex tier. The fallback path returns the same model as the
 * opt-in path, breaking backwards compatibility.
 */
import { describe, it, expect } from 'vitest';
import { resolveComplexityTier } from '../src/standalone-proxy.js';

describe('resolveComplexityTier backwards-compat gate', () => {
  it('complex WITHOUT allow_elite_auto must not return claude-opus-4-8', () => {
    const result = resolveComplexityTier('complex', {
      provider: 'anthropic',
      allow_elite_auto: false,
    });
    expect(result.model).not.toBe('claude-opus-4-8');
  });

  it('complex with no allow_elite_auto flag must not return claude-opus-4-8', () => {
    const result = resolveComplexityTier('complex', {
      provider: 'anthropic',
    });
    expect(result.model).not.toBe('claude-opus-4-8');
  });
});
