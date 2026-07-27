/**
 * Failing test for spec: RelayPlane Sonnet 5 adoption.
 *
 * Verifies that claude-sonnet-5 is the canonical default across:
 *  - DEFAULT_DOWNGRADE_MAPPING (opus tier degrades to sonnet-5; sonnet-5 has its own
 *    downgrade to haiku)
 *  - MODEL_MAPPING aliases (`sonnet`, `claude-sonnet-4`) resolve to claude-sonnet-5
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_DOWNGRADE_MAPPING } from '../src/downgrade.js';
import { MODEL_MAPPING } from '../src/standalone-proxy.js';

describe('Sonnet 5 adoption: downgrade map', () => {
  it('claude-opus-4-6 downgrades to claude-sonnet-5', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-opus-4-6']).toBe('claude-sonnet-5');
  });

  it('claude-opus-4-8 downgrades to claude-sonnet-5', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-opus-4-8']).toBe('claude-sonnet-5');
  });

  it('claude-sonnet-5 has its own downgrade entry to haiku', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-sonnet-5']).toBe('claude-3-5-haiku-20241022');
  });

  it('preserves back-compat entry for claude-sonnet-4-6', () => {
    expect(DEFAULT_DOWNGRADE_MAPPING['claude-sonnet-4-6']).toBeDefined();
  });
});

describe('Sonnet 5 adoption: proxy aliases', () => {
  it('bare "sonnet" alias resolves to claude-sonnet-5', () => {
    expect(MODEL_MAPPING['sonnet']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  it('"claude-sonnet-4" legacy alias resolves to claude-sonnet-5', () => {
    expect(MODEL_MAPPING['claude-sonnet-4']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });
});
