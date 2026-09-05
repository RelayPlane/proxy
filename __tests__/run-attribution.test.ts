import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';

import {
  RUN_REQUEST_HEADERS,
  RUN_RESPONSE_HEADERS,
  DEFAULT_ATTRIBUTION_CONFIG,
  resolveAttributionConfig,
  configureRunAttribution,
  getAttributionConfig,
  parseRunHeaders,
  parseTags,
  formatTags,
  normalizeRunId,
  computeThreadId,
  computeClientKey,
  extractUserMessages,
  cacheStateFor,
  newRunRequestContext,
  attachRunIdentity,
  setRunTraceId,
  stampRunFields,
  recordRunRequest,
  checkRunCap,
  withRunHeaders,
  endRun,
  registerRun,
  mintRunId,
  sweepIdleRuns,
  startRunAttributionTimers,
  stopRunAttributionTimers,
  runCtx,
  _resetRunAttributionForTests,
  type RunHistoryEntryLike,
  type RunRequestContext,
} from '../src/run-attribution.js';
import { getRunStore, type RunAlertRow } from '../src/run-store.js';
import { estimateCost } from '../src/telemetry.js';

const NOW = 1_800_000_000_000;

let home = '';
let savedOverride: string | undefined;

interface Message {
  role: string;
  content: unknown;
}

interface FireOpts {
  headers?: http.IncomingHttpHeaders;
  now?: number;
  system?: string;
  messages?: Message[];
  fingerprint?: string;
  explicitAgentId?: string;
  traceId?: string;
  record?: boolean;
  entry?: Partial<RunHistoryEntryLike>;
}

function makeEntry(over: Partial<RunHistoryEntryLike> = {}): RunHistoryEntryLike {
  return {
    id: 'hist-1',
    originalModel: 'claude-sonnet-4-6',
    targetModel: 'claude-sonnet-4-6',
    provider: 'anthropic',
    latencyMs: 120,
    success: true,
    timestamp: new Date(NOW).toISOString(),
    tokensIn: 1000,
    tokensOut: 100,
    costUsd: 0.01,
    ...over,
  };
}

/** Runs the full per-request path: context, identity, trace id, optional record. */
function fire(opts: FireOpts = {}): RunRequestContext {
  const now = opts.now ?? NOW;
  const rc = newRunRequestContext({ headers: opts.headers ?? {} }, now);
  attachRunIdentity(rc, {
    sessionId: 'sess-1',
    sessionSource: 'claude-code',
    systemPrompt: opts.system ?? 'SYSTEM PROMPT',
    agentFingerprint: opts.fingerprint,
    explicitAgentId: opts.explicitAgentId,
    body: {
      model: 'claude-sonnet-4-6',
      messages: opts.messages ?? [{ role: 'user', content: 'hello world' }],
    },
    requestedModel: 'claude-sonnet-4-6',
    now,
  });
  if (opts.traceId) {
    runCtx.run(rc, () => setRunTraceId(opts.traceId!));
  }
  if (opts.record) {
    recordRunRequest(makeEntry({ timestamp: new Date(now).toISOString(), ...opts.entry }), rc);
  }
  return rc;
}

beforeEach(() => {
  savedOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-run-attr-'));
  process.env['RELAYPLANE_HOME_OVERRIDE'] = home;
  _resetRunAttributionForTests();
  configureRunAttribution(undefined);
});

afterEach(() => {
  _resetRunAttributionForTests();
  if (savedOverride === undefined) delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  else process.env['RELAYPLANE_HOME_OVERRIDE'] = savedOverride;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('config and header contract', () => {
  it('exposes the 8 request headers and 4 response headers', () => {
    expect(RUN_REQUEST_HEADERS).toHaveLength(8);
    expect(RUN_REQUEST_HEADERS).toContain('X-RelayPlane-Run');
    expect(RUN_REQUEST_HEADERS).toContain('X-RelayPlane-Run-End');
    expect(RUN_RESPONSE_HEADERS).toEqual([
      'X-RelayPlane-Run-Id',
      'X-RelayPlane-Run-Source',
      'X-RelayPlane-Run-Cost-Usd',
      'X-RelayPlane-Run-Band',
    ]);
  });

  it('deep merges partial config over the defaults', () => {
    expect(DEFAULT_ATTRIBUTION_CONFIG.idleCloseSeconds).toBe(600);
    expect(DEFAULT_ATTRIBUTION_CONFIG.runCapAction).toBe('block');
    const merged = resolveAttributionConfig({
      idleCloseSeconds: 30,
      alerts: { webhookUrl: 'https://example.test/hook', overBand: true, runCostUsd: 5, modelDrift: true },
      rateLimitWave: { enabled: false, count: 5, windowSeconds: 60 },
    });
    expect(merged.idleCloseSeconds).toBe(30);
    expect(merged.alerts.runCostUsd).toBe(5);
    expect(merged.alerts.modelDrift).toBe(true);
    expect(merged.rateLimitWave.enabled).toBe(false);
    expect(merged.retentionDays).toBe(DEFAULT_ATTRIBUTION_CONFIG.retentionDays);
    expect(merged.bands).toEqual({});
    // Defaults are not mutated by a merge.
    expect(DEFAULT_ATTRIBUTION_CONFIG.idleCloseSeconds).toBe(600);
  });

  it('keeps deps across a hot config reload', () => {
    const log = vi.fn();
    configureRunAttribution(undefined, { log });
    configureRunAttribution({ idleCloseSeconds: 45 });
    expect(getAttributionConfig().idleCloseSeconds).toBe(45);
    fire({ headers: { 'x-relayplane-run': 'bad id!' } });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does nothing when attribution is disabled', () => {
    configureRunAttribution({ enabled: false });
    const rc = fire({ headers: { 'x-relayplane-run': 'r1' } });
    expect(rc.runId).toBeUndefined();
    expect(getRunStore().getRun('r1')).toBeNull();
  });
});

describe('pure parsers', () => {
  it('normalizes run ids, rejects bad charsets and clamps depth to 8 keeping the tail', () => {
    expect(normalizeRunId('nightly-20260905-a1b2c3')).toEqual({
      runId: 'nightly-20260905-a1b2c3', parentRunId: null, depth: 0,
    });
    expect(normalizeRunId('nightly/researcher-2')).toEqual({
      runId: 'nightly/researcher-2', parentRunId: 'nightly', depth: 1,
    });
    expect(normalizeRunId('a@b.c:d/e')?.depth).toBe(1);
    expect(normalizeRunId('bad id!')).toBeNull();
    expect(normalizeRunId('a//b')).toBeNull();
    expect(normalizeRunId('/leading')).toBeNull();
    expect(normalizeRunId('')).toBeNull();
    expect(normalizeRunId('x'.repeat(129))).toBeNull();

    const deep = normalizeRunId('s1/s2/s3/s4/s5/s6/s7/s8/s9/s10');
    expect(deep).not.toBeNull();
    expect(deep!.depth).toBe(8);
    expect(deep!.runId).toBe('s2/s3/s4/s5/s6/s7/s8/s9/s10');
    expect(deep!.parentRunId).toBe('s2/s3/s4/s5/s6/s7/s8/s9');
  });

  it('parses at most 10 tag pairs and round-trips through formatTags', () => {
    const raw = Array.from({ length: 12 }, (_, i) => `k${i}:v${i}`).join(',');
    const tags = parseTags(raw);
    expect(Object.keys(tags)).toHaveLength(10);
    expect(tags['k0']).toBe('v0');
    expect(tags['k9']).toBe('v9');
    expect(tags['k10']).toBeUndefined();
    expect(formatTags(tags)).toBe(Array.from({ length: 10 }, (_, i) => `k${i}:v${i}`).join(','));
    expect(parseTags(formatTags(tags))).toEqual(tags);

    expect(parseTags(' env : prod , team:core ')).toEqual({ env: 'prod', team: 'core' });
    expect(parseTags('novalue')).toEqual({});
    expect(parseTags(undefined)).toEqual({});
    const long = parseTags(`${'k'.repeat(80)}:${'v'.repeat(80)}`);
    const key = Object.keys(long)[0];
    expect(key).toHaveLength(64);
    expect(long[key]).toHaveLength(64);
  });

  it('reads every request header with validation', () => {
    const parsed = parseRunHeaders({
      'x-relayplane-run': 'nightly/child',
      'x-relayplane-agent': 'researcher',
      'x-relayplane-parent-run': 'other-parent',
      'x-relayplane-run-label': 'nightly-backfill',
      'x-relayplane-tags': 'env:prod',
      'x-relayplane-attempt': '3',
      'x-relayplane-run-cap-usd': '2.50',
      'x-relayplane-run-end': 'true',
      'x-claude-code-session-id': 'sess-abc',
      'x-agent-id': 'legacy-agent',
    });
    expect(parsed.runId).toBe('nightly/child');
    expect(parsed.agent).toBe('researcher');
    expect(parsed.parentRunId).toBe('other-parent');
    expect(parsed.label).toBe('nightly-backfill');
    expect(parsed.tags).toEqual({ env: 'prod' });
    expect(parsed.attempt).toBe(3);
    expect(parsed.capUsd).toBe(2.5);
    expect(parsed.end).toBe(true);
    expect(parsed.claudeCodeSessionId).toBe('sess-abc');
    expect(parsed.xAgentId).toBe('legacy-agent');

    const rejected = parseRunHeaders({
      'x-relayplane-run': 'nope nope',
      'x-relayplane-attempt': '0',
      'x-relayplane-run-cap-usd': '-1',
      'x-relayplane-run-end': 'nope',
    });
    expect(rejected.runId).toBeUndefined();
    expect(rejected.invalidRunId).toBe('nope nope');
    expect(rejected.attempt).toBeUndefined();
    expect(rejected.capUsd).toBeUndefined();
    expect(rejected.end).toBe(false);
  });

  it('extracts first and last user messages from both body shapes', () => {
    expect(extractUserMessages({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: 'last' },
      ],
    })).toEqual({ first: 'first', last: 'last' });

    expect(extractUserMessages({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] },
      ],
    })).toEqual({ first: 'a\nb', last: 'a\nb' });

    expect(extractUserMessages({})).toEqual({ first: '', last: '' });
    expect(extractUserMessages({ messages: [{ role: 'assistant', content: 'x' }] })).toEqual({ first: '', last: '' });
  });

  it('classifies cache state at the 50 percent boundary', () => {
    expect(cacheStateFor(100, 0)).toBe('cold');
    expect(cacheStateFor(51, 49)).toBe('cold');
    expect(cacheStateFor(50, 50)).toBe('warm');
    expect(cacheStateFor(1, 99)).toBe('warm');
    expect(cacheStateFor(0, 0)).toBe('cold');
  });

  it('mints run ids with the label, a UTC date and 6 hex characters', () => {
    const id = mintRunId('nightly', Date.UTC(2026, 8, 5, 12, 0, 0));
    expect(id).toMatch(/^nightly-20260905-[0-9a-f]{6}$/);
    expect(mintRunId(undefined, Date.UTC(2026, 8, 5))).toMatch(/^run-20260905-[0-9a-f]{6}$/);
    expect(mintRunId('x')).not.toBe(mintRunId('x'));
  });
});

describe('run id ladder', () => {
  it('prefers X-RelayPlane-Run over the Claude Code session id', () => {
    const rc = fire({
      headers: { 'x-relayplane-run': 'fan-a', 'x-claude-code-session-id': 'aaaa-bbbb' },
    });
    expect(rc.runId).toBe('fan-a');
    expect(rc.runSource).toBe('header');
    expect(getRunStore().getRun('fan-a')?.run_source).toBe('header');
    expect(getRunStore().getRun('cc-aaaa-bbbb')).toBeNull();
  });

  it('falls back to cc-<session> when only the Claude Code header is present', () => {
    const rc = fire({ headers: { 'x-claude-code-session-id': '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } });
    expect(rc.runId).toBe('cc-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(rc.runSource).toBe('inferred_cc');
  });

  it('logs an invalid run id once per minute and falls through the ladder', () => {
    const log = vi.fn();
    configureRunAttribution(undefined, { log });
    const rc = fire({
      headers: { 'x-relayplane-run': 'has spaces', 'x-claude-code-session-id': 'sess-9' },
    });
    expect(rc.headers.invalidRunId).toBe('has spaces');
    expect(rc.runId).toBe('cc-sess-9');
    expect(rc.runSource).toBe('inferred_cc');

    fire({ headers: { 'x-relayplane-run': 'has spaces', 'x-claude-code-session-id': 'sess-9' }, now: NOW + 1000 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('ignoring invalid X-RelayPlane-Run');

    fire({ headers: { 'x-relayplane-run': 'has spaces', 'x-claude-code-session-id': 'sess-9' }, now: NOW + 61_000 });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('nests on / and writes the ancestor rows', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'nightly-1/researcher/deep' } });
    expect(rc.runId).toBe('nightly-1/researcher/deep');
    expect(rc.parentRunId).toBe('nightly-1/researcher');
    expect(rc.depth).toBe(2);

    const store = getRunStore();
    expect(store.getRun('nightly-1')?.depth).toBe(0);
    expect(store.getRun('nightly-1/researcher')?.depth).toBe(1);
    expect(store.getRun('nightly-1/researcher')?.parent_run_id).toBe('nightly-1');
    expect(store.childrenOf('nightly-1/researcher').map((r) => r.run_id)).toEqual(['nightly-1/researcher/deep']);
  });

  it('clamps a depth 9 id to depth 8, keeping the tail segments', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 's1/s2/s3/s4/s5/s6/s7/s8/s9/s10' } });
    expect(rc.depth).toBe(8);
    expect(rc.runId).toBe('s2/s3/s4/s5/s6/s7/s8/s9/s10');
    expect(getRunStore().getRun('s1')).toBeNull();
  });

  it('honours an explicit parent header for a flat id', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'child-1', 'x-relayplane-parent-run': 'parent-1' } });
    expect(rc.parentRunId).toBe('parent-1');
    expect(rc.depth).toBe(1);
    expect(getRunStore().getRun('parent-1')).not.toBeNull();
  });

  it('mints a gap run per client key, stable while requests keep arriving', () => {
    const claude: http.IncomingHttpHeaders = { 'user-agent': 'claude-cli/2.0', authorization: 'Bearer abc' };
    const other: http.IncomingHttpHeaders = { 'user-agent': 'python-httpx/0.27', authorization: 'Bearer abc' };

    const first = fire({ headers: claude });
    const second = fire({ headers: claude, now: NOW + 60_000 });
    const third = fire({ headers: other });

    expect(first.runSource).toBe('inferred_gap');
    expect(first.runId).toMatch(/^gap-[0-9a-f]{8}-\d{12}$/);
    expect(second.runId).toBe(first.runId);
    expect(second.clientKey).toBe(first.clientKey);
    expect(third.clientKey).not.toBe(first.clientKey);
    expect(third.runId).not.toBe(first.runId);

    // A gap longer than idleCloseSeconds (measured from the last request) starts a new run.
    const later = fire({ headers: claude, now: NOW + 60_000 + 601_000 });
    expect(later.runId).not.toBe(first.runId);
    expect(computeClientKey(claude)).toBe(first.clientKey);
  });

  it('leaves the run unset when inference is off and no header is present', () => {
    configureRunAttribution({ inferRuns: false });
    const rc = fire({ headers: { 'x-claude-code-session-id': 'sess-1' } });
    expect(rc.runId).toBeUndefined();
    expect(getRunStore().listRuns({}).runs).toEqual([]);
  });
});

describe('agent and thread identity', () => {
  it('takes the agent label from headers, x-agent-id, then inference', () => {
    const explicit = fire({ headers: { 'x-relayplane-run': 'r1', 'x-relayplane-agent': 'researcher', 'x-agent-id': 'legacy' } });
    expect(explicit.agentLabel).toBe('researcher');
    expect(explicit.agentSource).toBe('header');

    const alias = fire({ headers: { 'x-relayplane-run': 'r2', 'x-agent-id': 'legacy-agent' } });
    expect(alias.agentLabel).toBe('legacy-agent');
    expect(alias.agentSource).toBe('header');

    const inferred = fire({ headers: { 'x-relayplane-run': 'r3' }, fingerprint: 'abcdef1234567890' });
    expect(inferred.agentSource).toBe('inferred');
    expect(inferred.agentLabel).toBe(`agent-abcdef12/t-${inferred.threadId!.slice(0, 4)}`);

    const unknown = fire({ headers: { 'x-relayplane-run': 'r4' } });
    expect(unknown.agentLabel).toMatch(/^unknown\/t-[0-9a-f]{4}$/);
  });

  it('uses resolveAgentName for the inferred label when the integrator supplies it', () => {
    configureRunAttribution(undefined, { resolveAgentName: (fp) => (fp === 'fp-coder' ? 'coder' : undefined) });
    const named = fire({ headers: { 'x-relayplane-run': 'r1' }, fingerprint: 'fp-coder' });
    expect(named.agentLabel).toBe(`coder/t-${named.threadId!.slice(0, 4)}`);
    const unnamed = fire({ headers: { 'x-relayplane-run': 'r2' }, fingerprint: 'fp-other' });
    expect(unnamed.agentLabel).toBe(`agent-fp-other/t-${unnamed.threadId!.slice(0, 4)}`);
  });

  it('keeps the thread id stable across turns and distinct across siblings', () => {
    const turn1 = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [{ role: 'user', content: 'kick off the task' }],
    });
    const turn2 = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [
        { role: 'user', content: 'kick off the task' },
        { role: 'assistant', content: 'working' },
        { role: 'user', content: 'now do the next part' },
      ],
      now: NOW + 5000,
    });
    expect(turn2.threadId).toBe(turn1.threadId);

    const sibling = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [{ role: 'user', content: 'a different opening turn' }],
      now: NOW + 6000,
    });
    expect(sibling.threadId).not.toBe(turn1.threadId);

    const otherSystem = fire({
      headers: { 'x-relayplane-run': 'r1' },
      system: 'A DIFFERENT SYSTEM PROMPT',
      messages: [{ role: 'user', content: 'kick off the task' }],
      now: NOW + 7000,
    });
    expect(otherSystem.threadId).not.toBe(turn1.threadId);
    expect(turn1.threadId).toBe(computeThreadId('SYSTEM PROMPT', 'kick off the task'));
  });

  it('uses the main thread when thread inference is disabled', () => {
    configureRunAttribution({ inferThreads: false });
    expect(fire({ headers: { 'x-relayplane-run': 'r1' } }).threadId).toBe('main');
  });
});

describe('retry inference', () => {
  const thread: Message[] = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'keep going' },
  ];

  it('marks attempt > 1 as a header retry', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'r1', 'x-relayplane-attempt': '3' } });
    expect(rc.attempt).toBe(3);
    expect(rc.isRetry).toBe(true);
    expect(rc.retryReason).toBe('header');
  });

  it('infers after_error from the previous failed request on the thread', () => {
    fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: thread,
      traceId: 'trace-1',
      record: true,
      entry: { success: false, statusCode: 500, costUsd: 0 },
    });
    const retry = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [...thread, { role: 'assistant', content: 'x' }, { role: 'user', content: 'retry please' }],
      now: NOW + 2000,
    });
    expect(retry.isRetry).toBe(true);
    expect(retry.retryReason).toBe('after_error');
  });

  it('infers after_429 from an upstream rate limit', () => {
    fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: thread,
      traceId: 'trace-1',
      record: true,
      entry: { success: false, statusCode: 429, costUsd: 0 },
    });
    const retry = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [...thread, { role: 'assistant', content: 'x' }, { role: 'user', content: 'again' }],
      now: NOW + 2000,
    });
    expect(retry.retryReason).toBe('after_429');
  });

  it('infers same_prompt when the identical turn is resent', () => {
    fire({ headers: { 'x-relayplane-run': 'r1' }, messages: thread, traceId: 'trace-1', record: true });
    const resend = fire({ headers: { 'x-relayplane-run': 'r1' }, messages: thread, now: NOW + 3000 });
    expect(resend.isRetry).toBe(true);
    expect(resend.retryReason).toBe('same_prompt');
  });

  it('does not mark a normal next turn as a retry', () => {
    fire({ headers: { 'x-relayplane-run': 'r1' }, messages: thread, traceId: 'trace-1', record: true });
    const next = fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: [...thread, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now something else' }],
      now: NOW + 3000,
    });
    expect(next.isRetry).toBe(false);
    expect(next.retryReason).toBeUndefined();
  });

  it('ignores a stale previous request outside the 120 s window', () => {
    fire({
      headers: { 'x-relayplane-run': 'r1' },
      messages: thread,
      traceId: 'trace-1',
      record: true,
      entry: { success: false, statusCode: 500, costUsd: 0 },
    });
    const later = fire({ headers: { 'x-relayplane-run': 'r1' }, messages: thread, now: NOW + 121_000 });
    expect(later.isRetry).toBe(false);
  });
});

describe('recording', () => {
  it('writes the request row, the rollups and the all-opus baseline', () => {
    const rc = fire({
      headers: { 'x-relayplane-run': 'r1', 'x-relayplane-agent': 'coder', 'x-relayplane-tags': 'env:prod' },
      traceId: 'trace-1',
      record: true,
      entry: { tokensIn: 1200, tokensOut: 300, costUsd: 0.02, cacheReadTokens: 1000, cacheCreationTokens: 100 },
    });

    const store = getRunStore();
    const run = store.getRun('r1')!;
    expect(run.request_count).toBe(1);
    expect(run.tokens_in).toBe(1200);
    expect(run.tokens_out).toBe(300);
    expect(run.cache_read).toBe(1000);
    expect(run.cost_usd).toBeCloseTo(0.02, 10);
    expect(run.baseline_usd).toBeCloseTo(estimateCost('claude-opus-4-6', 1200, 300, 100, 1000), 12);
    expect(run.tags).toEqual({ env: 'prod' });

    const request = store.listRequests('r1').requests[0];
    expect(request.trace_id).toBe('trace-1');
    expect(request.agent_label).toBe('coder');
    expect(request.thread_id).toBe(rc.threadId);
    expect(request.history_id).toBe('hist-1');
    expect(request.cache_state).toBe('warm');
    expect(request.success).toBe(1);
    expect(store.getRun('r1')!.cache_state).toBe('warm');
  });

  it('is idempotent on the same trace id', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'r1' }, traceId: 'trace-1', record: true, entry: { costUsd: 0.01 } });
    recordRunRequest(makeEntry({ costUsd: 0.05, tokensIn: 5000, tokensOut: 500 }), rc);

    const store = getRunStore();
    const run = store.getRun('r1')!;
    expect(run.request_count).toBe(1);
    expect(run.cost_usd).toBeCloseTo(0.05, 10);
    expect(run.tokens_in).toBe(5000);
    expect(store.listRequests('r1').requests).toHaveLength(1);
    expect(store.agentsForRun('r1')[0].request_count).toBe(1);
  });

  it('is a no-op without a trace id', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'r1' } });
    recordRunRequest(makeEntry(), rc);
    expect(getRunStore().listRequests('r1').requests).toHaveLength(0);
    expect(getRunStore().getRun('r1')!.request_count).toBe(0);
  });

  it('counts drift when the proxy moved the model', () => {
    fire({
      headers: { 'x-relayplane-run': 'r1' },
      traceId: 'trace-1',
      record: true,
      entry: { originalModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6' },
    });
    expect(getRunStore().getRun('r1')!.drift_count).toBe(1);
  });

  it('closes the run when X-RelayPlane-Run-End is set', () => {
    fire({
      headers: { 'x-relayplane-run': 'r1', 'x-relayplane-run-end': 'true' },
      traceId: 'trace-1',
      record: true,
    });
    const run = getRunStore().getRun('r1')!;
    expect(run.status).toBe('completed');
    expect(run.ended_at).not.toBeNull();
  });

  it('fires run.cost_exceeded once and forwards it to the integrator', () => {
    const forwarded: RunAlertRow[] = [];
    configureRunAttribution({ alerts: { webhookUrl: null, overBand: true, runCostUsd: 0.05, modelDrift: true } }, {
      forwardAlert: (alert) => { forwarded.push(alert); },
    });

    const rc = fire({ headers: { 'x-relayplane-run': 'r1' }, traceId: 'trace-1', record: true, entry: { costUsd: 0.04 } });
    expect(forwarded).toHaveLength(0);

    rc.traceId = 'trace-2';
    recordRunRequest(makeEntry({ id: 'hist-2', costUsd: 0.03 }), rc);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].kind).toBe('run.cost_exceeded');
    expect(forwarded[0].run_id).toBe('r1');
    expect(forwarded[0].severity).toBe('warning');
    expect(forwarded[0].data['threshold']).toBe(0.05);

    rc.traceId = 'trace-3';
    recordRunRequest(makeEntry({ id: 'hist-3', costUsd: 0.03 }), rc);
    expect(forwarded).toHaveLength(1);
    expect(getRunStore().listAlerts({ run_id: 'r1' })[0].delivered).toBe(1);
  });

  it('stamps the run fields onto a history entry', () => {
    const rc = fire({
      headers: { 'x-relayplane-run': 'r1/child', 'x-relayplane-agent': 'coder', 'x-relayplane-tags': 'env:prod', 'x-relayplane-attempt': '2' },
      traceId: 'trace-1',
    });
    const entry = makeEntry();
    stampRunFields(entry, rc);
    expect(entry.runId).toBe('r1/child');
    expect(entry.parentRunId).toBe('r1');
    expect(entry.agentLabel).toBe('coder');
    expect(entry.threadId).toBe(rc.threadId);
    expect(entry.runSource).toBe('header');
    expect(entry.traceId).toBe('trace-1');
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.attempt).toBe(2);
    expect(entry.isRetry).toBe(true);
    expect(entry.tags).toEqual({ env: 'prod' });

    const bare = makeEntry();
    stampRunFields(bare, newRunRequestContext({ headers: {} }, NOW));
    expect(bare.runId).toBeUndefined();
  });
});

describe('caps and response headers', () => {
  it('blocks the request that would cross the cap and alerts once', () => {
    const rc = fire({
      headers: { 'x-relayplane-run': 'cap-1', 'x-relayplane-run-cap-usd': '0.01' },
      traceId: 'trace-1',
      record: true,
      entry: { costUsd: 0.02 },
    });

    const verdict = checkRunCap(rc, 0.001);
    expect(verdict.blocked).toBe(true);
    expect(verdict.warn).toBe(false);
    expect(verdict.cap).toBe(0.01);
    expect(verdict.spent).toBeCloseTo(0.02, 10);
    expect(verdict.runId).toBe('cap-1');

    const store = getRunStore();
    expect(store.getRun('cap-1')!.cap_hit_at).not.toBeNull();
    expect(store.listAlerts({ run_id: 'cap-1' }).filter((a) => a.kind === 'run.cap_hit')).toHaveLength(1);

    checkRunCap(rc, 0.001);
    expect(store.listAlerts({ run_id: 'cap-1' }).filter((a) => a.kind === 'run.cap_hit')).toHaveLength(1);
  });

  it('warns instead of blocking when runCapAction is warn', () => {
    configureRunAttribution({ runCapAction: 'warn' });
    const rc = fire({
      headers: { 'x-relayplane-run': 'cap-2', 'x-relayplane-run-cap-usd': '0.01' },
      traceId: 'trace-1',
      record: true,
      entry: { costUsd: 0.02 },
    });
    const verdict = checkRunCap(rc, 0.001);
    expect(verdict.blocked).toBe(false);
    expect(verdict.warn).toBe(true);
  });

  it('passes a request that stays under the cap, and no cap at all', () => {
    const under = fire({
      headers: { 'x-relayplane-run': 'cap-3', 'x-relayplane-run-cap-usd': '1' },
      traceId: 'trace-1',
      record: true,
      entry: { costUsd: 0.02 },
    });
    expect(checkRunCap(under, 0.01)).toMatchObject({ blocked: false, warn: false, cap: 1 });

    const uncapped = fire({ headers: { 'x-relayplane-run': 'cap-4' }, now: NOW + 10 });
    expect(checkRunCap(uncapped, 999)).toMatchObject({ blocked: false, cap: null });

    const anonymous = newRunRequestContext({ headers: {} }, NOW);
    expect(checkRunCap(anonymous, 1)).toEqual({ blocked: false, warn: false, spent: 0, cap: null, runId: null });
  });

  it('applies attribution.defaultRunCapUsd when no header is present', () => {
    configureRunAttribution({ defaultRunCapUsd: 0.005 });
    const rc = fire({ headers: { 'x-relayplane-run': 'cap-5' }, traceId: 'trace-1', record: true, entry: { costUsd: 0.006 } });
    expect(getRunStore().getRun('cap-5')!.cap_usd).toBe(0.005);
    expect(checkRunCap(rc, 0.001).blocked).toBe(true);
  });

  it('adds the four response headers inside a run context', () => {
    const rc = fire({ headers: { 'x-relayplane-run': 'r1' }, traceId: 'trace-1', record: true, entry: { costUsd: 0.125 } });
    const headers = runCtx.run(rc, () => withRunHeaders({ 'content-type': 'application/json' }));
    expect(headers).toEqual({
      'content-type': 'application/json',
      'X-RelayPlane-Run-Id': 'r1',
      'X-RelayPlane-Run-Source': 'header',
      'X-RelayPlane-Run-Cost-Usd': '0.125000',
      'X-RelayPlane-Run-Band': 'none',
    });
    expect(withRunHeaders({ 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' });
  });
});

describe('lifecycle', () => {
  it('closes idle runs as stale_closed with an info alert, and reopens on a later request', () => {
    fire({ headers: { 'x-relayplane-run': 'r1' }, traceId: 'trace-1', record: true });
    expect(sweepIdleRuns(NOW + 599_000)).toEqual([]);

    const closed = sweepIdleRuns(NOW + 601_000);
    expect(closed.map((r) => r.run_id)).toEqual(['r1']);
    const store = getRunStore();
    expect(store.getRun('r1')!.status).toBe('stale_closed');
    const alerts = store.listAlerts({ run_id: 'r1' });
    expect(alerts[0].kind).toBe('run.stale_closed');
    expect(alerts[0].severity).toBe('info');

    const reopened = fire({ headers: { 'x-relayplane-run': 'r1' }, now: NOW + 602_000 });
    expect(reopened.runId).toBe('r1');
    const run = store.getRun('r1')!;
    expect(run.status).toBe('running');
    expect(run.reopen_count).toBe(1);
    expect(run.ended_at).toBeNull();
  });

  it('ends a run as failed on a nonzero exit code', () => {
    fire({ headers: { 'x-relayplane-run': 'r1' } });
    const failed = endRun('r1', { exitCode: 2, now: NOW + 100 });
    expect(failed!.status).toBe('failed');
    expect(failed!.exit_code).toBe(2);

    fire({ headers: { 'x-relayplane-run': 'r2' } });
    expect(endRun('r2', { exitCode: 0 })!.status).toBe('completed');
    fire({ headers: { 'x-relayplane-run': 'r3' } });
    expect(endRun('r3')!.status).toBe('completed');
    expect(endRun('missing')).toBeNull();
  });

  it('registers a run over HTTP, minting an id when none is given', () => {
    const minted = registerRun({ label: 'nightly', tags: { env: 'prod' }, cap_usd: 5 });
    expect('run' in minted).toBe(true);
    if (!('run' in minted)) return;
    expect(minted.run.run_id).toMatch(/^nightly-\d{8}-[0-9a-f]{6}$/);
    expect(minted.run.label).toBe('nightly');
    expect(minted.run.cap_usd).toBe(5);
    expect(minted.run.run_source).toBe('header');
    expect(minted.run.tags).toEqual({ env: 'prod' });

    const explicit = registerRun({ run_id: 'given/child' });
    expect('run' in explicit && explicit.run.parent_run_id).toBe('given');
    expect(registerRun({ run_id: 'bad id' })).toEqual({ error: 'invalid run_id' });
    expect(registerRun({ run_id: 'ok', parent_run_id: 'bad parent' })).toEqual({ error: 'invalid parent_run_id' });
    expect(registerRun({ run_id: 'ok', cap_usd: -1 })).toEqual({ error: 'invalid cap_usd' });
  });

  it('starts and stops the timers idempotently', () => {
    startRunAttributionTimers();
    startRunAttributionTimers();
    stopRunAttributionTimers();
    stopRunAttributionTimers();
    expect(getAttributionConfig().idleCloseSeconds).toBe(600);
  });
});
