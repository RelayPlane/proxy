/**
 * Guards the single source of truth for model prices.
 *
 * The doc comment at the top of src/model-pricing.ts carries markdown
 * tables of verified prices. This test parses those tables and fails if
 * any exported constant disagrees with its row, or if a constant has no
 * row. It also checks that the derived tables (telemetry.ts,
 * policy-analyzer.ts) actually consume the source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANTHROPIC_MODEL_PRICING,
  ANTHROPIC_MODEL_ALIASES,
  OPENAI_MODEL_PRICING,
  anthropicPricingRows,
  lookupVerifiedPrice,
  PRICING_VERIFIED_ON,
} from '../src/model-pricing.js';
import { MODEL_PRICING, estimateCost } from '../src/telemetry.js';
import { MODEL_COST_PER_1M } from '../src/policy-analyzer.js';

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/model-pricing.ts'), 'utf-8');

/** Parse `| model | input | output | status |` rows out of the doc comment. */
function parseDocTable(): Map<string, { input: number; output: number; status: string }> {
  const rows = new Map<string, { input: number; output: number; status: string }>();
  const rowRe = /^\s*\*\s*\|\s*([a-z0-9][a-z0-9.\-/]*)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([a-z]+)\s*\|/;
  for (const line of SOURCE.split('\n')) {
    const m = rowRe.exec(line);
    if (m) rows.set(m[1]!, { input: Number(m[2]), output: Number(m[3]), status: m[4]! });
  }
  return rows;
}

describe('model-pricing doc table is the source of truth', () => {
  const doc = parseDocTable();

  it('parses a non-trivial table', () => {
    expect(doc.size).toBeGreaterThanOrEqual(15);
    expect(doc.has('claude-sonnet-5')).toBe(true);
  });

  it('every Anthropic constant matches its doc row', () => {
    for (const [id, price] of Object.entries(ANTHROPIC_MODEL_PRICING)) {
      const row = doc.get(id);
      expect(row, `no doc row for ${id}`).toBeDefined();
      expect(price.input, `${id} input`).toBe(row!.input);
      expect(price.output, `${id} output`).toBe(row!.output);
    }
  });

  it('every OpenAI constant matches its doc row', () => {
    for (const [id, price] of Object.entries(OPENAI_MODEL_PRICING)) {
      const row = doc.get(id);
      expect(row, `no doc row for ${id}`).toBeDefined();
      expect(price.input, `${id} input`).toBe(row!.input);
      expect(price.output, `${id} output`).toBe(row!.output);
    }
  });

  it('every doc row has a constant (no orphan rows)', () => {
    for (const id of doc.keys()) {
      const present = id in ANTHROPIC_MODEL_PRICING || id in OPENAI_MODEL_PRICING;
      expect(present, `doc row ${id} has no constant`).toBe(true);
    }
  });

  it('every alias targets a canonical row', () => {
    for (const [alias, target] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
      expect(ANTHROPIC_MODEL_PRICING[target], `${alias} -> ${target}`).toBeDefined();
    }
  });

  it('carries a verification date and source', () => {
    expect(PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SOURCE).toContain('platform.claude.com/docs/en/about-claude/pricing');
  });
});

describe('verified prices (2026-09-04 audit)', () => {
  it('Sonnet 5 is $2/$10, not the pre-August $3/$15', () => {
    expect(ANTHROPIC_MODEL_PRICING['claude-sonnet-5']).toMatchObject({ input: 2, output: 10 });
  });

  it('current tier defaults are all priced', () => {
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
      expect(lookupVerifiedPrice(id), id).toBeDefined();
    }
  });

  it('Opus 4.5 through 5 are all $5/$25', () => {
    for (const id of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5']) {
      expect(ANTHROPIC_MODEL_PRICING[id]).toMatchObject({ input: 5, output: 25 });
    }
  });

  it('models that do not exist or cannot be verified are excluded', () => {
    expect(lookupVerifiedPrice('claude-haiku-4-6')).toBeUndefined();
    expect(lookupVerifiedPrice('claude-3-7-sonnet')).toBeUndefined();
    expect(lookupVerifiedPrice('claude-3-opus')).toBeUndefined();
  });

  it('resolves provider-prefixed and dotted ids', () => {
    expect(lookupVerifiedPrice('anthropic/claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(lookupVerifiedPrice('claude-opus-4.8')).toMatchObject({ input: 5, output: 25 });
  });
});

describe('derived tables consume the source', () => {
  it('telemetry MODEL_PRICING carries every Anthropic row and alias', () => {
    for (const [id, price] of Object.entries(anthropicPricingRows())) {
      expect(MODEL_PRICING[id], id).toMatchObject({ input: price.input, output: price.output });
    }
    expect(MODEL_PRICING['claude-haiku-4-6']).toBeUndefined();
  });

  it('telemetry MODEL_PRICING carries the verified OpenAI rows', () => {
    expect(MODEL_PRICING['gpt-5.5']).toMatchObject({ input: 5, output: 30 });
    expect(MODEL_PRICING['gpt-5.4']).toMatchObject({ input: 2.5, output: 15 });
  });

  it('policy-analyzer MODEL_COST_PER_1M uses provider-prefixed Anthropic rows', () => {
    for (const [id, price] of Object.entries(anthropicPricingRows('anthropic/'))) {
      expect(MODEL_COST_PER_1M[id], id).toMatchObject({ input: price.input, output: price.output });
    }
    expect(MODEL_COST_PER_1M['anthropic/claude-haiku-4']).toBeUndefined();
  });

  it('estimateCost prices 1M Sonnet 5 tokens at $2 in / $10 out', () => {
    expect(estimateCost('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(2, 6);
    expect(estimateCost('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(10, 6);
  });

  it('estimateCost applies the 0.025x cache-read rate on Fable 5.1', () => {
    // 1M cache-read tokens, nothing else: $10 * 0.025 = $0.25
    expect(estimateCost('claude-fable-5-1', 1_000_000, 0, 0, 1_000_000)).toBeCloseTo(0.25, 6);
    // Opus 5 keeps the standard 0.1x: $5 * 0.1 = $0.50
    expect(estimateCost('claude-opus-5', 1_000_000, 0, 0, 1_000_000)).toBeCloseTo(0.5, 6);
  });
});
