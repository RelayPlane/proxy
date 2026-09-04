/**
 * P0-5 (install test 2026-09-04, matrix row 3e, fix list #6):
 * a streamed OpenAI-style request was costed at $0 with 0/0 tokens unless
 * the client itself sent stream_options.include_usage, which OpenAI SDKs do
 * not send by default. Most agents stream, so the ledger under-reported most
 * non-Anthropic spend.
 *
 * Contract: the proxy asks the upstream for usage on every OpenAI-compatible
 * stream, keeps the client's wire format unchanged (the usage-only chunk is
 * not forwarded unless the client asked for it), and records real tokens and
 * cost. If the upstream still sends no usage, the ledger carries an estimate
 * flagged as estimated rather than a silent zero.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockUpstream,
  request,
  chatBody,
  type MockUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

interface Run { tokensIn: number; tokensOut: number; costUsd: number; costEstimated?: boolean }

async function lastRun(port: number): Promise<Run> {
  const res = await request(port, '/v1/telemetry/runs?limit=1');
  expect(res.status).toBe(200);
  return (res.json() as { runs: Run[] }).runs[0]!;
}

describe('streamed OpenAI-compatible requests are costed', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    const { home } = makeHome({ config_version: 4, telemetry_enabled: false });
    proxy = await spawnProxy({
      home,
      env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('asks upstream for usage, hides the usage-only chunk from a client that did not ask, records tokens and cost', async () => {
    const res = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini', { stream: true }) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('PONG');
    expect(res.text).toContain('data: [DONE]');
    // Client wire format unchanged: no chunk with empty choices + usage.
    const events = res.text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)) as { choices: unknown[]; usage?: unknown });
    expect(events.some((e) => Array.isArray(e.choices) && e.choices.length === 0)).toBe(false);

    const sent = upstream.calls[upstream.calls.length - 1]!.body;
    expect((sent['stream_options'] as { include_usage?: boolean })?.include_usage).toBe(true);

    const run = await lastRun(proxy.port);
    expect(run.tokensIn).toBe(21);
    expect(run.tokensOut).toBe(2);
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.costEstimated).toBeFalsy();
  }, 15_000);

  it('forwards the usage chunk when the client explicitly asked for it', async () => {
    const res = await request(proxy.port, '/v1/chat/completions', {
      body: chatBody('gpt-4o-mini', { stream: true, stream_options: { include_usage: true } }),
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/"prompt_tokens":21/);
  }, 15_000);

  it('upstream that never sends usage: ledger carries an estimate marked estimated, not $0', async () => {
    upstream.omitUsage = true;
    try {
      const res = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini', { stream: true }) });
      expect(res.status).toBe(200);
      const run = await lastRun(proxy.port);
      expect(run.tokensIn).toBeGreaterThan(0);
      expect(run.tokensOut).toBeGreaterThan(0);
      expect(run.costUsd).toBeGreaterThan(0);
      expect(run.costEstimated).toBe(true);
    } finally {
      upstream.omitUsage = false;
    }
  }, 15_000);
});
