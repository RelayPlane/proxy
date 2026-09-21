import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveLiveModel,
  resolveDowngradeTarget,
  isStrictlyCheaperModel,
  hasHaikuCapableAnthropicKey,
  complexityRoutingActive,
} from '../src/standalone-proxy.js';
import { CrossProviderCascadeManager } from '../src/cross-provider-cascade.js';
import { computeCacheKey } from '../src/response-cache.js';
import { captureAtom, getOsmosisDb, _resetStore } from '../src/osmosis-store.js';

const EMPTY_POLICY = { version: 1 } as const;

// ── Part 1: always-on complexity routing, routes DOWN with no config ──
describe('always-on routing DOWN (no policy required)', () => {
  it('1a: a simple request routes DOWN to a cheaper model (Opus -> Haiku when key present)', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: 'anthropic/claude-opus-5',
      policy: EMPTY_POLICY,
      taskType: 'general',
      provider: 'anthropic',
      haikuCapable: true,
    });
    expect(out).toBe('claude-haiku-4-5');
    expect(isStrictlyCheaperModel(out, 'claude-opus-5')).toBe(true);
  });

  it('1b: a complex request is NEVER downgraded (stays on the strong model)', () => {
    const out = resolveLiveModel({
      complexity: 'complex',
      candidateModel: 'anthropic/claude-opus-5',
      policy: EMPTY_POLICY,
      taskType: 'general',
      provider: 'anthropic',
      haikuCapable: true,
    });
    expect(out).toBe('anthropic/claude-opus-5');
  });

  it('1b: an elite request is NEVER downgraded', () => {
    const out = resolveLiveModel({
      complexity: 'elite',
      candidateModel: 'anthropic/claude-fable-5-1',
      policy: EMPTY_POLICY,
      taskType: 'general',
      provider: 'anthropic',
      haikuCapable: true,
    });
    expect(out).toBe('anthropic/claude-fable-5-1');
  });

  it('1c: with an EMPTY policy (no default configured) the classifier still routes down', () => {
    // moderate -> Sonnet even though caller named Opus and no policy exists
    const out = resolveLiveModel({
      complexity: 'moderate',
      candidateModel: 'anthropic/claude-opus-5',
      policy: EMPTY_POLICY,
      taskType: 'general',
      provider: 'anthropic',
      haikuCapable: true,
    });
    expect(out).toBe('claude-sonnet-5');
  });

  it('1e: Haiku downgrade only when a supporting key is present; else floors at Sonnet', () => {
    const withKey = resolveDowngradeTarget('simple', 'anthropic', true);
    const withoutKey = resolveDowngradeTarget('simple', 'anthropic', false);
    expect(withKey).toBe('claude-haiku-4-5');
    expect(withoutKey).toBe('claude-sonnet-5');

    // end-to-end through resolveLiveModel on OAuth (no Haiku key): Opus simple -> Sonnet, never Haiku
    const oauthRoute = resolveLiveModel({
      complexity: 'simple',
      candidateModel: 'anthropic/claude-opus-5',
      policy: EMPTY_POLICY,
      taskType: 'general',
      provider: 'anthropic',
      haikuCapable: false,
    });
    expect(oauthRoute).toBe('claude-sonnet-5');
  });

  it('never upgrades: a request already on the cheap tier stays put', () => {
    expect(
      resolveLiveModel({
        complexity: 'simple',
        candidateModel: 'claude-haiku-4-5',
        policy: EMPTY_POLICY,
        taskType: 'general',
        provider: 'anthropic',
        haikuCapable: true,
      }),
    ).toBe('claude-haiku-4-5');
  });

  it('resolveDowngradeTarget returns null for complex/elite (never a downgrade target)', () => {
    expect(resolveDowngradeTarget('complex', 'anthropic', true)).toBeNull();
    expect(resolveDowngradeTarget('elite', 'anthropic', true)).toBeNull();
  });

  it('isStrictlyCheaperModel: known cheaper true, unknown price false', () => {
    expect(isStrictlyCheaperModel('claude-haiku-4-5', 'claude-opus-5')).toBe(true);
    expect(isStrictlyCheaperModel('claude-opus-5', 'claude-haiku-4-5')).toBe(false);
    expect(isStrictlyCheaperModel('totally-unknown-model', 'claude-opus-5')).toBe(false);
  });
});

describe('Haiku-key detection (trap b)', () => {
  const orig = process.env['ANTHROPIC_API_KEY'];
  afterEach(() => {
    if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = orig;
  });

  it('true for a real sk-ant-api key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-abc';
    expect(hasHaikuCapableAnthropicKey()).toBe(true);
  });

  it('false for an OAuth/Max token', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-oat01-abc';
    expect(hasHaikuCapableAnthropicKey()).toBe(false);
  });

  it('reads the auth block from user config', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(hasHaikuCapableAnthropicKey({ auth: { anthropicApiKey: 'sk-ant-api03-xyz' } })).toBe(true);
    expect(hasHaikuCapableAnthropicKey({ auth: { anthropicMaxToken: 'sk-ant-oat01-xyz' } })).toBe(false);
  });
});

describe('complexityRoutingActive', () => {
  it('true when mode is auto/complexity/cascade and complexity.enabled', () => {
    expect(complexityRoutingActive({ routing: { mode: 'complexity', complexity: { enabled: true } } } as never)).toBe(true);
    expect(complexityRoutingActive({ routing: { mode: 'auto', complexity: { enabled: true } } } as never)).toBe(true);
  });
  it('false when routing is off/passthrough or complexity disabled', () => {
    expect(complexityRoutingActive({ routing: { mode: 'passthrough', complexity: { enabled: true } } } as never)).toBe(false);
    expect(complexityRoutingActive({ routing: { mode: 'complexity', complexity: { enabled: false } } } as never)).toBe(false);
    expect(complexityRoutingActive({} as never)).toBe(false);
  });
});

// ── Part 1 trap (a): cache key includes the chosen tier ──
describe('cache identity folds in the complexity tier (trap a)', () => {
  const body = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] };
  it('a complex tag and a simple tag produce different cache keys for the same body', () => {
    const simpleKey = computeCacheKey(body, 'simple');
    const complexKey = computeCacheKey(body, 'complex');
    expect(simpleKey).not.toBe(complexKey);
  });
  it('the same tag is stable', () => {
    expect(computeCacheKey(body, 'complex')).toBe(computeCacheKey(body, 'complex'));
  });
});

// ── Part 2: cross-provider fallback ──
describe('cross-provider fallback on cap/rate-limit', () => {
  function mgr(providers: string[]): CrossProviderCascadeManager {
    const m = new CrossProviderCascadeManager();
    m.configure({ enabled: true, providers });
    return m;
  }

  it('2a: a 429 on the primary falls through to the next eligible provider', async () => {
    const m = mgr(['anthropic', 'openrouter', 'openai']);
    const calls: string[] = [];
    const { result, data } = await m.execute<{ ok: boolean }>(
      'anthropic',
      'claude-opus-5',
      429,
      async (hop) => {
        calls.push(hop.provider);
        if (hop.provider === 'openrouter') return { status: 429, data: { ok: false } };
        return { status: 200, data: { ok: true } };
      },
    );
    expect(result.success).toBe(true);
    expect(result.provider).toBe('openai');
    expect(data?.ok).toBe(true);
    expect(calls).toEqual(['openrouter', 'openai']); // tried in order, stopped at first success
  });

  it('2b: all providers exhausted returns failure (caller returns the original error, no hang)', async () => {
    const m = mgr(['anthropic', 'openrouter']);
    const { result } = await m.execute<{ ok: boolean }>(
      'anthropic',
      'claude-opus-5',
      529,
      async () => ({ status: 503, data: { ok: false } }),
    );
    expect(result.success).toBe(false);
    // primary provider/model preserved so the caller can return the original error
    expect(result.provider).toBe('anthropic');
  });

  it('does not cascade on a non-trigger status (e.g. 400)', () => {
    const m = mgr(['anthropic', 'openrouter']);
    expect(m.shouldCascade(400)).toBe(false);
    expect(m.shouldCascade(429)).toBe(true);
    expect(m.shouldCascade(503)).toBe(true);
    expect(m.shouldCascade(529)).toBe(true);
  });

  it('disabled with a single provider (needs 2+ to be a real fallback)', () => {
    const m = new CrossProviderCascadeManager();
    m.configure({ enabled: true, providers: ['anthropic'] });
    expect(m.enabled).toBe(false);
  });
});

// ── Part 2 (2c): fallback_taken is recorded in osmosis ──
describe('osmosis fallback_taken observability', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-osmosis-test-'));
    vi.stubEnv('RELAYPLANE_HOME_OVERRIDE', tmpHome);
    _resetStore();
  });
  afterEach(() => {
    _resetStore();
    vi.unstubAllEnvs();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('2c: a success served via fallback records fallback_taken=1', () => {
    const db = getOsmosisDb();
    if (!db) return; // better-sqlite3 unavailable in this environment; skip
    captureAtom({ type: 'success', model: 'gpt-5.4', taskType: 'general', latencyMs: 10, inputTokens: 1, outputTokens: 1, timestamp: Date.now(), fallbackTaken: true });
    const row = db.prepare(`SELECT fallback_taken FROM knowledge_atoms WHERE type='success' ORDER BY id DESC LIMIT 1`).get() as { fallback_taken: number | null };
    expect(row.fallback_taken).toBe(1);
  });

  it('an ordinary success (no fallback) leaves fallback_taken NULL', () => {
    const db = getOsmosisDb();
    if (!db) return;
    captureAtom({ type: 'success', model: 'claude-sonnet-5', taskType: 'general', latencyMs: 10, inputTokens: 1, outputTokens: 1, timestamp: Date.now() });
    const row = db.prepare(`SELECT fallback_taken FROM knowledge_atoms WHERE type='success' ORDER BY id DESC LIMIT 1`).get() as { fallback_taken: number | null };
    expect(row.fallback_taken).toBeNull();
  });
});
