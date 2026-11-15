/**
 * Guards the ledger cost recorded by ProxyServer (src/server.ts).
 *
 * server.ts used to keep its own per-1K table that priced every OpenAI
 * run at $5/$15 per 1M (the old GPT-4o launch price) and every Claude
 * run at Sonnet rates, whatever the model. It now prices by model id
 * through telemetry.ts and only falls back to a provider rate for
 * models with no row.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MODEL_PRICING,
  PROVIDER_FALLBACK_PRICING,
  estimateCost,
  estimateProviderCost,
} from '../src/telemetry.js';

const M = 1_000_000;

describe('estimateProviderCost', () => {
  it('prices gpt-4o at its list price, not $5/$15', () => {
    expect(estimateProviderCost('openai', 'gpt-4o', M, M)).toBeCloseTo(2.5 + 10, 10);
  });

  it('prices by model, not by provider', () => {
    expect(estimateProviderCost('anthropic', 'claude-haiku-4-5', M, M)).toBeCloseTo(1 + 5, 10);
    expect(estimateProviderCost('anthropic', 'claude-opus-4-6', M, M)).toBeCloseTo(5 + 25, 10);
    expect(estimateProviderCost('openai', 'gpt-4o-mini', M, M)).toBeCloseTo(0.15 + 0.6, 10);
  });

  it('agrees with estimateCost for every known model', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      if (model === 'default') continue;
      expect(estimateProviderCost('openai', model, 1234, 567), model).toBeCloseTo(
        estimateCost(model, 1234, 567),
        12,
      );
    }
  });

  it('accepts provider-prefixed ids', () => {
    expect(estimateProviderCost('openrouter', 'anthropic/claude-sonnet-4-6', M, M)).toBeCloseTo(3 + 15, 10);
  });

  it('falls back to the provider row for unknown models', () => {
    const openai = PROVIDER_FALLBACK_PRICING['openai']!;
    expect(estimateProviderCost('openai', 'some-new-model', M, M)).toBeCloseTo(openai.input + openai.output, 10);
    expect(estimateProviderCost('openai', undefined, M, 0)).toBeCloseTo(openai.input, 10);
    const anthropic = PROVIDER_FALLBACK_PRICING['anthropic']!;
    expect(estimateProviderCost('unknown-provider', 'x', M, M)).toBeCloseTo(anthropic.input + anthropic.output, 10);
  });

  it('fallback rows match the model rows they name', () => {
    expect(PROVIDER_FALLBACK_PRICING['openai']).toEqual(MODEL_PRICING['gpt-4o']);
    expect(PROVIDER_FALLBACK_PRICING['anthropic']).toEqual(MODEL_PRICING['claude-sonnet-4-6']);
  });
});

describe('server.ts', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf-8');

  it('has no hand-kept price table of its own', () => {
    expect(src).not.toMatch(/input:\s*0\.00\d+,\s*output:\s*0\.0\d+/);
    expect(src).toMatch(/estimateProviderCost\(provider, model,/);
  });
});
