/**
 * Tests for policy-analyzer.ts
 * Covers: inferAgentName, analyzeTraffic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { TEST_HOME } = vi.hoisted(() => {
  const tmpBase = require('node:os').tmpdir();
  const TEST_HOME = require('node:path').join(
    tmpBase,
    `rp-analyzer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return { TEST_HOME };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// Mock agent-tracker so analyzeTraffic can use a controlled registry
vi.mock('../src/agent-tracker.js', () => ({
  getAgentRegistry: vi.fn(() => ({})),
}));

import { inferAgentName, analyzeTraffic } from '../src/policy-analyzer.js';
import { getAgentRegistry } from '../src/agent-tracker.js';

const LOG_DIR = path.join(TEST_HOME, '.relayplane');
const LOG_FILE = path.join(LOG_DIR, 'routing-log.jsonl');

function makeEntry(
  overrides: Partial<{
    ts: string;
    agentFingerprint: string;
    taskType: string;
    resolvedModel: string;
    inputTokens: number;
    outputTokens: number;
    requestId: string;
  }>,
) {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    requestId: overrides.requestId ?? `req-${Math.random().toString(36).slice(2)}`,
    agentFingerprint: overrides.agentFingerprint ?? 'fp_aabbccdd1122',
    agentName: null,
    taskType: overrides.taskType ?? 'code',
    complexity: 'moderate',
    resolvedModel: overrides.resolvedModel ?? 'anthropic/claude-sonnet-4-5',
    resolvedBy: 'passthrough' as const,
    candidateModel: null,
    reason: 'test',
    ...(overrides.inputTokens !== undefined && { inputTokens: overrides.inputTokens }),
    ...(overrides.outputTokens !== undefined && { outputTokens: overrides.outputTokens }),
  };
}

function writeLog(entries: ReturnType<typeof makeEntry>[]) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

beforeEach(() => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  vi.mocked(getAgentRegistry).mockReturnValue({});
});

afterEach(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── inferAgentName ───────────────────────────────────────────────────────────

describe('inferAgentName', () => {
  it('matches "You are a code reviewer" → code-reviewer', () => {
    expect(inferAgentName('You are a code reviewer.', {})).toBe('code-reviewer');
  });

  it('matches "You are Claude, an AI assistant" → claude', () => {
    expect(inferAgentName('You are Claude, an AI assistant', {})).toBe('claude');
  });

  it('matches "You are a [role]" pattern — slugifies role phrase (AC-06)', () => {
    // The regex captures the full noun phrase after "You are a/an"
    // "You are a code reviewer" → captures "code reviewer" → slugify → "code-reviewer"
    expect(inferAgentName('You are a code reviewer.', {})).toBe('code-reviewer');
    // Multi-word: "senior code reviewer" → slugify entire capture
    expect(inferAgentName('You are a senior code reviewer.', {})).toBe('senior-code-reviewer');
  });

  it('matches "Your job is to summarize documents" → summarize-agent', () => {
    expect(inferAgentName('Your job is to summarize documents.', {})).toBe('summarize-agent');
  });

  it('matches "As a research assistant" → research', () => {
    expect(inferAgentName('As a research assistant, help me.', {})).toBe('research');
  });

  it('falls back to dominant task when no pattern matches (code)', () => {
    expect(inferAgentName('Answer questions helpfully.', { code: 0.9 })).toBe('code-agent');
  });

  it('falls back to dominant task when no pattern matches (analysis) (AC-07)', () => {
    expect(inferAgentName('Answer questions helpfully.', { analysis: 0.8 })).toBe('analysis-agent');
  });

  it('falls back to unknown-agent when no pattern and no distribution', () => {
    expect(inferAgentName('', {})).toBe('unknown-agent');
  });
});

// ─── analyzeTraffic ───────────────────────────────────────────────────────────

describe('analyzeTraffic', () => {
  it('returns [] when LOG_FILE does not exist (AC-02)', async () => {
    // LOG_DIR exists but LOG_FILE does not
    const result = await analyzeTraffic();
    expect(result).toEqual([]);
  });

  it('returns [] when LOG_FILE has no parseable entries', async () => {
    writeLog([]);
    const result = await analyzeTraffic();
    expect(result).toEqual([]);
  });

  it('correctly computes taskDistribution and dominantTask (AC-03)', async () => {
    const fp = 'fp_aabbccdd1122';
    const entries = [
      ...Array(6).fill(null).map(() => makeEntry({ agentFingerprint: fp, taskType: 'code' })),
      ...Array(2).fill(null).map(() => makeEntry({ agentFingerprint: fp, taskType: 'analysis' })),
    ];
    writeLog(entries);

    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result).toHaveLength(1);
    const a = result[0]!;
    expect(a.taskDistribution['code']).toBeCloseTo(0.75);
    expect(a.taskDistribution['analysis']).toBeCloseTo(0.25);
    expect(a.dominantTask).toBe('code');
  });

  it('sets tokensAreEstimated=true when no token fields present (AC-04)', async () => {
    writeLog([makeEntry({}), makeEntry({})]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result[0]?.tokensAreEstimated).toBe(true);
  });

  it('sets tokensAreEstimated=false when token fields are present', async () => {
    writeLog([
      makeEntry({ inputTokens: 1000, outputTokens: 200 }),
      makeEntry({ inputTokens: 2000, outputTokens: 400 }),
    ]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result[0]?.tokensAreEstimated).toBe(false);
    expect(result[0]?.avgInputTokens).toBe(1500);
    expect(result[0]?.avgOutputTokens).toBe(300);
  });

  it('respects lookbackDays filter (AC-05)', async () => {
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    const entries = [
      makeEntry({ ts: recent, agentFingerprint: 'fp_aabbccdd1122' }),
      makeEntry({ ts: recent, agentFingerprint: 'fp_aabbccdd1122' }),
      makeEntry({ ts: old, agentFingerprint: 'fp_aabbccdd1133' }),
      makeEntry({ ts: old, agentFingerprint: 'fp_aabbccdd1133' }),
      makeEntry({ ts: old, agentFingerprint: 'fp_aabbccdd1133' }),
    ];
    writeLog(entries);

    const result = await analyzeTraffic({ lookbackDays: 3 });
    // Only the 2 recent entries (one fingerprint) should be processed
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe('fp_aabbccdd1122');
  });

  it('sorts by costPerDay descending', async () => {
    const fp1 = 'fp_aabbccdd1111';
    const fp2 = 'fp_aabbccdd2222';
    const fp3 = 'fp_aabbccdd3333';

    vi.mocked(getAgentRegistry).mockReturnValue({
      [fp1]: {
        name: 'Agent 1', fingerprint: fp1, totalRequests: 10, totalCost: 1.0,
        firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
        lastSeen: new Date().toISOString(),
        systemPromptPreview: '',
        lastModel: 'anthropic/claude-sonnet-4-5',
      },
      [fp2]: {
        name: 'Agent 2', fingerprint: fp2, totalRequests: 10, totalCost: 5.0,
        firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
        lastSeen: new Date().toISOString(),
        systemPromptPreview: '',
        lastModel: 'anthropic/claude-opus-4-5',
      },
      [fp3]: {
        name: 'Agent 3', fingerprint: fp3, totalRequests: 10, totalCost: 2.0,
        firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
        lastSeen: new Date().toISOString(),
        systemPromptPreview: '',
        lastModel: 'anthropic/claude-haiku-4-5',
      },
    } as any);

    writeLog([
      makeEntry({ agentFingerprint: fp1 }),
      makeEntry({ agentFingerprint: fp2 }),
      makeEntry({ agentFingerprint: fp3 }),
    ]);

    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result).toHaveLength(3);
    expect(result[0]!.fingerprint).toBe(fp2);
    expect(result[1]!.fingerprint).toBe(fp3);
    expect(result[2]!.fingerprint).toBe(fp1);
  });

  it('uses registry name when user-renamed (not default Agent N)', async () => {
    const fp = 'fp_aabbccdd1122';
    vi.mocked(getAgentRegistry).mockReturnValue({
      [fp]: {
        name: 'my-coder',
        fingerprint: fp,
        totalRequests: 5,
        totalCost: 0.5,
        firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
        lastSeen: new Date().toISOString(),
        systemPromptPreview: 'You are a helpful assistant',
        lastModel: 'anthropic/claude-sonnet-4-5',
      },
    } as any);

    writeLog([makeEntry({ agentFingerprint: fp })]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result[0]!.name).toBe('my-coder');
    expect(result[0]!.nameIsInferred).toBe(false);
  });

  it('infers name when registry uses default "Agent N" pattern', async () => {
    const fp = 'fp_aabbccdd1122';
    vi.mocked(getAgentRegistry).mockReturnValue({
      [fp]: {
        name: 'Agent 1',
        fingerprint: fp,
        totalRequests: 5,
        totalCost: 0.5,
        firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
        lastSeen: new Date().toISOString(),
        systemPromptPreview: 'You are a code reviewer',
        lastModel: 'anthropic/claude-sonnet-4-5',
      },
    } as any);

    writeLog([makeEntry({ agentFingerprint: fp })]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result[0]!.nameIsInferred).toBe(true);
    expect(result[0]!.name).toBe('code-reviewer');
  });

  it('skips null fingerprint entries', async () => {
    writeLog([
      { ...makeEntry({}), agentFingerprint: null as any },
      { ...makeEntry({}), agentFingerprint: null as any },
    ]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result).toEqual([]);
  });

  it('skips corrupt JSON lines', async () => {
    const fp = 'fp_aabbccdd1122';
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(
      LOG_FILE,
      [
        JSON.stringify(makeEntry({ agentFingerprint: fp })),
        'CORRUPT LINE {{{',
        JSON.stringify(makeEntry({ agentFingerprint: fp })),
      ].join('\n') + '\n',
      'utf-8',
    );

    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe(fp);
  });

  it('includes fingerprint not in agents.json (uses log data, costPerDay 0)', async () => {
    const fp = 'fp_notinregistry1';
    writeLog([makeEntry({ agentFingerprint: fp }), makeEntry({ agentFingerprint: fp })]);
    const result = await analyzeTraffic({ lookbackDays: 7 });
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe(fp);
    expect(result[0]!.costPerDay).toBe(0);
    expect(result[0]!.nameIsInferred).toBe(true);
  });
});
