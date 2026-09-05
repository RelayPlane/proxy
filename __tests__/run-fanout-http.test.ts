/**
 * PR1, run attribution end to end: three agents fanned out through one proxy
 * at the same time must each get their own run id back, and each run's ledger
 * must carry exactly that run's tokens and cost.
 *
 * This is the test that would have caught the tail-update bug in production
 * traffic: the requests are deliberately made to finish out of order (the
 * mock upstream delays the first-fired call the longest), so any "last row
 * wins" bookkeeping cross-attributes the money.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  startMockUpstream,
  request,
  messagesBody,
  allUserText,
  anthropicMockUsage,
  passthroughAnthropicConfig,
  readRunsDb,
  readHistory,
  type MockAnthropicUpstream,
  type MockUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import { estimateCost } from '../src/telemetry.js';

const NATIVE_MODEL = 'claude-sonnet-4-6';

/** Distinct lengths so a swapped attribution shows up as a wrong number. */
const FANOUT = [
  { run: 'fan-a', text: 'fan-a asks a short question about caching.', delayMs: 300 },
  { run: 'fan-b', text: 'fan-b asks a noticeably longer question about caching, routing, and how the proxy prices a request end to end.', delayMs: 100 },
  { run: 'fan-c', text: 'fan-c asks a medium length question about routing and cost.', delayMs: 200 },
];

describe('native /v1/messages fan-out: three runs, three ledgers', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    for (const f of FANOUT) upstream.delays.set(f.run, f.delayMs);
    ({ home } = makeHome(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('every response carries its own run id and run source', async () => {
    const responses = await Promise.all(
      FANOUT.map((f) =>
        request(proxy.port, '/v1/messages', {
          body: messagesBody(f.text),
          headers: { 'X-RelayPlane-Run': f.run },
        }),
      ),
    );

    responses.forEach((res, i) => {
      const f = FANOUT[i]!;
      expect(res.status, res.text).toBe(200);
      expect(res.headers['x-relayplane-run-id']).toBe(f.run);
      expect(res.headers['x-relayplane-run-source']).toBe('header');
      expect(Number(res.headers['x-relayplane-run-cost-usd'])).toBeGreaterThanOrEqual(0);
    });

    expect(upstream.calls).toHaveLength(3);
  }, 30_000);

  it('each run row carries exactly its own tokens and cost', async () => {
    const dump = readRunsDb(home);

    for (const f of FANOUT) {
      const call = upstream.calls.find((c) => allUserText(c.body).includes(f.run));
      expect(call, `no upstream call for ${f.run}`).toBeTruthy();
      const usage = anthropicMockUsage(allUserText(call!.body));
      const expectedCost = estimateCost(NATIVE_MODEL, usage.input_tokens, usage.output_tokens);

      const run = dump.runs.find((r) => r.run_id === f.run);
      expect(run, `no run row for ${f.run} (runs: ${dump.runs.map((r) => r.run_id).join(',')})`).toBeTruthy();
      expect(run!.request_count).toBe(1);
      expect(run!.tokens_in).toBe(usage.input_tokens);
      expect(run!.tokens_out).toBe(usage.output_tokens);
      expect(run!.cost_usd).toBeCloseTo(expectedCost, 10);
      expect(run!.run_source).toBe('header');
      expect(run!.status).toBe('running');

      const requests = dump.requests.filter((r) => r.run_id === f.run);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.cost_usd).toBeCloseTo(expectedCost, 10);
      expect(requests[0]!.success).toBe(1);
    }

    // No cross-attribution: the three runs cover every recorded request.
    expect(dump.requests.filter((r) => FANOUT.some((f) => f.run === r.run_id))).toHaveLength(3);
  }, 30_000);

  it('history.jsonl rows carry the run id and a non-zero cost each', async () => {
    // SIGTERM flushes the history buffer; stopProcess leaves HOME in place.
    await proxy.stopProcess();
    const rows = readHistory(home).filter((r) => r.provider === 'anthropic');
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const f of FANOUT) {
      const row = rows.find((r) => r.runId === f.run);
      expect(row, `no history row for ${f.run}`).toBeTruthy();
      expect(row!.costUsd).toBeGreaterThan(0);
      expect(row!.tokensOut).toBe(7);
      expect(row!.runSource).toBe('header');
      expect(row!.traceId).toBeTruthy();
    }
  }, 30_000);
});

const CHAT_FANOUT = [
  { run: 'chat-a', text: 'chat-a streams a short prompt.', delayMs: 250 },
  { run: 'chat-b', text: 'chat-b streams a prompt as well.', delayMs: 80 },
  { run: 'chat-c', text: 'chat-c streams a third prompt.', delayMs: 160 },
];

describe('streaming /v1/chat/completions fan-out: three runs, three ledgers', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    for (const f of CHAT_FANOUT) upstream.delays.set(f.run, f.delayMs);
    ({ home } = makeHome({ config_version: 4, telemetry_enabled: false, cache: { enabled: false } }));
    proxy = await spawnProxy({
      home,
      env: { OPENAI_API_KEY: 'sk-dummy', RELAYPLANE_OPENAI_BASE_URL: upstream.url },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('streamed responses carry their own run headers and ledgers', async () => {
    const responses = await Promise.all(
      CHAT_FANOUT.map((f) =>
        request(proxy.port, '/v1/chat/completions', {
          body: {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: f.text }],
            stream: true,
            stream_options: { include_usage: true },
          },
          headers: { 'X-RelayPlane-Run': f.run },
        }),
      ),
    );

    responses.forEach((res, i) => {
      const f = CHAT_FANOUT[i]!;
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain('PONG');
      expect(res.headers['x-relayplane-run-id']).toBe(f.run);
      expect(res.headers['x-relayplane-run-source']).toBe('header');
    });

    const expectedCost = estimateCost('gpt-4o-mini', 21, 2);
    const dump = readRunsDb(home);
    for (const f of CHAT_FANOUT) {
      const run = dump.runs.find((r) => r.run_id === f.run);
      expect(run, `no run row for ${f.run} (runs: ${dump.runs.map((r) => r.run_id).join(',')})`).toBeTruthy();
      expect(run!.request_count).toBe(1);
      expect(run!.tokens_in).toBe(21);
      expect(run!.tokens_out).toBe(2);
      expect(run!.cost_usd).toBeCloseTo(expectedCost, 10);
    }
  }, 30_000);
});
