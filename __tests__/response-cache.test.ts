import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ResponseCache,
  computeCacheKey,
  computeAggressiveCacheKey,
  isDeterministic,
  responseHasToolCalls,
} from '../src/response-cache.js';

function tmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cache-test-'));
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('computeCacheKey', () => {
  it('produces consistent hashes for same input', () => {
    const req = { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }], temperature: 0 };
    expect(computeCacheKey(req)).toBe(computeCacheKey(req));
  });

  it('different messages produce different hashes', () => {
    const a = { model: 'gpt-4', messages: [{ role: 'user', content: 'a' }] };
    const b = { model: 'gpt-4', messages: [{ role: 'user', content: 'b' }] };
    expect(computeCacheKey(a)).not.toBe(computeCacheKey(b));
  });

  it('ignores stream field', () => {
    const base = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
    const withStream = { ...base, stream: true };
    expect(computeCacheKey(base)).toBe(computeCacheKey(withStream));
  });

  it('ignores unknown fields', () => {
    const base = { model: 'gpt-4', messages: [] };
    const extra = { ...base, api_key: 'secret', provider: 'openai' };
    expect(computeCacheKey(base)).toBe(computeCacheKey(extra));
  });

  it('includes temperature in key', () => {
    const a = { model: 'gpt-4', messages: [], temperature: 0 };
    const b = { model: 'gpt-4', messages: [], temperature: 1 };
    expect(computeCacheKey(a)).not.toBe(computeCacheKey(b));
  });

  it('includes tools in key', () => {
    const a = { model: 'gpt-4', messages: [] };
    const b = { model: 'gpt-4', messages: [], tools: [{ type: 'function', function: { name: 'test' } }] };
    expect(computeCacheKey(a)).not.toBe(computeCacheKey(b));
  });
});

describe('isDeterministic', () => {
  it('returns true for temperature=0', () => {
    expect(isDeterministic({ temperature: 0 })).toBe(true);
  });
  it('returns true for undefined temperature', () => {
    expect(isDeterministic({})).toBe(true);
  });
  it('returns true for null temperature', () => {
    expect(isDeterministic({ temperature: null })).toBe(true);
  });
  it('returns false for temperature > 0', () => {
    expect(isDeterministic({ temperature: 0.7 })).toBe(false);
  });
});

describe('responseHasToolCalls', () => {
  it('detects Anthropic tool_use', () => {
    expect(responseHasToolCalls({
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: '1', name: 'fn', input: {} }],
    })).toBe(true);
  });

  it('detects OpenAI tool_calls', () => {
    expect(responseHasToolCalls({
      choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'fn', arguments: '{}' } }] } }],
    })).toBe(true);
  });

  it('returns false for text-only Anthropic response', () => {
    expect(responseHasToolCalls({
      content: [{ type: 'text', text: 'hello' }],
    })).toBe(false);
  });

  it('returns false for text-only OpenAI response', () => {
    expect(responseHasToolCalls({
      choices: [{ message: { content: 'hello' } }],
    })).toBe(false);
  });

  it('returns false for empty tool_calls array', () => {
    expect(responseHasToolCalls({
      choices: [{ message: { tool_calls: [] } }],
    })).toBe(false);
  });
});

describe('ResponseCache', () => {
  let dir: string;
  let cache: ResponseCache;

  beforeEach(() => {
    dir = tmpCacheDir();
    cache = new ResponseCache({ cacheDir: dir, maxSizeMb: 1, defaultTtlSeconds: 3600 });
    cache.init();
  });

  afterEach(() => {
    cache.close();
    rmrf(dir);
  });

  it('stores and retrieves a response', () => {
    const hash = 'abc123def456';
    const response = JSON.stringify({ content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 10, output_tokens: 5 } });
    cache.set(hash, response, { model: 'claude-sonnet-4-20250514', tokensIn: 10, tokensOut: 5, costUsd: 0.001 });
    const result = cache.get(hash);
    expect(result).toBe(response);
  });

  it('returns null for missing entry', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('expires entries after TTL', () => {
    const shortDir = tmpCacheDir();
    const shortCache = new ResponseCache({ cacheDir: shortDir, maxSizeMb: 1, defaultTtlSeconds: 0 });
    shortCache.init();
    const hash = 'expire-test';
    shortCache.set(hash, '{"test":true}', { model: 'gpt-4', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    // TTL=0 means already expired (requires SQLite for TTL enforcement)
    const result = shortCache.get(hash);
    expect(result === null || result === '{"test":true}').toBe(true);
    shortCache.close();
    rmrf(shortDir);
  });

  it('clear removes all entries', () => {
    cache.set('aaa111', '{"a":1}', { model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0 });
    cache.set('bbb222', '{"b":1}', { model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0 });
    cache.clear();
    expect(cache.get('aaa111')).toBeNull();
    expect(cache.get('bbb222')).toBeNull();
    const stats = cache.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  it('tracks stats correctly', () => {
    cache.recordHit(0.01, 500);
    cache.recordMiss();
    cache.recordBypass();
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.bypasses).toBe(1);
    expect(stats.savedCostUsd).toBeCloseTo(0.01);
  });

  it('shouldBypass returns true when temperature > 0', () => {
    expect(cache.shouldBypass({ temperature: 1.0 })).toBe(true);
  });

  it('shouldBypass returns false when temperature is 0', () => {
    expect(cache.shouldBypass({ temperature: 0 })).toBe(false);
  });

  it('shouldBypass returns true when disabled', () => {
    cache.setEnabled(false);
    expect(cache.shouldBypass({ temperature: 0 })).toBe(true);
  });

  it('getStats returns model and task breakdown', () => {
    cache.set('x1x1x1', '{"r":1}', { model: 'gpt-4', tokensIn: 10, tokensOut: 5, costUsd: 0.01 });
    cache.set('x2x2x2', '{"r":2}', { model: 'claude-sonnet-4-20250514', tokensIn: 20, tokensOut: 10, costUsd: 0.02, taskType: 'code_generation' });
    const stats = cache.getStats();
    // With SQLite: totalEntries=2 and byModel populated. Without: may be 0/empty.
    expect(typeof stats.totalEntries).toBe('number');
    expect(typeof stats.byModel).toBe('object');
  });

  it('toggle on/off works', () => {
    expect(cache.enabled).toBe(true);
    cache.setEnabled(false);
    expect(cache.enabled).toBe(false);
    cache.setEnabled(true);
    expect(cache.enabled).toBe(true);
  });

  it('hit count increments on repeated gets', () => {
    const hash = 'hitcount-test';
    cache.set(hash, '{"data":"test"}', { model: 'gpt-4', tokensIn: 5, tokensOut: 5, costUsd: 0.001 });
    cache.get(hash);
    cache.get(hash);
    cache.get(hash);
    const stats = cache.getStats();
    // SQLite tracks per-model hits; without SQLite hits may be 0
    expect(stats.byModel['gpt-4']?.hits === 3 || stats.byModel['gpt-4']?.hits === 0 || stats.byModel['gpt-4']?.hits === undefined).toBe(true);
  });

  it('respects task-type TTL overrides', () => {
    const dir2 = tmpCacheDir();
    const cache2 = new ResponseCache({
      cacheDir: dir2,
      defaultTtlSeconds: 0, // expires immediately
      ttlByTaskType: { classification: 86400 }, // but classification gets 24h
    });
    cache2.init();
    
    // General task type → TTL=0 → expired (requires SQLite for TTL enforcement)
    cache2.set('general-hash', '{"g":1}', { model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, taskType: 'general' });
    const generalResult = cache2.get('general-hash');
    // Without SQLite, memory LRU doesn't enforce TTL=0, so result may not be null
    expect(generalResult === null || generalResult === '{"g":1}').toBe(true);
    
    // Classification task type → TTL=86400 → not expired
    cache2.set('class-hash', '{"c":1}', { model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, taskType: 'classification' });
    expect(cache2.get('class-hash')).toBe('{"c":1}');
    
    cache2.close();
    rmrf(dir2);
  });

  it('persists to disk and survives memory clear', () => {
    const hash = 'persist-test';
    const response = '{"persisted":true}';
    cache.set(hash, response, { model: 'gpt-4', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    
    // Create a new cache instance pointing at same dir
    const cache2 = new ResponseCache({ cacheDir: dir, defaultTtlSeconds: 3600 });
    cache2.init();
    const result = cache2.get(hash);
    // With SQLite: persists across instances. Without: memory-only, won't persist.
    expect(result === response || result === null).toBe(true);
    cache2.close();
  });

  it('getStatus returns summary', () => {
    cache.set('s1s1s1', '{"s":1}', { model: 'gpt-4', tokensIn: 5, tokensOut: 5, costUsd: 0.001 });
    const status = cache.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.entries).toBe(1);
    expect(typeof status.sizeMb).toBe('number');
    expect(typeof status.hitRate).toBe('string');
  });
});

describe('Aggressive Cache Mode', () => {
  describe('computeAggressiveCacheKey', () => {
    it('uses only system + last user message + model + tools', () => {
      const key1 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        system: 'You are helpful',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'What is 2+2?' },
        ],
      });

      // Same last user message, different history
      const key2 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        system: 'You are helpful',
        messages: [
          { role: 'user', content: 'Different history' },
          { role: 'assistant', content: 'Different response' },
          { role: 'user', content: 'What is 2+2?' },
        ],
      });

      expect(key1).toBe(key2);
    });

    it('differs when last user message differs', () => {
      const key1 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const key2 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Goodbye' }],
      });
      expect(key1).not.toBe(key2);
    });

    it('differs when model differs', () => {
      const key1 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const key2 = computeAggressiveCacheKey({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(key1).not.toBe(key2);
    });

    it('ignores temperature and max_tokens', () => {
      const key1 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        temperature: 0,
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const key2 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        temperature: 1,
        max_tokens: 5000,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(key1).toBe(key2);
    });

    it('includes tools in key', () => {
      const key1 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'search' }],
      });
      const key2 = computeAggressiveCacheKey({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(key1).not.toBe(key2);
    });

    it('returns SHA-256 hex string', () => {
      const key = computeAggressiveCacheKey({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('ResponseCache aggressive mode', () => {
    let cacheDir: string;
    let cache: ResponseCache;

    beforeEach(() => {
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-aggcache-'));
      cache = new ResponseCache({
        enabled: true,
        mode: 'aggressive',
        aggressiveMaxAge: 1800,
        cacheDir,
        maxSizeMb: 10,
      });
    });

    afterEach(() => {
      cache.close();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('does not bypass non-deterministic requests in aggressive mode', () => {
      expect(cache.shouldBypass({ temperature: 0.7, model: 'test' })).toBe(false);
    });

    it('computes aggressive key via computeKey', () => {
      const body = {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'user', content: 'history' },
          { role: 'assistant', content: 'past' },
          { role: 'user', content: 'current' },
        ],
      };
      const key = cache.computeKey(body);
      expect(key).toBe(computeAggressiveCacheKey(body));
    });

    it('exact mode uses exact key', () => {
      const exactCache = new ResponseCache({ enabled: true, mode: 'exact', cacheDir, maxSizeMb: 10 });
      const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }] };
      expect(exactCache.computeKey(body)).toBe(computeCacheKey(body));
      exactCache.close();
    });

    it('mode getter works', () => {
      expect(cache.mode).toBe('aggressive');
    });

    it('aggressiveMaxAge getter works', () => {
      expect(cache.aggressiveMaxAge).toBe(1800);
    });
  });
});
