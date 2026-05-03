/**
 * Failing tests for save-recommendation feature (Phase 0).
 *
 * Feature: When the proxy routes requests to Opus but the complexity is low
 * (≤ Sonnet threshold), surface a TIP recommendation in the CLI.
 *
 * Acceptance: When the last 10+ proxy requests include Opus calls with average
 * complexity ≤ Sonnet threshold, `relayplane status` displays a TIP line with
 * estimated savings; existing WARNING and ERROR behavior unchanged; unit tests
 * cover the recommendation logic with mock session data.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSaveRecommendation,
  formatSaveRecommendationTip,
  toYamlPatch,
  type SaveRecommendation,
} from '../src/save-recommendation.js';
import type { RoutingLogEntry } from '../src/routing-log.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<RoutingLogEntry> = {}): RoutingLogEntry {
  return {
    ts: new Date().toISOString(),
    requestId: 'req-' + Math.random().toString(36).slice(2),
    agentFingerprint: 'fp_test',
    agentName: 'test-agent',
    taskType: 'code',
    complexity: 'simple',
    resolvedModel: 'anthropic/claude-opus-4-6',
    resolvedBy: 'default_routing',
    candidateModel: null,
    reason: 'default',
    ...overrides,
  };
}

// ─── computeSaveRecommendation ────────────────────────────────────────────────

describe('computeSaveRecommendation — minimum entries', () => {
  it('returns null when fewer than 10 total entries', () => {
    const entries = Array.from({ length: 9 }, () => makeEntry());
    expect(computeSaveRecommendation(entries)).toBeNull();
  });

  it('returns non-null with exactly 10 Opus/simple entries', () => {
    const entries = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    expect(computeSaveRecommendation(entries)).not.toBeNull();
  });
});

describe('computeSaveRecommendation — no Opus calls', () => {
  it('returns null when no Opus requests in window', () => {
    const entries = Array.from({ length: 15 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-sonnet-4-6', complexity: 'simple' })
    );
    expect(computeSaveRecommendation(entries)).toBeNull();
  });

  it('returns null when Opus calls are complex (above threshold)', () => {
    const entries = Array.from({ length: 15 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'complex' })
    );
    expect(computeSaveRecommendation(entries)).toBeNull();
  });
});

describe('computeSaveRecommendation — window slicing', () => {
  it('considers only the last 20 entries', () => {
    // 30 entries total: first 10 are Opus/simple (old), last 20 are Sonnet
    const old = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const recent = Array.from({ length: 20 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-sonnet-4-6', complexity: 'simple' })
    );
    // Last 20 have zero Opus calls → no recommendation
    expect(computeSaveRecommendation([...old, ...recent])).toBeNull();
  });

  it('uses last 20 entries when there are more than 20 entries', () => {
    const old = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-sonnet-4-6', complexity: 'complex' })
    );
    const recent = Array.from({ length: 20 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const result = computeSaveRecommendation([...old, ...recent]);
    expect(result).not.toBeNull();
    expect(result!.windowSize).toBe(20);
  });
});

describe('computeSaveRecommendation — complexity threshold', () => {
  it('returns recommendation when all Opus calls are simple', () => {
    const entries = Array.from({ length: 12 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const result = computeSaveRecommendation(entries);
    expect(result).not.toBeNull();
    expect(result!.avgComplexityScore).toBeLessThan(result!.sonnetThresholdScore);
  });

  it('returns recommendation when Opus calls are moderate (below complex)', () => {
    const entries = Array.from({ length: 12 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'moderate' })
    );
    const result = computeSaveRecommendation(entries);
    expect(result).not.toBeNull();
    expect(result!.avgComplexityScore).toBeLessThan(result!.sonnetThresholdScore);
  });

  it('avgComplexityScore for simple < avgComplexityScore for moderate', () => {
    const simpleEntries = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const moderateEntries = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'moderate' })
    );
    const simpleResult = computeSaveRecommendation(simpleEntries)!;
    const moderateResult = computeSaveRecommendation(moderateEntries)!;
    expect(simpleResult.avgComplexityScore).toBeLessThan(moderateResult.avgComplexityScore);
  });
});

describe('computeSaveRecommendation — result shape', () => {
  it('returns correct opusCount when mixed models', () => {
    const opus = Array.from({ length: 8 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const sonnet = Array.from({ length: 7 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-sonnet-4-6', complexity: 'simple' })
    );
    const result = computeSaveRecommendation([...opus, ...sonnet]);
    expect(result).not.toBeNull();
    expect(result!.opusCount).toBe(8);
  });

  it('estimatedDailySavings is positive when token data is present', () => {
    const entries = Array.from({ length: 12 }, () =>
      makeEntry({
        resolvedModel: 'anthropic/claude-opus-4-6',
        complexity: 'simple',
        inputTokens: 1000,
        outputTokens: 200,
      })
    );
    const result = computeSaveRecommendation(entries);
    expect(result).not.toBeNull();
    expect(result!.estimatedDailySavings).toBeGreaterThan(0);
  });

  it('estimatedDailySavings is 0 when no token data', () => {
    const entries = Array.from({ length: 12 }, () =>
      makeEntry({
        resolvedModel: 'anthropic/claude-opus-4-6',
        complexity: 'simple',
        // No inputTokens / outputTokens
      })
    );
    const result = computeSaveRecommendation(entries);
    expect(result).not.toBeNull();
    expect(result!.estimatedDailySavings).toBe(0);
  });

  it('sonnetThresholdScore is a positive number', () => {
    const entries = Array.from({ length: 10 }, () =>
      makeEntry({ resolvedModel: 'anthropic/claude-opus-4-6', complexity: 'simple' })
    );
    const result = computeSaveRecommendation(entries)!;
    expect(result.sonnetThresholdScore).toBeGreaterThan(0);
  });
});

// ─── formatSaveRecommendationTip ──────────────────────────────────────────────

describe('formatSaveRecommendationTip — format', () => {
  const rec: SaveRecommendation = {
    opusCount: 14,
    avgComplexityScore: 0.3,
    sonnetThresholdScore: 0.4,
    estimatedDailySavings: 3.42,
    windowSize: 20,
  };

  it('starts with TIP:', () => {
    expect(formatSaveRecommendationTip(rec)).toMatch(/^TIP:/);
  });

  it('mentions Opus model name', () => {
    expect(formatSaveRecommendationTip(rec)).toMatch(/[Oo]pus/);
  });

  it('mentions Sonnet as the cheaper route', () => {
    expect(formatSaveRecommendationTip(rec)).toMatch(/[Ss]onnet/);
  });

  it('includes the request count', () => {
    expect(formatSaveRecommendationTip(rec)).toContain('14');
  });

  it('includes avg complexity score', () => {
    expect(formatSaveRecommendationTip(rec)).toContain('0.3');
  });

  it('includes Sonnet threshold score', () => {
    expect(formatSaveRecommendationTip(rec)).toContain('0.4');
  });

  it('includes formatted daily savings with $ and /day', () => {
    expect(formatSaveRecommendationTip(rec)).toMatch(/\$3\.42\/day/);
  });

  it('formats zero savings without /day dollar amount omitted or shown as $0.00', () => {
    const zeroRec: SaveRecommendation = { ...rec, estimatedDailySavings: 0 };
    const tip = formatSaveRecommendationTip(zeroRec);
    expect(tip).toMatch(/^TIP:/);
    // When savings unknown, no $ amount or shows $0.00
    expect(tip).toMatch(/\$0\.00\/day|cheaper route/i);
  });
});

// ─── toYamlPatch ──────────────────────────────────────────────────────────────

describe('toYamlPatch — output format', () => {
  const rec: SaveRecommendation = {
    opusCount: 14,
    avgComplexityScore: 0.3,
    sonnetThresholdScore: 0.4,
    estimatedDailySavings: 3.42,
    windowSize: 20,
  };

  it('returns a string', () => {
    expect(typeof toYamlPatch(rec)).toBe('string');
  });

  it('contains routing: key', () => {
    expect(toYamlPatch(rec)).toMatch(/^routing:/m);
  });

  it('contains default_model set to a sonnet model', () => {
    expect(toYamlPatch(rec)).toMatch(/default_model:\s*claude-sonnet/);
  });

  it('contains routing_mode: complexity', () => {
    expect(toYamlPatch(rec)).toMatch(/routing_mode:\s*complexity/);
  });

  it('includes estimated weekly savings comment', () => {
    // estimatedDailySavings * 7 = 23.94
    const patch = toYamlPatch(rec);
    expect(patch).toMatch(/weekly|savings/i);
    expect(patch).toMatch(/\$23\.9[0-9]/);
  });

  it('includes a safety/reason comment explaining why it is safe', () => {
    const patch = toYamlPatch(rec);
    // Should explain that tasks were classified as simple/moderate
    expect(patch).toMatch(/simple|moderate|safe|complexity/i);
  });

  it('returns non-empty string for recommendation with zero savings', () => {
    const zeroRec: SaveRecommendation = { ...rec, estimatedDailySavings: 0 };
    const patch = toYamlPatch(zeroRec);
    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toMatch(/routing:/);
  });
});
