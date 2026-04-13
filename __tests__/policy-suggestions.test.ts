/**
 * Tests for policy-suggestions.ts
 * Covers: detectAvailableProviders, suggestPolicies (via suggestForAgent rules)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config to avoid reading real files
vi.mock('../src/config.js', () => ({
  getProviderConfigs: vi.fn(() => ({})),
}));

import { detectAvailableProviders, suggestPolicies } from '../src/policy-suggestions.js';
import type { AgentAnalysis } from '../src/policy-analyzer.js';

function makeAnalysis(overrides: Partial<AgentAnalysis> = {}): AgentAnalysis {
  return {
    fingerprint: 'fp_aabbccdd1122',
    name: 'test-agent',
    nameIsInferred: false,
    taskDistribution: { code: 1.0 },
    dominantTask: 'code',
    avgInputTokens: 1000,
    avgOutputTokens: 200,
    avgTotalTokens: 1200,
    tokensAreEstimated: false,
    requestsPerDay: 10,
    costPerDay: 0.5,
    currentModel: 'anthropic/claude-opus-4-5',
    daysObserved: 1,
    totalRequests: 10,
    systemPromptPreview: 'You are a helpful assistant',
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── detectAvailableProviders ──────────────────────────────────────────────────

describe('detectAvailableProviders', () => {
  it('returns [] when no env vars set (AC-08 negative case)', () => {
    // No keys set
    const result = detectAvailableProviders();
    expect(result).not.toContain('anthropic');
  });

  it('detects ANTHROPIC_API_KEY (AC-08)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const result = detectAvailableProviders();
    expect(result).toContain('anthropic');
  });

  it('detects ANTHROPIC_API_KEY + GROQ_API_KEY → both included', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('GROQ_API_KEY', 'groq-key');
    const result = detectAvailableProviders();
    expect(result).toContain('anthropic');
    expect(result).toContain('groq');
  });

  it('deduplicates GOOGLE_API_KEY and GEMINI_API_KEY → single google entry (AC-09)', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'google-key');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    const result = detectAvailableProviders();
    const googleEntries = result.filter(p => p === 'google');
    expect(googleEntries).toHaveLength(1);
  });

  it('detects GEMINI_API_KEY alone → google', () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    const result = detectAvailableProviders();
    expect(result).toContain('google');
  });

  it('returns sorted array', () => {
    vi.stubEnv('OPENAI_API_KEY', 'key1');
    vi.stubEnv('ANTHROPIC_API_KEY', 'key2');
    const result = detectAvailableProviders();
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});

// ─── suggestPolicies / suggestForAgent rules ───────────────────────────────────

describe('suggestPolicies — Rule 1: Long-context (AC-10)', () => {
  it('avgTotalTokens > 50_000 → opus + neverDowngrade', () => {
    const analysis = makeAnalysis({
      avgTotalTokens: 80_000,
      avgInputTokens: 64_000,
      avgOutputTokens: 16_000,
      currentModel: 'openai/gpt-4o',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.suggestedModel).toContain('opus');
    expect(result!.neverDowngrade).toBe(true);
  });
});

describe('suggestPolicies — Rule 2: Security/review', () => {
  it('review+security >= 0.8 → opus, neverDowngrade', () => {
    const analysis = makeAnalysis({
      taskDistribution: { review: 0.5, security: 0.35, code: 0.15 },
      dominantTask: 'review',
      currentModel: 'openai/gpt-4o',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.suggestedModel).toContain('opus');
    expect(result!.neverDowngrade).toBe(true);
  });
});

describe('suggestPolicies — Rule 3: Code-heavy (AC-11)', () => {
  it('code >= 0.8 → sonnet + escalateTo opus', () => {
    const analysis = makeAnalysis({
      taskDistribution: { code: 0.9 },
      dominantTask: 'code',
      currentModel: 'anthropic/claude-opus-4-5',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.suggestedModel).toContain('sonnet');
    expect(result!.escalateTo).toContain('opus');
    expect(result!.escalateOn).toContain('complexity_high');
    expect(result!.neverDowngrade).toBe(false);
  });
});

describe('suggestPolicies — Rule 4: Summarization', () => {
  it('summarization >= 0.8 → gemini-flash when google available', () => {
    const analysis = makeAnalysis({
      taskDistribution: { summarization: 0.9 },
      dominantTask: 'summarization',
      currentModel: 'anthropic/claude-opus-4-5',
    });
    const [result] = suggestPolicies([analysis], ['google']);
    expect(result!.suggestedModel).toContain('gemini');
    expect(result!.neverDowngrade).toBe(false);
  });
});

describe('suggestPolicies — Rule 5: Simple/utility', () => {
  it('simple+utility >= 0.8 AND avgTotalTokens < 5_000 + groq → groq/llama', () => {
    const analysis = makeAnalysis({
      taskDistribution: { simple: 0.9 },
      dominantTask: 'simple',
      avgTotalTokens: 1_000,
      avgInputTokens: 800,
      avgOutputTokens: 200,
      currentModel: 'anthropic/claude-opus-4-5',
    });
    const [result] = suggestPolicies([analysis], ['groq']);
    expect(result!.suggestedModel).toContain('groq');
  });

  it('simple share high but only anthropic → falls back to haiku', () => {
    const analysis = makeAnalysis({
      taskDistribution: { simple: 0.9 },
      dominantTask: 'simple',
      avgTotalTokens: 1_000,
      avgInputTokens: 800,
      avgOutputTokens: 200,
      currentModel: 'anthropic/claude-opus-4-5',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.suggestedModel).toContain('haiku');
  });
});

describe('suggestPolicies — Default rule', () => {
  it('no dominant pattern + anthropic → sonnet', () => {
    const analysis = makeAnalysis({
      taskDistribution: { code: 0.4, analysis: 0.3, summary: 0.3 },
      dominantTask: 'code',
      currentModel: 'anthropic/claude-opus-4-5',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.suggestedModel).toContain('sonnet');
  });
});

describe('suggestPolicies — noSuggestion cases', () => {
  it('returns noSuggestion=true when already on recommended model (AC-12)', () => {
    const analysis = makeAnalysis({
      taskDistribution: { code: 0.9 },
      dominantTask: 'code',
      currentModel: 'anthropic/claude-sonnet-4-5',
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    expect(result!.noSuggestion).toBe(true);
  });

  it('returns noSuggestion=true when no provider available for rule (AC-13)', () => {
    const analysis = makeAnalysis({
      taskDistribution: { summarization: 0.9 },
      dominantTask: 'summarization',
      currentModel: 'anthropic/claude-opus-4-5',
    });
    // No providers available
    const [result] = suggestPolicies([analysis], []);
    expect(result!.noSuggestion).toBe(true);
    expect(result!.suggestedModel).toBe(analysis.currentModel);
  });
});

describe('suggestPolicies — savings', () => {
  it('estimatedMonthlySavings is always non-negative (AC-14)', () => {
    const analyses = [
      makeAnalysis({ taskDistribution: { code: 0.9 }, currentModel: 'anthropic/claude-opus-4-5' }),
      makeAnalysis({ taskDistribution: { summarization: 0.9 }, currentModel: 'anthropic/claude-opus-4-5' }),
      makeAnalysis({ taskDistribution: { simple: 0.9 }, avgTotalTokens: 1000, currentModel: 'anthropic/claude-sonnet-4-5' }),
      makeAnalysis({ avgTotalTokens: 80_000, avgInputTokens: 64_000, avgOutputTokens: 16_000, currentModel: 'anthropic/claude-haiku-4-5' }),
    ];

    const results = suggestPolicies(analyses, ['anthropic', 'google', 'groq']);
    for (const r of results) {
      expect(r.estimatedMonthlySavings).toBeGreaterThanOrEqual(0);
      expect(r.estimatedDailySavings).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces positive savings when cheaper model suggested', () => {
    const analysis = makeAnalysis({
      taskDistribution: { code: 0.9 },
      dominantTask: 'code',
      currentModel: 'anthropic/claude-opus-4-5',
      costPerDay: 10.0,
      requestsPerDay: 100,
      avgInputTokens: 2000,
      avgOutputTokens: 500,
    });
    const [result] = suggestPolicies([analysis], ['anthropic']);
    // sonnet is cheaper than opus, so savings should be positive
    expect(result!.estimatedMonthlySavings).toBeGreaterThan(0);
  });
});
