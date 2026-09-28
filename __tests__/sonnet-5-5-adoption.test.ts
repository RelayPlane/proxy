/**
 * RelayPlane Sonnet 5.5 adoption (2026-09-28; supersedes the Sonnet 5 spec).
 *
 * Verifies that claude-sonnet-5-5 is the canonical Sonnet default across:
 *  - DEFAULT_DOWNGRADE_MAPPING (opus tier degrades to sonnet-5-5; sonnet-5-5 has its
 *    own downgrade to haiku; the legacy sonnet-5 entry stays for explicit requests)
 *  - MODEL_MAPPING aliases (`sonnet`, `claude-sonnet-4`) resolve to claude-sonnet-5-5
 *  - an explicit claude-sonnet-5 request is still honored as-is
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_DOWNGRADE_MAPPING } from '../src/downgrade.js';
import { MODEL_MAPPING, SMART_ALIASES } from '../src/standalone-proxy.js';

describe('Sonnet 5.5 adoption: downgrade map', () => {
  it('claude-opus-5-5 downgrades to claude-sonnet-5-5', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-opus-5-5']).toBe('claude-sonnet-5-5');
  });

  it('claude-opus-4-6 downgrades to claude-sonnet-5-5', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-opus-4-6']).toBe('claude-sonnet-5-5');
  });

  it('claude-opus-4-8 downgrades to claude-sonnet-5-5', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-opus-4-8']).toBe('claude-sonnet-5-5');
  });

  it('claude-sonnet-5-5 has its own downgrade entry to haiku', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-sonnet-5-5']).toBe('claude-haiku-4-5-20251001');
  });

  it('preserves back-compat entries for claude-sonnet-5 and claude-sonnet-4-6', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-sonnet-5']).toBeDefined();
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-sonnet-4-6']).toBeDefined();
  });
});

describe('Sonnet 5.5 adoption: proxy aliases', () => {
  it('bare "sonnet" alias resolves to claude-sonnet-5-5', () => {
    expect(MODEL_MAPPING['sonnet']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('"claude-sonnet-4" legacy alias resolves to claude-sonnet-5-5', () => {
    expect(MODEL_MAPPING['claude-sonnet-4']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('claude-sonnet-5-5 maps to itself', () => {
    expect(MODEL_MAPPING['claude-sonnet-5-5']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('an explicit claude-sonnet-5 request is honored (legacy, still served)', () => {
    expect(MODEL_MAPPING['claude-sonnet-5']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('Max-plan smart aliases fast/cheap/balanced sit on Sonnet 5.5', () => {
    for (const k of ['rp:fast', 'rp:cheap', 'rp:balanced']) {
      expect(SMART_ALIASES[k]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    }
  });
});
