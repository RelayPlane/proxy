import { describe, it, expect } from 'vitest';
import { MODEL_MAPPING, SMART_ALIASES } from '../src/standalone-proxy';
import { MODEL_PRICING } from '../src/telemetry';

describe('model-catalog: new June 2026 aliases', () => {
  it('test_alias_claude_opus_4_8_resolves', () => {
    expect(MODEL_MAPPING['claude-opus-4-8']).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('test_alias_claude_fable_5_resolves', () => {
    expect(MODEL_MAPPING['claude-fable-5']).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });

  it('test_alias_claude_fable_short_resolves', () => {
    expect(MODEL_MAPPING['claude-fable']).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });

  it('test_alias_claude_mythos_5_preview_resolves', () => {
    expect(MODEL_MAPPING['claude-mythos-5-preview']).toEqual({ provider: 'anthropic', model: 'claude-mythos-5' });
  });

  it('test_alias_gpt_5_5_resolves', () => {
    expect(MODEL_MAPPING['gpt-5.5']).toEqual({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('test_alias_gpt_5_4_mini_resolves', () => {
    expect(MODEL_MAPPING['gpt-5.4-mini']).toEqual({ provider: 'openai', model: 'gpt-5.4-mini' });
  });
});

describe('model-catalog: new pricing entries', () => {
  it('test_pricing_claude_opus_4_8', () => {
    expect(MODEL_PRICING['claude-opus-4-8']).toEqual({ input: 5.0, output: 25.0 });
  });

  it('test_pricing_claude_fable_5', () => {
    expect(MODEL_PRICING['claude-fable-5']).toEqual({ input: 10.0, output: 50.0 });
  });

  it('test_pricing_claude_mythos_5', () => {
    expect(MODEL_PRICING['claude-mythos-5']).toEqual({ input: 10.0, output: 50.0 });
  });

  it('test_pricing_gpt_5_5_present', () => {
    const entry = MODEL_PRICING['gpt-5.5'];
    expect(entry).toBeDefined();
    expect(entry.input).toBeGreaterThan(0);
    expect(entry.output).toBeGreaterThan(0);
  });

  it('test_pricing_gpt_5_4_mini_present', () => {
    const entry = MODEL_PRICING['gpt-5.4-mini'];
    expect(entry).toBeDefined();
    expect(entry.input).toBeGreaterThan(0);
    expect(entry.output).toBeGreaterThan(0);
  });
});

describe('model-catalog: snapshot - existing aliases unchanged', () => {
  it('test_snapshot_opus_alias_resolves_to_opus_5', () => {
    // opus resolves to Opus 5 (May 2026), the flagship agentic-coding model
    // promoted over Opus 4.8 at the same $5/$25 pricing.
    expect(MODEL_MAPPING['opus']).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('test_snapshot_existing_sonnet_haiku_unchanged', () => {
    expect(MODEL_MAPPING['sonnet']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(MODEL_MAPPING['haiku']).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('test_snapshot_existing_rp_aliases', () => {
    // rp:best promoted to Opus 5 (flagship); fast/cheap/balanced on Sonnet 5
    // (the current Sonnet) as part of the 2026-07 model update.
    expect(SMART_ALIASES['rp:best']).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(SMART_ALIASES['rp:fast']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(SMART_ALIASES['rp:cheap']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(SMART_ALIASES['rp:balanced']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });
});

describe('model-catalog: mythos alias-only enforcement', () => {
  it('test_mythos_not_in_default_tiers', () => {
    const rpAliases = ['rp:best', 'rp:fast', 'rp:cheap', 'rp:balanced'];
    for (const alias of rpAliases) {
      const resolved = SMART_ALIASES[alias];
      if (resolved) {
        expect(resolved.model).not.toBe('claude-mythos-5');
      }
    }
    const rpMythosKeys = Object.entries(SMART_ALIASES)
      .filter(([k, v]) => k.startsWith('rp:') && v.model === 'claude-mythos-5');
    expect(rpMythosKeys).toHaveLength(0);
    // Only claude-mythos-5-preview alias may map to claude-mythos-5 in MODEL_MAPPING
    const mythosKeys = Object.entries(MODEL_MAPPING)
      .filter(([k, v]) => v.model === 'claude-mythos-5');
    for (const [k] of mythosKeys) {
      expect(k).toBe('claude-mythos-5-preview');
    }
  });
});
