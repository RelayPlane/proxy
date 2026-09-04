/**
 * Model list prices, single source of truth for the proxy.
 *
 * Every price table in packages/proxy (telemetry.ts MODEL_PRICING,
 * policy-analyzer.ts MODEL_COST_PER_1M) derives its Anthropic and
 * OpenAI rows from this file. Do not add a Claude or GPT price anywhere
 * else in the proxy.
 *
 * Rules (2026-09-04 honesty pass):
 *   1. A row exists only if the price was verified against a public
 *      source on the date shown. Unverifiable models are EXCLUDED, not
 *      guessed; they fall through to the caller's default row.
 *   2. The markdown tables in this doc comment are machine-checked.
 *      __tests__/model-pricing.test.ts parses them and fails if any row
 *      disagrees with the exported constants, or if a constant has no
 *      row. Update both together.
 *
 * All prices are USD per 1M tokens.
 *
 * ANTHROPIC
 * Source:   https://platform.claude.com/docs/en/about-claude/pricing
 * Verified: 2026-09-04
 * Note: Sonnet 5's $2/$10 launch price was made permanent on 2026-08-10;
 * the previously scheduled $3/$15 increase will not occur.
 *
 * | model              | input | output | status  |
 * |--------------------|-------|--------|---------|
 * | claude-fable-5-1   | 10    | 50     | current |
 * | claude-mythos-5-1  | 10    | 50     | current |
 * | claude-fable-5     | 10    | 50     | current |
 * | claude-mythos-5    | 10    | 50     | current |
 * | claude-opus-5      | 5     | 25     | current |
 * | claude-opus-4-8    | 5     | 25     | current |
 * | claude-opus-4-7    | 5     | 25     | current |
 * | claude-opus-4-6    | 5     | 25     | current |
 * | claude-opus-4-5    | 5     | 25     | current |
 * | claude-opus-4-1    | 15    | 75     | retired |
 * | claude-opus-4      | 15    | 75     | retired |
 * | claude-sonnet-5    | 2     | 10     | current |
 * | claude-sonnet-4-6  | 3     | 15     | current |
 * | claude-sonnet-4-5  | 3     | 15     | current |
 * | claude-sonnet-4    | 3     | 15     | retired |
 * | claude-haiku-4-5   | 1     | 5      | current |
 * | claude-3-5-haiku   | 0.8   | 4      | retired |
 *
 * Cache reads are 0.1x input on every model except Fable 5.1 and
 * Mythos 5.1, where they are 0.025x (see cacheReadMultiplier).
 *
 * OPENAI (routing tier defaults only)
 * Source:   https://openrouter.ai/api/v1/models (openai.com/api/pricing
 *           returns 403 to non-browser clients, so OpenRouter's public
 *           listing of OpenAI's own prices is the verifiable source)
 * Verified: 2026-09-04
 *
 * | model              | input | output | status  |
 * |--------------------|-------|--------|---------|
 * | gpt-5.5            | 5     | 30     | current |
 * | gpt-5.4            | 2.5   | 15     | current |
 * | gpt-5.4-mini       | 0.75  | 4.5    | current |
 * | gpt-4.1-mini       | 0.4   | 1.6    | current |
 *
 * @packageDocumentation
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** Cache-read price as a fraction of input. Defaults to 0.1 when absent. */
  cacheReadMultiplier?: number;
}

export const PRICING_VERIFIED_ON = '2026-09-04';
export const ANTHROPIC_PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const OPENAI_PRICING_SOURCE = 'https://openrouter.ai/api/v1/models';

const FRONTIER: ModelPrice = { input: 10.0, output: 50.0 };
const FRONTIER_5_1: ModelPrice = { input: 10.0, output: 50.0, cacheReadMultiplier: 0.025 };
const OPUS: ModelPrice = { input: 5.0, output: 25.0 };
const OPUS_LEGACY: ModelPrice = { input: 15.0, output: 75.0 };
const SONNET_5: ModelPrice = { input: 2.0, output: 10.0 };
const SONNET_LEGACY: ModelPrice = { input: 3.0, output: 15.0 };
const HAIKU_4_5: ModelPrice = { input: 1.0, output: 5.0 };
const HAIKU_3_5: ModelPrice = { input: 0.8, output: 4.0 };

/**
 * Canonical Anthropic model ids and their verified list prices.
 * Keys match the rows of the ANTHROPIC table above exactly.
 */
export const ANTHROPIC_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': FRONTIER_5_1,
  'claude-mythos-5-1': FRONTIER_5_1,
  'claude-fable-5': FRONTIER,
  'claude-mythos-5': FRONTIER,
  'claude-opus-5': OPUS,
  'claude-opus-4-8': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-5': OPUS,
  'claude-opus-4-1': OPUS_LEGACY,
  'claude-opus-4': OPUS_LEGACY,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-4-6': SONNET_LEGACY,
  'claude-sonnet-4-5': SONNET_LEGACY,
  'claude-sonnet-4': SONNET_LEGACY,
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-3-5-haiku': HAIKU_3_5,
};

/**
 * Alternate spellings of the canonical ids (dated snapshots, -latest
 * aliases, OpenRouter-style dotted ids). Each maps to a canonical key
 * above; the test fails if a target is missing from the table.
 */
export const ANTHROPIC_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'claude-opus-4-20250514': 'claude-opus-4',
  'claude-opus-4-latest': 'claude-opus-4',
  'claude-sonnet-4-20250514': 'claude-sonnet-4',
  'claude-sonnet-4-latest': 'claude-sonnet-4',
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku',
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-mythos-5.1': 'claude-mythos-5-1',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-5',
  'claude-opus-4.1': 'claude-opus-4-1',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
};

/**
 * OpenAI ids that appear as routing tier defaults. Keys match the rows
 * of the OPENAI table above exactly.
 */
export const OPENAI_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.5': { input: 5.0, output: 30.0 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
};

/**
 * Flat lookup: canonical ids plus every alias, ready to spread into a
 * consumer's price table. Optionally prefix keys (e.g. 'anthropic/').
 */
export function anthropicPricingRows(prefix = ''): Record<string, ModelPrice> {
  const rows: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(ANTHROPIC_MODEL_PRICING)) {
    rows[`${prefix}${id}`] = price;
  }
  for (const [alias, target] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
    const price = ANTHROPIC_MODEL_PRICING[target];
    if (price) rows[`${prefix}${alias}`] = price;
  }
  return rows;
}

export function openaiPricingRows(prefix = ''): Record<string, ModelPrice> {
  const rows: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(OPENAI_MODEL_PRICING)) {
    rows[`${prefix}${id}`] = price;
  }
  return rows;
}

/**
 * Resolve a model id (canonical, alias, or provider-prefixed) to a
 * verified price, or undefined when the model is not in the table.
 */
export function lookupVerifiedPrice(model: string): ModelPrice | undefined {
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return (
    ANTHROPIC_MODEL_PRICING[bare] ??
    ANTHROPIC_MODEL_PRICING[ANTHROPIC_MODEL_ALIASES[bare] ?? ''] ??
    OPENAI_MODEL_PRICING[bare]
  );
}
