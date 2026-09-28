/**
 * Elite (Fable) routing is decided by the CONTENT of the current request only,
 * never by its length (Matt, 2026-09-28: "Only on complexity, not length").
 *
 * Before this change a long Claude Code session or a long pasted prompt could
 * reach elite on size alone (session size +3, last-message size +5, "and"
 * count +2), which sent 6% of requests and 35% of spend to Fable. The elite
 * threshold is now a content score, calibrated on 7 days of real proxy
 * traffic to land about 2-3% of requests on elite, and is configurable via
 * routing.complexity.eliteThreshold.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  scoreComplexity,
  stripAmbientContext,
  isContextCompactionRequest,
  getEliteThreshold,
  resolveEliteThreshold,
  DEFAULT_ELITE_THRESHOLD,
  PROVIDER_COMPLEXITY_TIERS,
  resolveFirstRunComplexityTiers,
} from '../src/standalone-proxy.js';
import { lookupVerifiedPrice } from '../src/model-pricing.js';

type Msg = { role: string; content: string };

function session(turns: number, tokensPerTurn: number, last: string): Msg[] {
  const filler = 'x'.repeat(tokensPerTurn * 4);
  const msgs: Msg[] = [];
  for (let i = 0; i < turns; i++) msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: filler });
  msgs.push({ role: 'user', content: last });
  return msgs;
}

// architect (+3) + implement (+2) + analyze (+2) + first...then (+2) = 9
const DENSE_ASK =
  'Architect the new billing service: first analyze the current flow, then implement the ledger.';

// review (+2) + refactor (+2) + code (+2) + create a (+2) = 8, one below the default threshold
const MEDIUM_ASK = 'Review and refactor this function and create a helper, then keep going and ship it and test it.';

describe('elite is content-only', () => {
  it('default threshold is the calibrated value', () => {
    expect(DEFAULT_ELITE_THRESHOLD).toBe(9);
  });

  it('a dense request reaches elite on content alone, in a one-message request', () => {
    expect(scoreComplexity([{ role: 'user', content: DENSE_ASK }]).content).toBeGreaterThanOrEqual(9);
    expect(classifyComplexity([{ role: 'user', content: DENSE_ASK }])).toBe('elite');
  });

  it('session length never promotes a request to elite (was +3 ambient)', () => {
    const msgs = session(120, 1000, MEDIUM_ASK);
    expect(scoreComplexity(msgs).content).toBeLessThan(9);
    expect(classifyComplexity(msgs)).toBe('complex');
  });

  it('a huge last message below the content threshold is complex, not elite (was +5 size, +2 "and")', () => {
    const big = MEDIUM_ASK + ' ' + 'the payload and the schema and the notes. '.repeat(600);
    const msgs = session(40, 3000, big);
    const s = scoreComplexity(msgs);
    // Under the old rule this total alone (>= 16) meant elite.
    expect(s.total).toBeGreaterThanOrEqual(16);
    expect(s.content).toBeLessThan(9);
    expect(classifyComplexity(msgs)).toBe('complex');
  });

  it('size still informs the non-elite tiers', () => {
    const plain = 'please continue with the next item on the list';
    expect(classifyComplexity([{ role: 'user', content: plain }])).toBe('simple');
    // +1 last-message size, +2 session size, +1 long session
    const grown = session(30, 4000, plain + ' ' + 'more notes. '.repeat(250));
    expect(['moderate', 'complex']).toContain(classifyComplexity(grown));
  });

  it('harness <system-reminder> context (CLAUDE.md, skill listings) does not count as request content', () => {
    const boilerplate =
      '<system-reminder>\n# CLAUDE.md\nArchitect and implement distributed infrastructure. First analyze, ' +
      'then refactor. Calculate and evaluate the strategy. Create a roadmap. const x = 1; import y;\n' +
      'more guidance '.repeat(2000) +
      '\n</system-reminder>';
    const text = boilerplate + '\nwhat time is it in Berlin?';
    expect(stripAmbientContext(text)).not.toContain('Architect');
    expect(scoreComplexity([{ role: 'user', content: text }]).content).toBe(0);
    expect(classifyComplexity([{ role: 'user', content: text }])).not.toBe('elite');
  });

  it('a real dense ask next to system-reminder context is still elite', () => {
    const text = '<system-reminder>\nnothing relevant\n</system-reminder>\n' + DENSE_ASK;
    expect(classifyComplexity([{ role: 'user', content: text }])).toBe('elite');
  });

  it('context-compaction (summarize the session) turns are never elite', () => {
    const compaction =
      'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
      'Your task is to create a detailed summary of the conversation so far, paying close attention to ' +
      "the user's explicit requests. Chronologically analyze each message, capture code patterns and " +
      'architectural decisions, full code snippets, function signatures. First list the files, then the errors.';
    expect(isContextCompactionRequest(compaction)).toBe(true);
    expect(scoreComplexity([{ role: 'user', content: compaction }]).content).toBe(0);
    expect(classifyComplexity([{ role: 'user', content: compaction }])).not.toBe('elite');
  });

  it('only the last user message counts; tool-result-only turns score zero content', () => {
    const msgs = [
      { role: 'user', content: DENSE_ASK },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: DENSE_ASK }] },
    ];
    expect(scoreComplexity(msgs).content).toBe(0);
    expect(classifyComplexity(msgs)).not.toBe('elite');
  });
});

describe('routing.complexity.eliteThreshold', () => {
  it('a higher threshold keeps the dense ask at complex', () => {
    expect(classifyComplexity([{ role: 'user', content: DENSE_ASK }], { eliteThreshold: 12 })).toBe('complex');
  });

  it('a lower threshold promotes the medium ask', () => {
    expect(classifyComplexity([{ role: 'user', content: MEDIUM_ASK }], { eliteThreshold: 8 })).toBe('elite');
  });

  it('getEliteThreshold reads the config and falls back to the default on junk', () => {
    expect(getEliteThreshold({ routing: { complexity: { eliteThreshold: 11 } } })).toBe(11);
    expect(getEliteThreshold({ routing: { complexity: {} } })).toBe(DEFAULT_ELITE_THRESHOLD);
    expect(getEliteThreshold(undefined)).toBe(DEFAULT_ELITE_THRESHOLD);
    expect(resolveEliteThreshold('12')).toBe(DEFAULT_ELITE_THRESHOLD);
    expect(resolveEliteThreshold(0)).toBe(DEFAULT_ELITE_THRESHOLD);
    expect(resolveEliteThreshold(Number.NaN)).toBe(DEFAULT_ELITE_THRESHOLD);
  });
});

describe('tier defaults are the latest model ids', () => {
  it('anthropic ladder: haiku 4.5 / sonnet 5.5 / opus 5.5 / fable 5.1', () => {
    const t = PROVIDER_COMPLEXITY_TIERS['anthropic']!;
    expect(t.simple.model).toBe('claude-haiku-4-5-20251001');
    expect(t.moderate.model).toBe('claude-sonnet-5-5');
    expect(t.complex.model).toBe('claude-opus-5-5');
    expect(t.elite.model).toBe('claude-fable-5-1');
  });

  it('openrouter elite uses a real OpenRouter id', () => {
    expect(PROVIDER_COMPLEXITY_TIERS['openrouter']!.elite.model).toBe('anthropic/claude-fable-5.1');
  });

  it('first-run tiers (API key) use the latest ids', () => {
    const prev = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api-test';
    try {
      expect(resolveFirstRunComplexityTiers(['anthropic'])).toEqual({
        simple: 'claude-haiku-4-5-20251001',
        moderate: 'claude-sonnet-5-5',
        complex: 'claude-opus-5-5',
        elite: 'claude-fable-5-1',
      });
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });

  it('pricing: fable 5.1 $10/$50, opus 5.5 $4/$20, sonnet 5.5 $2/$10, dated haiku 4.5 $1/$5', () => {
    expect(lookupVerifiedPrice('claude-fable-5-1')).toMatchObject({ input: 10, output: 50 });
    expect(lookupVerifiedPrice('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(lookupVerifiedPrice('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
    expect(lookupVerifiedPrice('claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5 });
  });
});
