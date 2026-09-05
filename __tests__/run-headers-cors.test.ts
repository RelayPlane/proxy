/**
 * PR1, run attribution: the run headers are only usable if a browser client
 * is allowed to send them and to read the response ones back, and if the
 * proxy keeps them to itself instead of leaking RelayPlane control headers to
 * the model provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  startMockUpstream,
  request,
  messagesBody,
  passthroughAnthropicConfig,
  type MockAnthropicUpstream,
  type MockUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import { RUN_REQUEST_HEADERS, RUN_RESPONSE_HEADERS } from '../src/run-attribution.js';

describe('run headers: CORS, presence on every proxied response, and no upstream leak', () => {
  let anthropic: MockAnthropicUpstream;
  let openai: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    anthropic = await startMockAnthropicUpstream();
    openai = await startMockUpstream();
    const { home } = makeHome(passthroughAnthropicConfig);
    proxy = await spawnProxy({
      home,
      anthropicBaseUrl: anthropic.url,
      env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: openai.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await anthropic?.close();
    await openai?.close();
  });

  it('preflight allows every run request header and exposes every run response header', async () => {
    const res = await request(proxy.port, '/v1/messages', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': RUN_REQUEST_HEADERS.join(', '),
      },
    });
    expect([200, 204]).toContain(res.status);

    const allow = (res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    for (const name of RUN_REQUEST_HEADERS) {
      expect(allow, `allow-headers missing ${name}`).toContain(name.toLowerCase());
    }

    const expose = (res.headers['access-control-expose-headers'] ?? '').toLowerCase();
    for (const name of RUN_RESPONSE_HEADERS) {
      expect(expose, `expose-headers missing ${name}`).toContain(name.toLowerCase());
    }
  }, 30_000);

  it('native non-stream, native stream and chat responses all carry the four run headers', async () => {
    const cases: { label: string; res: Awaited<ReturnType<typeof request>> }[] = [
      {
        label: 'native non-stream',
        res: await request(proxy.port, '/v1/messages', {
          body: messagesBody('headers case one, non streaming.'),
          headers: { 'X-RelayPlane-Run': 'hdr-native' },
        }),
      },
      {
        label: 'native stream',
        res: await request(proxy.port, '/v1/messages', {
          body: messagesBody('headers case two, streaming.', { stream: true }),
          headers: { 'X-RelayPlane-Run': 'hdr-native-stream' },
        }),
      },
      {
        label: 'chat non-stream',
        res: await request(proxy.port, '/v1/chat/completions', {
          body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'headers case three, chat.' }] },
          headers: { 'X-RelayPlane-Run': 'hdr-chat' },
        }),
      },
    ];

    for (const c of cases) {
      expect(c.res.status, `${c.label}: ${c.res.text}`).toBe(200);
      for (const name of RUN_RESPONSE_HEADERS) {
        const key = name.toLowerCase();
        expect(c.res.headers[key], `${c.label} is missing ${name}`).toBeDefined();
      }
      expect(c.res.headers['x-relayplane-run-source']).toBe('header');
      expect(Number(c.res.headers['x-relayplane-run-cost-usd'])).not.toBeNaN();
      expect(c.res.headers['x-relayplane-run-band']).toBeDefined();
    }

    expect(cases[0]!.res.headers['x-relayplane-run-id']).toBe('hdr-native');
    expect(cases[1]!.res.headers['x-relayplane-run-id']).toBe('hdr-native-stream');
    expect(cases[2]!.res.headers['x-relayplane-run-id']).toBe('hdr-chat');
  }, 30_000);

  it('no x-relayplane-* control header is forwarded to either upstream', () => {
    const leaked: string[] = [];
    for (const call of [...anthropic.calls, ...openai.calls]) {
      for (const name of Object.keys(call.headers)) {
        if (name.toLowerCase().startsWith('x-relayplane-')) leaked.push(`${call.path}: ${name}`);
      }
    }
    expect(leaked, `leaked headers: ${leaked.join(', ')}`).toHaveLength(0);
  });
});
