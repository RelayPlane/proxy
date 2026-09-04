/**
 * P0-1 (install test 2026-09-04, matrix rows 1c/1f/1j, fix list #1):
 * rp:cheap / rp:fast / rp:best / relayplane:cost crashed the proxy PROCESS
 * on an OpenRouter-only install ("TypeError: Cannot read properties of
 * undefined (reading 'includes')"), reproduced 8x. On an OpenAI-only install
 * the same aliases returned 401 "Missing Anthropic authentication".
 *
 * Contract: the proxy must NEVER die on a routable request. Aliases resolve
 * against the providers the user actually has keys for, and an alias whose
 * target provider is absent gets a clear 4xx, not a crash and not a 401.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  normalizeProxyConfig,
  refreshSmartAliases,
  getCostModel,
  getFastModel,
  getQualityModel,
} from '../src/standalone-proxy.js';
import {
  startMockUpstream,
  spawnProxy,
  makeHome,
  request,
  chatBody,
  initWrittenConfig1951,
  type MockUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

const ALIASES = ['rp:cheap', 'rp:fast', 'rp:best', 'rp:balanced', 'relayplane:cost', 'relayplane:fast', 'relayplane:quality', 'relayplane:auto'];

describe('config validation on load (root cause of the alias crash)', () => {
  it('drops routing.complexity tiers that carry no model and says how to fix them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = normalizeProxyConfig(initWrittenConfig1951 as never);
    const complexity = cfg.routing?.complexity as Record<string, unknown>;
    for (const tier of ['simple', 'moderate', 'complex', 'elite']) {
      const v = complexity[tier];
      // Either a usable model string, or absent. Never a description-only object.
      expect(typeof v === 'string' || v === undefined).toBe(true);
    }
    const messages = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(messages).toMatch(/routing\.complexity\.simple/);
    expect(messages).toMatch(/provider\/model/);
    warn.mockRestore();
  });

  it('keeps valid string and {provider, model} tiers untouched', () => {
    const cfg = normalizeProxyConfig({
      routing: { complexity: { simple: 'openrouter/google/gemini-2.5-flash-lite', complex: { provider: 'openai', model: 'gpt-4o' } } },
    } as never);
    const complexity = cfg.routing?.complexity as Record<string, unknown>;
    expect(complexity['simple']).toBe('openrouter/google/gemini-2.5-flash-lite');
    expect(complexity['complex']).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
});

describe('cost/fast/quality resolvers fall back to the configured provider, not hardcoded Anthropic', () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env = { ...saved };
    refreshSmartAliases();
  });

  it('OpenRouter-only install: rp:cheap / rp:fast / rp:best resolve to openrouter models', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
    refreshSmartAliases();
    const cfg = normalizeProxyConfig(initWrittenConfig1951 as never);
    expect(getCostModel(cfg)).toMatch(/^openrouter\//);
    expect(getFastModel(cfg)).toMatch(/^openrouter\//);
    expect(getQualityModel(cfg)).toMatch(/^openrouter\//);
  });

  it('OpenAI-only install: aliases resolve to openai models (never a 401 for Anthropic)', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test';
    refreshSmartAliases();
    const cfg = normalizeProxyConfig({ routing: { complexity: { enabled: true } } } as never);
    expect(getCostModel(cfg)).toMatch(/^openai\/gpt/);
    expect(getFastModel(cfg)).toMatch(/^openai\/gpt/);
    expect(getQualityModel(cfg)).toMatch(/^openai\/gpt/);
  });
});

describe('end to end: OpenRouter-only install with the config 1.9.51 init wrote', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    const { home } = makeHome(initWrittenConfig1951);
    proxy = await spawnProxy({
      home,
      env: { OPENROUTER_API_KEY: 'sk-or-dummy', RELAYPLANE_OPENROUTER_BASE_URL: upstream.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('starts without "Unknown provider" warnings or undefined auto-routing tiers', () => {
    expect(proxy.output()).not.toMatch(/Unknown provider "undefined"/);
    expect(proxy.output()).not.toMatch(/simple=undefined/);
  });

  for (const alias of ALIASES) {
    it(`${alias} gets a real response and the proxy stays alive`, async () => {
      const res = await request(proxy.port, '/v1/chat/completions', { body: chatBody(alias) });
      expect(proxy.alive(), `proxy died on ${alias}:\n${proxy.output()}`).toBe(true);
      expect(res.status, res.text).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('openrouter');
      const routed = res.headers['x-relayplane-routed-model'] ?? '';
      expect(routed).not.toMatch(/undefined/);
      expect(routed).toContain('/');
      const last = upstream.calls[upstream.calls.length - 1]!;
      expect(String(last.body['model'])).not.toMatch(/undefined/);
    }, 15_000);
  }

  it('an alias whose configured target provider has no credentials gets a clear 4xx, not a crash', async () => {
    // Force rp:best at a provider this install has no key for.
    const res = await request(proxy.port, '/v1/chat/completions', {
      body: chatBody('rp:best'),
      headers: { 'x-relayplane-model': 'google/gemini-2.5-pro' },
    });
    expect(proxy.alive()).toBe(true);
    // Either it was rerouted to the configured provider or rejected cleanly.
    expect([200, 400, 424]).toContain(res.status);
    if (res.status !== 200) {
      expect(res.text).toMatch(/GOOGLE_API_KEY|GEMINI_API_KEY|credentials|not configured/i);
    }
  }, 15_000);
});
