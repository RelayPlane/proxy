/**
 * Tests for the OPTIONAL, KEY-GATED Jev complexity classifier add-on.
 *
 * Guarantees under test:
 *  (a) NO Jev key  -> free heuristic path unchanged, Jev never called.
 *  (b) Jev key present + Jev returns a complexity -> that tier flows through and
 *      becomes part of the cache identity.
 *  (c) Jev present but errors/times out -> falls back to the heuristic (undefined).
 *  (d) The no-key default cache key is byte-for-byte identical to before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  classifyComplexityViaJev,
  type JevComplexity,
} from '../src/classifier/jev_client.js';
import { loadJevConfig } from '../src/classifier/jev_setup.js';
import { classifyComplexityViaAddon } from '../src/standalone-proxy.js';
import { computeCacheKey, computeAggressiveCacheKey } from '../src/response-cache.js';

function makeFetchResponse(status: number, body: unknown, ok?: boolean): Response {
  const isOk = ok !== undefined ? ok : status >= 200 && status < 300;
  return {
    ok: isOk,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// loadJevConfig
// ---------------------------------------------------------------------------

describe('loadJevConfig', () => {
  it('disabled by default when no key is set', () => {
    const cfg = loadJevConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.apiKey).toBeNull();
    expect(cfg.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(cfg.model).toBe('jev-latest');
    expect(cfg.timeoutMs).toBe(500);
  });

  it('enabled and honors overrides when key present, clamps timeout', () => {
    const cfg = loadJevConfig({
      RELAYPLANE_JEV_API_KEY: '  sk-test  ',
      RELAYPLANE_JEV_ENDPOINT: 'https://example.test/v1/systemone',
      RELAYPLANE_JEV_MODEL: 'jev-pinned',
      RELAYPLANE_JEV_TIMEOUT_MS: '5', // clamped up to 50
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe('sk-test'); // trimmed
    expect(cfg.endpoint).toBe('https://example.test/v1/systemone');
    expect(cfg.model).toBe('jev-pinned');
    expect(cfg.timeoutMs).toBe(50);
  });

  it('treats an empty/whitespace key as no key (disabled)', () => {
    expect(loadJevConfig({ RELAYPLANE_JEV_API_KEY: '   ' }).enabled).toBe(false);
    expect(loadJevConfig({ RELAYPLANE_JEV_API_KEY: '' }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyComplexityViaJev
// ---------------------------------------------------------------------------

describe('classifyComplexityViaJev', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const opts = { apiKey: 'sk-test', endpoint: 'https://jev.test/v1/systemone' };

  it('maps a bare string answer to a tier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { answers: { complexity: 'complex' }, usage: {} })));
    const r = await classifyComplexityViaJev({ prompt: 'x' }, opts);
    expect(r).toBe('complex');
  });

  it('maps an object answer via a value field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { answers: { complexity: { value: 'moderate' } } })));
    const r = await classifyComplexityViaJev({ prompt: 'x' }, opts);
    expect(r).toBe('moderate');
  });

  it('maps a scores/distribution answer via argmax', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, {
      answers: { complexity: { scores: { simple: 0.1, moderate: 0.2, complex: 0.7 } } },
    })));
    const r = await classifyComplexityViaJev({ prompt: 'x' }, opts);
    expect(r).toBe('complex');
  });

  it('sends Bearer auth and the jev model in the body', async () => {
    const spy = vi.fn().mockResolvedValue(makeFetchResponse(200, { answers: { complexity: 'simple' } }));
    vi.stubGlobal('fetch', spy);
    await classifyComplexityViaJev({ prompt: 'hello' }, { apiKey: 'sk-abc', endpoint: 'https://jev.test/v1/systemone', model: 'jev-latest' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jev.test/v1/systemone');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-abc');
    const parsed = JSON.parse(init.body as string);
    expect(parsed.model).toBe('jev-latest');
    expect(parsed.state).toBe('hello');
    expect(parsed.questions.complexity.choices).toEqual(['simple', 'moderate', 'complex']);
  });

  it('returns null on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(500, { error: 'x' }, false)));
    expect(await classifyComplexityViaJev({ prompt: 'x' }, opts)).toBeNull();
  });

  it('returns null on missing answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { usage: {} })));
    expect(await classifyComplexityViaJev({ prompt: 'x' }, opts)).toBeNull();
  });

  it('returns null on an unrecognized answer value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { answers: { complexity: 'elite' } })));
    expect(await classifyComplexityViaJev({ prompt: 'x' }, opts)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.reject(new SyntaxError('bad')),
      text: () => Promise.resolve('nope'),
    } as unknown as Response));
    expect(await classifyComplexityViaJev({ prompt: 'x' }, opts)).toBeNull();
  });

  it('returns null on a network error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(classifyComplexityViaJev({ prompt: 'x' }, opts)).resolves.toBeNull();
  });

  it('returns null (never throws) when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })));
    expect(await classifyComplexityViaJev({ prompt: 'x' }, { ...opts, timeoutMs: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyComplexityViaAddon (the wiring gate)
// ---------------------------------------------------------------------------

describe('classifyComplexityViaAddon', () => {
  const KEY = 'RELAYPLANE_JEV_API_KEY';
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    vi.restoreAllMocks();
  });

  const messages = [{ role: 'user', content: 'refactor this module' }];

  it('(a) no key -> returns undefined and never calls fetch', async () => {
    delete process.env[KEY];
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await classifyComplexityViaAddon(messages, noop);
    expect(r).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(b) key present + Jev returns complex -> returns complex', async () => {
    process.env[KEY] = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { answers: { complexity: 'complex' } })));
    const r = await classifyComplexityViaAddon(messages, noop);
    expect(r).toBe('complex');
  });

  it('(c) key present + Jev errors -> falls back to undefined (heuristic)', async () => {
    process.env[KEY] = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const r = await classifyComplexityViaAddon(messages, noop);
    expect(r).toBeUndefined();
  });

  it('key present but no usable prompt -> undefined, no fetch', async () => {
    process.env[KEY] = 'sk-test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await classifyComplexityViaAddon([], noop);
    expect(r).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cache identity: the Jev tier must be part of the key
// ---------------------------------------------------------------------------

describe('cache identity with complexity tag', () => {
  const body = {
    model: 'auto',
    messages: [{ role: 'user', content: 'do the thing' }],
    max_tokens: 100,
  };

  it('(d) no tag == omitting the argument (byte-for-byte, default path unchanged)', () => {
    expect(computeCacheKey(body)).toBe(computeCacheKey(body, undefined));
    expect(computeAggressiveCacheKey(body)).toBe(computeAggressiveCacheKey(body, undefined));
  });

  it('same body, different tier -> different key (no cross-tier poisoning)', () => {
    const simple = computeCacheKey(body, 'simple');
    const complex = computeCacheKey(body, 'complex');
    expect(simple).not.toBe(complex);
    // and a tagged key differs from the untagged default
    expect(simple).not.toBe(computeCacheKey(body));
  });

  it('aggressive mode also folds the tier in', () => {
    expect(computeAggressiveCacheKey(body, 'simple')).not.toBe(computeAggressiveCacheKey(body, 'complex'));
  });

  it('the tag is stable for a fixed tier', () => {
    const a: JevComplexity = 'moderate';
    expect(computeCacheKey(body, a)).toBe(computeCacheKey(body, a));
  });
});
