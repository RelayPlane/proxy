/**
 * Sonnet 5.x, Opus 5.5 and Fable 5.1 reject the `temperature` (and
 * `top_p`/`top_k`) sampling params with a 400 ("`temperature` is
 * deprecated for this model"), verified live against api.anthropic.com
 * 2026-09-28. A caller that always sends temperature (e.g. OpenClaw's
 * Telegram topic-label helper, which sends temperature: 0.3
 * unconditionally) 400s whenever auto-routing lands it on one of these
 * models. The proxy must strip temperature/top_p/top_k on the outbound
 * Anthropic request for models that reject them, and must NOT strip them
 * for models that still accept them (Haiku 4.5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  chatBody,
  passthroughAnthropicConfig,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

describe('Anthropic dispatch strips unsupported sampling params', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    const { home } = makeHome(passthroughAnthropicConfig);
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url, args: ['--verbose'] });
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it.each(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'])(
    'drops temperature/top_p/top_k for %s so the upstream never sees them',
    async (model) => {
      const res = await request(proxy.port, '/v1/messages', {
        body: messagesBody(`hi from ${model} (${Math.random()})`, {
          model,
          temperature: 0.3,
          top_p: 0.9,
          top_k: 40,
        }),
      });
      expect(res.status).toBe(200);

      const sent = upstream.calls[upstream.calls.length - 1]!.body;
      expect(sent['model']).toBe(model);
      expect(sent).not.toHaveProperty('temperature');
      expect(sent).not.toHaveProperty('top_p');
      expect(sent).not.toHaveProperty('top_k');
    },
  );

  it('keeps temperature/top_p/top_k for Haiku, which still accepts them', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody(`hi from haiku (${Math.random()})`, {
        model: 'claude-haiku-4-5-20251001',
        temperature: 0.3,
        top_p: 0.9,
        top_k: 40,
      }),
    });
    expect(res.status).toBe(200);

    const sent = upstream.calls[upstream.calls.length - 1]!.body;
    expect(sent['model']).toBe('claude-haiku-4-5-20251001');
    expect(sent['temperature']).toBe(0.3);
    expect(sent['top_p']).toBe(0.9);
    expect(sent['top_k']).toBe(40);
  });

  it('logs a debug line when a sampling param is stripped', async () => {
    await request(proxy.port, '/v1/messages', {
      body: messagesBody(`hi verbose-log (${Math.random()})`, {
        model: 'claude-opus-5-5',
        temperature: 0.5,
      }),
    });
    expect(proxy.output()).toMatch(/Stripped unsupported sampling param.*temperature.*claude-opus-5-5/);
  });

  it('drops temperature on the OpenAI-compatible /v1/chat/completions path too', async () => {
    const res = await request(proxy.port, '/v1/chat/completions', {
      body: chatBody('claude-sonnet-5-5', { temperature: 0.3 }),
    });
    expect(res.status).toBe(200);

    const sent = upstream.calls[upstream.calls.length - 1]!.body;
    expect(sent).not.toHaveProperty('temperature');
  });
});
