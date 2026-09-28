import { describe, it, expect } from 'vitest';
import {
  shouldTierFallback,
  buildTierFallbackChain,
  resolveTierFallbackConfig,
  DEFAULT_TIER_FALLBACK_CONFIG,
  DEFAULT_TIER_FALLBACK_MAP,
  DEFAULT_TIER_FALLBACK_TRIGGER_STATUSES,
  type TierFallbackConfig,
} from '../src/model-tier-fallback.js';

describe('Model-Tier Fallback (same-provider capacity incident, 2026-09-28)', () => {
  const config: TierFallbackConfig = {
    enabled: true,
    mapping: { ...DEFAULT_TIER_FALLBACK_MAP },
    triggerStatuses: [...DEFAULT_TIER_FALLBACK_TRIGGER_STATUSES],
    maxHops: 3,
  };

  describe('shouldTierFallback', () => {
    it('triggers on 429', () => {
      expect(shouldTierFallback(429, config)).toBe(true);
    });
    it('triggers on 503 and 529', () => {
      expect(shouldTierFallback(503, config)).toBe(true);
      expect(shouldTierFallback(529, config)).toBe(true);
    });
    it('does not trigger on 400/401/200', () => {
      expect(shouldTierFallback(400, config)).toBe(false);
      expect(shouldTierFallback(401, config)).toBe(false);
      expect(shouldTierFallback(200, config)).toBe(false);
    });
    it('never triggers when disabled', () => {
      expect(shouldTierFallback(429, { ...config, enabled: false })).toBe(false);
    });
    it('respects a custom triggerStatuses list', () => {
      const custom = { ...config, triggerStatuses: [503] };
      expect(shouldTierFallback(429, custom)).toBe(false);
      expect(shouldTierFallback(503, custom)).toBe(true);
    });
  });

  describe('buildTierFallbackChain', () => {
    it('sonnet-5-5 falls back to sonnet-5 then haiku', () => {
      expect(buildTierFallbackChain('claude-sonnet-5-5', config)).toEqual([
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('opus-5-5 falls back to opus-5, then sonnet-5, then haiku', () => {
      expect(buildTierFallbackChain('claude-opus-5-5', config)).toEqual([
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('opus-5 falls back to sonnet-5 then haiku', () => {
      expect(buildTierFallbackChain('claude-opus-5', config)).toEqual([
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('returns [] for a model with no mapping (e.g. haiku itself)', () => {
      expect(buildTierFallbackChain('claude-haiku-4-5-20251001', config)).toEqual([]);
    });

    it('returns [] when disabled', () => {
      expect(buildTierFallbackChain('claude-opus-5-5', { ...config, enabled: false })).toEqual([]);
    });

    it('caps the chain length at maxHops', () => {
      const capped = buildTierFallbackChain('claude-opus-5-5', { ...config, maxHops: 1 });
      expect(capped).toEqual(['claude-opus-5']);
    });

    it('never loops on a cyclic mapping', () => {
      const cyclic: TierFallbackConfig = {
        ...config,
        mapping: { a: 'b', b: 'a' },
        maxHops: 10,
      };
      const chain = buildTierFallbackChain('a', cyclic);
      expect(chain).toEqual(['b']);
    });

    it('honors a custom mapping override', () => {
      const custom = { ...config, mapping: { 'claude-opus-5-5': 'claude-haiku-4-5-20251001' } };
      expect(buildTierFallbackChain('claude-opus-5-5', custom)).toEqual(['claude-haiku-4-5-20251001']);
    });
  });

  describe('resolveTierFallbackConfig', () => {
    it('returns built-in defaults when no partial given', () => {
      const resolved = resolveTierFallbackConfig(undefined);
      expect(resolved).toEqual(DEFAULT_TIER_FALLBACK_CONFIG);
    });

    it('merges user mapping overrides over the built-in map, keeping the rest', () => {
      const resolved = resolveTierFallbackConfig({ mapping: { 'claude-opus-5-5': 'claude-haiku-4-5-20251001' } });
      expect(resolved.mapping['claude-opus-5-5']).toBe('claude-haiku-4-5-20251001');
      // Built-in entries not overridden survive the merge.
      expect(resolved.mapping['claude-sonnet-5-5']).toBe('claude-sonnet-5');
      expect(resolved.enabled).toBe(true);
    });

    it('allows disabling entirely via config', () => {
      const resolved = resolveTierFallbackConfig({ enabled: false });
      expect(resolved.enabled).toBe(false);
      expect(shouldTierFallback(429, resolved)).toBe(false);
    });

    it('allows a custom maxHops', () => {
      const resolved = resolveTierFallbackConfig({ maxHops: 1 });
      expect(buildTierFallbackChain('claude-opus-5-5', resolved)).toEqual(['claude-opus-5']);
    });
  });
});
