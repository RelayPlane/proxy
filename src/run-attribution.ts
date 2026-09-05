/**
 * Run attribution (PR1).
 *
 * One request-scoped context (AsyncLocalStorage) carries the run identity from
 * the server callback all the way to the history write, so every request lands
 * in the run ledger exactly once, keyed by trace id.
 *
 * Degradation ladder for the run id:
 *   A `header`       X-RelayPlane-Run
 *   C `inferred_cc`  x-claude-code-session-id -> `cc-<session>`
 *   D `inferred_gap` client fingerprint + idle gap -> `gap-<clientKey>-<yyyymmddhhmm>`
 *
 * Nothing here may ever throw into a request path: attribution is observability,
 * not a dependency of the proxy.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';

import { sha256Hex } from './trace-writer.js';
import { estimateCost } from './telemetry.js';
import {
  getRunStore,
  nearestRankPercentile,
  _resetRunStore,
  type BandStatus,
  type CacheState,
  type LabelStatsRow,
  type RetryReason,
  type RunAgentRow,
  type RunAlertRow,
  type RunRequestRow,
  type RunRow,
  type RunSource,
  type RunStatus,
} from './run-store.js';

// ---------------------------------------------------------------------------
// Header contract
// ---------------------------------------------------------------------------

export const RUN_REQUEST_HEADERS = [
  'X-RelayPlane-Run',
  'X-RelayPlane-Agent',
  'X-RelayPlane-Parent-Run',
  'X-RelayPlane-Run-Label',
  'X-RelayPlane-Tags',
  'X-RelayPlane-Attempt',
  'X-RelayPlane-Run-Cap-Usd',
  'X-RelayPlane-Run-End',
] as const;

export const RUN_RESPONSE_HEADERS = [
  'X-RelayPlane-Run-Id',
  'X-RelayPlane-Run-Source',
  'X-RelayPlane-Run-Cost-Usd',
  'X-RelayPlane-Run-Band',
] as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AttributionConfig {
  enabled: boolean;
  inferRuns: boolean;
  inferThreads: boolean;
  idleCloseSeconds: number;
  retentionDays: number;
  rollupRetentionDays: number;
  defaultRunCapUsd: number | null;
  runCapAction: 'block' | 'warn';
  rateLimitWave: { enabled: boolean; count: number; windowSeconds: number };
  bands: Record<string, { cold?: [number, number]; warm?: [number, number] }>;
  alerts: { webhookUrl: string | null; overBand: boolean; runCostUsd: number | null; modelDrift: boolean };
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  enabled: true,
  inferRuns: true,
  inferThreads: true,
  idleCloseSeconds: 600,
  retentionDays: 30,
  rollupRetentionDays: 365,
  defaultRunCapUsd: null,
  runCapAction: 'block',
  rateLimitWave: { enabled: true, count: 5, windowSeconds: 60 },
  bands: {},
  alerts: { webhookUrl: null, overBand: true, runCostUsd: null, modelDrift: true },
};

export function resolveAttributionConfig(partial: Partial<AttributionConfig> | undefined): AttributionConfig {
  const d = DEFAULT_ATTRIBUTION_CONFIG;
  const p = partial ?? {};
  return {
    enabled: p.enabled ?? d.enabled,
    inferRuns: p.inferRuns ?? d.inferRuns,
    inferThreads: p.inferThreads ?? d.inferThreads,
    idleCloseSeconds: p.idleCloseSeconds ?? d.idleCloseSeconds,
    retentionDays: p.retentionDays ?? d.retentionDays,
    rollupRetentionDays: p.rollupRetentionDays ?? d.rollupRetentionDays,
    defaultRunCapUsd: p.defaultRunCapUsd === undefined ? d.defaultRunCapUsd : p.defaultRunCapUsd,
    runCapAction: p.runCapAction ?? d.runCapAction,
    rateLimitWave: {
      enabled: p.rateLimitWave?.enabled ?? d.rateLimitWave.enabled,
      count: p.rateLimitWave?.count ?? d.rateLimitWave.count,
      windowSeconds: p.rateLimitWave?.windowSeconds ?? d.rateLimitWave.windowSeconds,
    },
    bands: p.bands ? { ...p.bands } : { ...d.bands },
    alerts: {
      webhookUrl: p.alerts?.webhookUrl === undefined ? d.alerts.webhookUrl : p.alerts.webhookUrl,
      overBand: p.alerts?.overBand ?? d.alerts.overBand,
      runCostUsd: p.alerts?.runCostUsd === undefined ? d.alerts.runCostUsd : p.alerts.runCostUsd,
      modelDrift: p.alerts?.modelDrift ?? d.alerts.modelDrift,
    },
  };
}

interface AttributionDeps {
  log?: (msg: string) => void;
  resolveAgentName?: (fingerprint: string) => string | undefined;
  forwardAlert?: (alert: RunAlertRow) => void;
}

let _config: AttributionConfig = resolveAttributionConfig(undefined);
let _deps: AttributionDeps = {};

/** Idempotent and hot-reload safe: deps that are not supplied are preserved. */
export function configureRunAttribution(
  cfg: Partial<AttributionConfig> | undefined,
  deps?: AttributionDeps,
): void {
  _config = resolveAttributionConfig(cfg);
  if (deps) {
    if (deps.log !== undefined) _deps.log = deps.log;
    if (deps.resolveAgentName !== undefined) _deps.resolveAgentName = deps.resolveAgentName;
    if (deps.forwardAlert !== undefined) _deps.forwardAlert = deps.forwardAlert;
  }
}

export function getAttributionConfig(): AttributionConfig {
  return _config;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export interface ParsedRunHeaders {
  runId?: string;
  invalidRunId?: string;
  agent?: string;
  parentRunId?: string;
  label?: string;
  tags: Record<string, string>;
  attempt?: number;
  capUsd?: number;
  end: boolean;
  claudeCodeSessionId?: string;
  xAgentId?: string;
}

export interface RunRequestContext {
  createdAt: number;
  headers: ParsedRunHeaders;
  clientKey: string;
  runId?: string;
  runSource?: RunSource;
  parentRunId?: string | null;
  depth: number;
  label?: string | null;
  tags: Record<string, string>;
  agentLabel?: string;
  agentSource?: 'header' | 'inferred';
  agentFingerprint?: string;
  threadId?: string;
  sessionId?: string;
  sessionSource?: string;
  attempt: number;
  isRetry: boolean;
  retryReason?: RetryReason;
  capUsd?: number | null;
  endAfter: boolean;
  traceId?: string;
  requestedModel?: string;
  lastUserMessageHash?: string;
  historyEntry?: RunHistoryEntryLike;
}

/** Structural mirror of standalone-proxy's RequestHistoryEntry (plus the run fields). */
export interface RunHistoryEntryLike {
  id: string;
  originalModel: string;
  targetModel: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  timestamp: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costEstimated?: boolean;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  taskType?: string;
  complexity?: string;
  responseModel?: string;
  statusCode?: number;
  runId?: string;
  parentRunId?: string;
  agentLabel?: string;
  threadId?: string;
  runSource?: string;
  traceId?: string;
  sessionId?: string;
  attempt?: number;
  isRetry?: boolean;
  tags?: Record<string, string>;
}

export const runCtx = new AsyncLocalStorage<RunRequestContext>();

// ---------------------------------------------------------------------------
// Module state (all bounded, all cleared by _resetRunAttributionForTests)
// ---------------------------------------------------------------------------

const MAX_MAP_ENTRIES = 5000;
const RETRY_WINDOW_MS = 120_000;
const BASELINE_MODEL = 'claude-opus-4-6';
/** Rate-limit ring depth and the per-run re-alert cooldown for the 429 wave. */
const WAVE_RING_SIZE = 50;
const WAVE_COOLDOWN_MS = 300_000;
/** Label stats are always computed over the trailing 30 days. */
export const LABEL_STATS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const gapRuns = new Map<string, { runId: string; lastSeen: number }>();
const lastPromptByThread = new Map<string, { hash: string; ts: number }>();
const baselineByTrace = new Map<string, number>();
const cacheTallyByRun = new Map<string, { cold: number; warm: number }>();
/** Last 50 rate-limited failures per run, newest last. */
const rateLimitRingByRun = new Map<string, { ts: number; agent_label: string }[]>();
const waveFiredAtByRun = new Map<string, number>();
let lastInvalidRunLogAt = 0;

let idleTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_MAP_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const RUN_ID_CHARSET = /^[\w\-.:@/]+$/;
const SESSION_ID_CHARSET = /^[\w\-.:@]+$/;
const PRINTABLE = /^[ -~]+$/;
const MAX_RUN_ID_LEN = 128;
const MAX_AGENT_LEN = 64;
const MAX_LABEL_LEN = 80;
const MAX_DEPTH = 8;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function headerBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Validate and normalize a run id. `/` nests: the parent is every segment but
 * the last, depth is the number of separators, capped at 8 by dropping LEADING
 * segments (the tail is the interesting part). Returns null for invalid input.
 */
export function normalizeRunId(raw: string): { runId: string; parentRunId: string | null; depth: number } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RUN_ID_LEN) return null;
  if (!RUN_ID_CHARSET.test(trimmed)) return null;
  const segments = trimmed.split('/');
  if (segments.some((s) => s.length === 0)) return null;
  const kept = segments.length > MAX_DEPTH + 1 ? segments.slice(segments.length - (MAX_DEPTH + 1)) : segments;
  const runId = kept.join('/');
  const parentRunId = kept.length > 1 ? kept.slice(0, -1).join('/') : null;
  return { runId, parentRunId, depth: kept.length - 1 };
}

/** LiteLLM style `k:v,k:v`. Max 10 pairs, 64 chars per side, values are trimmed. */
export function parseTags(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    if (Object.keys(out).length >= 10) break;
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim().slice(0, 64);
    const value = pair.slice(idx + 1).trim().slice(0, 64);
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function formatTags(tags: Record<string, string>): string {
  return Object.entries(tags).map(([k, v]) => `${k}:${v}`).join(',');
}

export function computeThreadId(systemPrompt: string | undefined, firstUserMessageText: string): string {
  return sha256Hex(sha256Hex(systemPrompt ?? '') + sha256Hex(firstUserMessageText)).slice(0, 16);
}

export function computeClientKey(headers: http.IncomingHttpHeaders): string {
  const userAgent = headerValue(headers, 'user-agent') ?? '';
  const xApp = headerValue(headers, 'x-app') ?? '';
  const secret = headerValue(headers, 'authorization') ?? headerValue(headers, 'x-api-key') ?? '';
  return sha256Hex(userAgent + xApp + sha256Hex(secret).slice(0, 16)).slice(0, 8);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw);
      continue;
    }
    const block = asRecord(raw);
    if (!block) continue;
    const text = block['text'];
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/** First and last user message text, for Anthropic and OpenAI shaped bodies. */
export function extractUserMessages(body: Record<string, unknown>): { first: string; last: string } {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return { first: '', last: '' };
  const texts: string[] = [];
  for (const raw of messages) {
    const msg = asRecord(raw);
    if (!msg || msg['role'] !== 'user') continue;
    const text = contentToText(msg['content']);
    if (text.length > 0) texts.push(text);
  }
  if (texts.length === 0) return { first: '', last: '' };
  return { first: texts[0], last: texts[texts.length - 1] };
}

/**
 * `tokensIn` is the NON-cache input token count, so callers pass
 * `entry.tokensIn - cacheRead - cacheCreation`.
 */
export function cacheStateFor(tokensIn: number, cacheRead: number): 'cold' | 'warm' {
  const total = Math.max(0, tokensIn) + Math.max(0, cacheRead);
  if (total <= 0) return 'cold';
  return cacheRead / total >= 0.5 ? 'warm' : 'cold';
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function yyyymmdd(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function yyyymmddhhmm(now: number): string {
  const d = new Date(now);
  return `${yyyymmdd(now)}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}

export function mintRunId(label?: string, now?: number): string {
  const at = now ?? Date.now();
  const base = label && label.length > 0 ? label : 'run';
  return `${base}-${yyyymmdd(at)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export function parseRunHeaders(headers: http.IncomingHttpHeaders): ParsedRunHeaders {
  const parsed: ParsedRunHeaders = { tags: {}, end: false };

  const rawRun = headerValue(headers, 'x-relayplane-run');
  if (rawRun) {
    const normalized = normalizeRunId(rawRun);
    if (normalized) parsed.runId = normalized.runId;
    else parsed.invalidRunId = rawRun.slice(0, MAX_RUN_ID_LEN);
  }

  const rawAgent = headerValue(headers, 'x-relayplane-agent');
  if (rawAgent && PRINTABLE.test(rawAgent)) parsed.agent = rawAgent.slice(0, MAX_AGENT_LEN);

  const rawParent = headerValue(headers, 'x-relayplane-parent-run');
  if (rawParent) {
    const normalized = normalizeRunId(rawParent);
    if (normalized) parsed.parentRunId = normalized.runId;
  }

  const rawLabel = headerValue(headers, 'x-relayplane-run-label');
  if (rawLabel && PRINTABLE.test(rawLabel)) parsed.label = rawLabel.slice(0, MAX_LABEL_LEN);

  parsed.tags = parseTags(headerValue(headers, 'x-relayplane-tags'));

  const rawAttempt = headerValue(headers, 'x-relayplane-attempt');
  if (rawAttempt) {
    const attempt = Number.parseInt(rawAttempt, 10);
    if (Number.isInteger(attempt) && attempt >= 1 && attempt <= 999) parsed.attempt = attempt;
  }

  const rawCap = headerValue(headers, 'x-relayplane-run-cap-usd');
  if (rawCap) {
    const cap = Number.parseFloat(rawCap);
    if (Number.isFinite(cap) && cap > 0) parsed.capUsd = cap;
  }

  parsed.end = headerBoolean(headerValue(headers, 'x-relayplane-run-end'));

  const sessionId = headerValue(headers, 'x-claude-code-session-id');
  if (sessionId) parsed.claudeCodeSessionId = sessionId.slice(0, MAX_RUN_ID_LEN);

  const agentId = headerValue(headers, 'x-agent-id');
  if (agentId && PRINTABLE.test(agentId)) parsed.xAgentId = agentId.slice(0, MAX_AGENT_LEN);

  return parsed;
}

export function newRunRequestContext(req: Pick<http.IncomingMessage, 'headers'>, now?: number): RunRequestContext {
  const at = now ?? Date.now();
  const headers = parseRunHeaders(req.headers);
  return {
    createdAt: at,
    headers,
    clientKey: computeClientKey(req.headers),
    depth: 0,
    tags: { ...headers.tags },
    attempt: headers.attempt ?? 1,
    isRetry: false,
    endAfter: headers.end,
  };
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

function logOnce(message: string, now: number): void {
  if (now - lastInvalidRunLogAt < 60_000) return;
  lastInvalidRunLogAt = now;
  const log = _deps.log ?? ((msg: string) => console.warn(msg));
  try { log(message); } catch { /* logging must never throw */ }
}

function gapRunIdFor(clientKey: string, now: number, idleCloseSeconds: number): string {
  const existing = gapRuns.get(clientKey);
  if (existing && now - existing.lastSeen < idleCloseSeconds * 1000) {
    setBounded(gapRuns, clientKey, { runId: existing.runId, lastSeen: now });
    return existing.runId;
  }
  const runId = `gap-${clientKey}-${yyyymmddhhmm(now)}`;
  setBounded(gapRuns, clientKey, { runId, lastSeen: now });
  return runId;
}

function inferAgentLabel(threadId: string, fingerprint: string | undefined): string {
  let base: string | undefined;
  if (fingerprint) {
    try { base = _deps.resolveAgentName?.(fingerprint); } catch { base = undefined; }
    if (!base) base = `agent-${fingerprint.slice(0, 8)}`;
  }
  return `${base ?? 'unknown'}/t-${threadId.slice(0, 4)}`;
}

export function attachRunIdentity(
  rc: RunRequestContext,
  opts: {
    sessionId: string;
    sessionSource: string;
    systemPrompt?: string;
    agentFingerprint?: string;
    explicitAgentId?: string;
    body: Record<string, unknown>;
    requestedModel?: string;
    now?: number;
  },
): RunRequestContext {
  const cfg = _config;
  if (!cfg.enabled) return rc;

  const now = opts.now ?? Date.now();
  const h = rc.headers;

  rc.sessionId = opts.sessionId;
  rc.sessionSource = opts.sessionSource;
  if (opts.agentFingerprint) rc.agentFingerprint = opts.agentFingerprint;
  if (opts.requestedModel) rc.requestedModel = opts.requestedModel;

  if (h.invalidRunId) {
    logOnce(`[RelayPlane] ignoring invalid X-RelayPlane-Run: ${h.invalidRunId}`, now);
  }

  // Run id ladder.
  let runId: string;
  let runSource: RunSource;
  let parentRunId: string | null = null;
  let depth = 0;
  if (h.runId) {
    const normalized = normalizeRunId(h.runId);
    if (!normalized) return rc;
    runId = normalized.runId;
    parentRunId = normalized.parentRunId;
    depth = normalized.depth;
    runSource = 'header';
  } else if (cfg.inferRuns && h.claudeCodeSessionId && SESSION_ID_CHARSET.test(h.claudeCodeSessionId)) {
    runId = `cc-${h.claudeCodeSessionId}`;
    runSource = 'inferred_cc';
  } else if (cfg.inferRuns) {
    runId = gapRunIdFor(rc.clientKey, now, cfg.idleCloseSeconds);
    runSource = 'inferred_gap';
  } else {
    return rc;
  }

  if (h.parentRunId) {
    parentRunId = h.parentRunId;
    if (depth === 0) depth = 1;
  }

  const messages = extractUserMessages(opts.body);
  const threadId = cfg.inferThreads ? computeThreadId(opts.systemPrompt, messages.first) : 'main';

  let agentLabel: string;
  let agentSource: 'header' | 'inferred';
  const headerAgent = h.agent ?? h.xAgentId ?? opts.explicitAgentId;
  if (headerAgent) {
    agentLabel = headerAgent;
    agentSource = 'header';
  } else {
    agentLabel = inferAgentLabel(threadId, opts.agentFingerprint);
    agentSource = 'inferred';
  }
  agentLabel = agentLabel.slice(0, MAX_AGENT_LEN);

  // Retry inference.
  const store = getRunStore();
  const attempt = h.attempt ?? 1;
  const lastHash = sha256Hex(messages.last);
  const threadKey = `${runId}|${threadId}`;
  let isRetry = false;
  let retryReason: RetryReason | undefined;
  if (attempt > 1) {
    isRetry = true;
    retryReason = 'header';
  } else {
    let prev: RunRequestRow | null = null;
    try { prev = store.lastRequestOnThread(runId, threadId); } catch { prev = null; }
    if (prev && now - prev.ts <= RETRY_WINDOW_MS) {
      const prevPrompt = lastPromptByThread.get(threadKey);
      if (prev.status_code === 429 || prev.status_code === 529) {
        isRetry = true;
        retryReason = 'after_429';
      } else if (prev.success === 0) {
        isRetry = true;
        retryReason = 'after_error';
      } else if (prevPrompt && now - prevPrompt.ts <= RETRY_WINDOW_MS && prevPrompt.hash === lastHash) {
        isRetry = true;
        retryReason = 'same_prompt';
      }
    }
  }

  const capUsd = h.capUsd ?? cfg.defaultRunCapUsd;

  try {
    store.openRun({
      run_id: runId,
      parent_run_id: parentRunId,
      depth,
      label: h.label ?? null,
      run_source: runSource,
      tags: h.tags,
      cap_usd: capUsd,
      client_key: rc.clientKey,
      now,
    });
  } catch { /* storage is best effort */ }

  rc.runId = runId;
  rc.runSource = runSource;
  rc.parentRunId = parentRunId;
  rc.depth = depth;
  rc.label = h.label ?? null;
  rc.tags = { ...h.tags };
  rc.agentLabel = agentLabel;
  rc.agentSource = agentSource;
  rc.threadId = threadId;
  rc.attempt = attempt;
  rc.isRetry = isRetry;
  if (retryReason) rc.retryReason = retryReason;
  rc.capUsd = capUsd;
  rc.lastUserMessageHash = lastHash;

  setBounded(lastPromptByThread, threadKey, { hash: lastHash, ts: now });

  return rc;
}

export function setRunTraceId(traceId: string): void {
  const rc = runCtx.getStore();
  if (rc) rc.traceId = traceId;
}

export function stampRunFields(entry: RunHistoryEntryLike, rc: RunRequestContext): void {
  if (!rc.runId) return;
  entry.runId = rc.runId;
  entry.parentRunId = rc.parentRunId ?? undefined;
  if (rc.agentLabel) entry.agentLabel = rc.agentLabel;
  if (rc.threadId) entry.threadId = rc.threadId;
  if (rc.runSource) entry.runSource = rc.runSource;
  if (rc.traceId) entry.traceId = rc.traceId;
  if (rc.sessionId) entry.sessionId = rc.sessionId;
  entry.attempt = rc.attempt;
  entry.isRetry = rc.isRetry;
  if (Object.keys(rc.tags).length > 0) entry.tags = { ...rc.tags };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function deliverAlert(alert: RunAlertRow): void {
  try { _deps.forwardAlert?.(alert); } catch { /* never throws into a request */ }
  const url = _config.alerts.webhookUrl;
  if (!url) {
    if (_deps.forwardAlert) {
      try { getRunStore().markAlertDelivered(alert.id); } catch { /* best effort */ }
    }
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  if (typeof timer.unref === 'function') timer.unref();
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(alert),
    signal: controller.signal,
  })
    .then((res) => {
      if (res.ok) {
        try { getRunStore().markAlertDelivered(alert.id); } catch { /* best effort */ }
      }
    })
    .catch(() => { /* one shot, no retry */ })
    .finally(() => { clearTimeout(timer); });
}

function updateCacheState(run: RunRow, row: RunRequestRow, prev: RunRequestRow | null): void {
  if (row.cache_state === null) return;
  const tally = cacheTallyByRun.get(run.run_id) ?? { cold: 0, warm: 0 };
  tally[row.cache_state] += row.cost_usd - (prev ? prev.cost_usd : 0);
  setBounded(cacheTallyByRun, run.run_id, tally);
  const total = tally.cold + tally.warm;
  if (total <= 0) return;
  let state: CacheState = 'mixed';
  if (tally.warm / total >= 0.65) state = 'warm';
  else if (tally.cold / total >= 0.65) state = 'cold';
  if (run.cache_state !== state) {
    getRunStore().setCacheState(run.run_id, state);
    run.cache_state = state;
  }
}

// ---------------------------------------------------------------------------
// Evaluators: bands (4.5), 429 wave (4.7), drift (4.8)
// ---------------------------------------------------------------------------

/**
 * Configured band for a run: `bands[label]` first, then the `"*"` fallback.
 * A warm run reads the `warm` pair, everything else reads `cold`.
 */
export function bandForRun(run: Pick<RunRow, 'label' | 'cache_state'>): [number, number] | null {
  const bands = _config.bands;
  const entry = (run.label !== null ? bands[run.label] : undefined) ?? bands['*'];
  if (!entry) return null;
  const pair = run.cache_state === 'warm' ? entry.warm : entry.cold;
  if (!pair) return null;
  const [lo, hi] = pair;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  return [lo, hi];
}

/** `[p25, p75]` from a stats row, or null while the sample is still too small. */
export function suggestedBands(stats: LabelStatsRow | null): [number, number] | null {
  if (!stats || stats.p25 === null || stats.p75 === null) return null;
  return [stats.p25, stats.p75];
}

/** Highest request_count model per agent label, across one run's agents. */
export function dominantModels(agents: RunAgentRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  const best = new Map<string, { model: string; count: number }>();
  for (const agent of agents) {
    for (const [model, count] of Object.entries(agent.models_seen)) {
      const current = best.get(agent.agent_label);
      if (!current || count > current.count || (count === current.count && model < current.model)) {
        best.set(agent.agent_label, { model, count });
      }
    }
  }
  for (const [label, pick] of best) out[label] = pick.model;
  return out;
}

/** Live band evaluation, on every recorded request. */
function evaluateBands(run: RunRow, agentLabel: string, ts: number): void {
  const band = bandForRun(run);
  if (!band) return;
  const [lo, hi] = band;
  const store = getRunStore();
  let status: BandStatus = run.band_status;
  let crossed = false;
  if (run.cost_usd > hi) {
    if (status !== 'over') {
      status = 'over';
      crossed = true;
    }
  } else if (run.cost_usd >= lo && (status === 'none' || status === 'under')) {
    status = 'in';
  }
  store.setBandStatus(run.run_id, status, lo, hi);
  run.band_status = status;
  run.band_lo = lo;
  run.band_hi = hi;
  if (!crossed || !_config.alerts.overBand) return;
  if (store.hasAlert(run.run_id, 'run.over_band')) return;
  deliverAlert(
    store.addAlert({
      ts,
      kind: 'run.over_band',
      run_id: run.run_id,
      agent_label: agentLabel,
      severity: 'warning',
      message: `Run ${run.run_id} is over its expected band: $${run.cost_usd.toFixed(4)} vs $${lo}-$${hi}`,
      data: { run_id: run.run_id, cost_usd: run.cost_usd, band_lo: lo, band_hi: hi, label: run.label },
    }),
  );
}

/** Rate-limited failures feed a bounded per-run ring, newest last. */
function pushRateLimitEvent(runId: string, agentLabel: string, ts: number): void {
  const ring = rateLimitRingByRun.get(runId) ?? [];
  ring.push({ ts, agent_label: agentLabel });
  while (ring.length > WAVE_RING_SIZE) ring.shift();
  setBounded(rateLimitRingByRun, runId, ring);
}

function waveWindow(runId: string, now: number): { ts: number; agent_label: string }[] {
  const ring = rateLimitRingByRun.get(runId);
  if (!ring) return [];
  const cutoff = now - _config.rateLimitWave.windowSeconds * 1000;
  return ring.filter((e) => e.ts >= cutoff);
}

/** True while the configured count of 429/529s sits inside the configured window. */
export function isRateLimitWave(runId: string, now?: number): boolean {
  if (!_config.rateLimitWave.enabled) return false;
  return waveWindow(runId, now ?? Date.now()).length >= _config.rateLimitWave.count;
}

function evaluateRateLimitWave(run: RunRow, row: RunRequestRow): void {
  if (!_config.rateLimitWave.enabled) return;
  if (row.success === 1) return;
  if (row.status_code !== 429 && row.status_code !== 529) return;
  pushRateLimitEvent(run.run_id, row.agent_label, row.ts);
  const inWindow = waveWindow(run.run_id, row.ts);
  if (inWindow.length < _config.rateLimitWave.count) return;
  const lastFired = waveFiredAtByRun.get(run.run_id);
  if (lastFired !== undefined && row.ts - lastFired < WAVE_COOLDOWN_MS) return;
  setBounded(waveFiredAtByRun, run.run_id, row.ts);
  const agentsAffected = [...new Set(inWindow.map((e) => e.agent_label))];
  const store = getRunStore();
  deliverAlert(
    store.addAlert({
      ts: row.ts,
      kind: 'run.rate_limit_wave',
      run_id: run.run_id,
      agent_label: row.agent_label,
      severity: 'warning',
      message: `Run ${run.run_id} hit ${inWindow.length} rate limits in ${_config.rateLimitWave.windowSeconds}s`,
      data: {
        run_id: run.run_id,
        count: inWindow.length,
        window: _config.rateLimitWave.windowSeconds,
        agents_affected: agentsAffected,
        cost_so_far: run.cost_usd,
      },
    }),
  );
}

function evaluateRunCost(run: RunRow, agentLabel: string, ts: number): void {
  const threshold = _config.alerts.runCostUsd;
  if (threshold === null || run.cost_usd < threshold) return;
  const store = getRunStore();
  if (store.hasAlert(run.run_id, 'run.cost_exceeded')) return;
  deliverAlert(
    store.addAlert({
      ts,
      kind: 'run.cost_exceeded',
      run_id: run.run_id,
      agent_label: agentLabel,
      severity: 'warning',
      message: `Run ${run.run_id} crossed $${threshold.toFixed(2)}, now $${run.cost_usd.toFixed(4)}`,
      data: { run_id: run.run_id, cost_usd: run.cost_usd, threshold, request_count: run.request_count },
    }),
  );
}

/** Every per-request evaluator, in the order the plan lists them. */
function evaluateRunSignals(
  run: RunRow,
  agent: { agent_label: string },
  row: RunRequestRow,
  prev: RunRequestRow | null,
): void {
  evaluateRunCost(run, agent.agent_label, row.ts);
  evaluateBands(run, agent.agent_label, row.ts);
  evaluateRateLimitWave(run, row);
  void prev;
}

/**
 * Cross-run model drift: this run's per-agent dominant model against the
 * previous window's. Fired BEFORE label_stats is overwritten.
 */
function evaluateModelDrift(
  run: RunRow,
  cacheKey: string,
  dominant: Record<string, string>,
  now: number,
): void {
  if (!_config.alerts.modelDrift) return;
  const store = getRunStore();
  const previous = store.getLabelStats(run.label ?? '', cacheKey, LABEL_STATS_WINDOW_DAYS);
  if (!previous) return;
  for (const [agentLabel, model] of Object.entries(dominant)) {
    const from = previous.dominant_models[agentLabel];
    if (!from || from === model) continue;
    deliverAlert(
      store.addAlert({
        ts: now,
        kind: 'run.model_drift',
        run_id: run.run_id,
        agent_label: agentLabel,
        severity: 'info',
        message: `Agent ${agentLabel} in ${run.label ?? run.run_id} moved from ${from} to ${model}`,
        data: { run_id: run.run_id, label: run.label, agent_label: agentLabel, from, to: model },
      }),
    );
  }
}

/**
 * Rebuild `label_stats` for every cache state of this run's label from the
 * completed runs of the last 30 days. `n` and `dominant_models` are written
 * from the first run onward; the percentiles need `n >= 5` to mean anything.
 */
function rebuildLabelStats(run: RunRow, dominant: Record<string, string>, now: number): void {
  const label = run.label;
  if (!label) return;
  const store = getRunStore();
  const cacheKey = run.cache_state ?? 'cold';
  const grouped = new Map<string, number[]>();
  for (const completed of store.completedRunsForLabel(label, now - LABEL_STATS_WINDOW_DAYS * DAY_MS)) {
    const key = completed.cache_state ?? 'cold';
    const bucket = grouped.get(key) ?? [];
    bucket.push(completed.cost_usd);
    grouped.set(key, bucket);
  }
  if (!grouped.has(cacheKey)) grouped.set(cacheKey, [run.cost_usd]);
  for (const [key, costs] of grouped) {
    costs.sort((a, b) => a - b);
    const enough = costs.length >= 5;
    const existing = store.getLabelStats(label, key, LABEL_STATS_WINDOW_DAYS);
    store.upsertLabelStats({
      label,
      cache_state: key,
      window_days: LABEL_STATS_WINDOW_DAYS,
      n: costs.length,
      p25: enough ? nearestRankPercentile(costs, 25) : null,
      p50: enough ? nearestRankPercentile(costs, 50) : null,
      p75: enough ? nearestRankPercentile(costs, 75) : null,
      p90: enough ? nearestRankPercentile(costs, 90) : null,
      dominant_models: key === cacheKey ? dominant : (existing?.dominant_models ?? {}),
      updated_at: now,
    });
  }
}

/**
 * Shared close path for `endRun` and `sweepIdleRuns`: under-band check, then
 * cross-run drift, then the label_stats rebuild.
 */
function onRunClosed(run: RunRow, now: number): void {
  try {
    const store = getRunStore();
    const band = bandForRun(run);
    if (band && run.cost_usd < band[0]) {
      const [lo, hi] = band;
      store.setBandStatus(run.run_id, 'under', lo, hi);
      run.band_status = 'under';
      run.band_lo = lo;
      run.band_hi = hi;
      if (_config.alerts.overBand && !store.hasAlert(run.run_id, 'run.under_band')) {
        deliverAlert(
          store.addAlert({
            ts: now,
            kind: 'run.under_band',
            run_id: run.run_id,
            agent_label: null,
            severity: 'info',
            message: `Run ${run.run_id} came in under its expected band ($${run.cost_usd.toFixed(4)} vs $${lo}), something was skipped`,
            data: { run_id: run.run_id, cost_usd: run.cost_usd, band_lo: lo, band_hi: hi, label: run.label },
          }),
        );
      }
    }
    if (!run.label) return;
    const dominant = dominantModels(store.agentsForRun(run.run_id));
    evaluateModelDrift(run, run.cache_state ?? 'cold', dominant, now);
    rebuildLabelStats(run, dominant, now);
  } catch { /* closing a run must never throw into a request or a timer */ }
}

export function recordRunRequest(entry: RunHistoryEntryLike, rc: RunRequestContext): void {
  try {
    if (!_config.enabled) return;
    const runId = rc.runId;
    const traceId = rc.traceId;
    if (!runId || !traceId) return;

    const store = getRunStore();
    const parsedTs = Date.parse(entry.timestamp);
    const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now();
    const cacheRead = entry.cacheReadTokens ?? 0;
    const cacheCreation = entry.cacheCreationTokens ?? 0;
    const success: 0 | 1 = entry.success ? 1 : 0;

    const row: RunRequestRow = {
      trace_id: traceId,
      run_id: runId,
      agent_label: rc.agentLabel ?? 'unknown',
      thread_id: rc.threadId ?? 'main',
      history_id: entry.id,
      ts,
      model: entry.responseModel ?? entry.targetModel,
      requested_model: entry.originalModel,
      provider: entry.provider,
      attempt: rc.attempt,
      is_retry: rc.isRetry ? 1 : 0,
      retry_reason: rc.retryReason ?? null,
      cache_state: success === 1 ? cacheStateFor(entry.tokensIn - cacheRead - cacheCreation, cacheRead) : null,
      tokens_in: entry.tokensIn,
      tokens_out: entry.tokensOut,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      cost_usd: entry.costUsd,
      cost_estimated: entry.costEstimated ? 1 : 0,
      latency_ms: entry.latencyMs,
      success,
      status_code: entry.statusCode ?? null,
      complexity: entry.complexity ?? null,
      task_type: entry.taskType ?? null,
    };

    const result = store.upsertRequest(row, {
      agent_source: rc.agentSource ?? 'inferred',
      agent_fingerprint: rc.agentFingerprint ?? null,
    });

    if (success === 1) {
      const baseline = estimateCost(
        BASELINE_MODEL,
        row.tokens_in,
        row.tokens_out,
        cacheCreation || undefined,
        cacheRead || undefined,
      );
      const previousBaseline = baselineByTrace.get(traceId) ?? 0;
      store.addBaseline(runId, baseline - previousBaseline);
      setBounded(baselineByTrace, traceId, baseline);
    }

    updateCacheState(result.run, row, result.prev);
    evaluateRunSignals(result.run, result.agent, row, result.prev);

    if (rc.endAfter) endRun(runId);
  } catch { /* attribution never breaks a request */ }
}

// ---------------------------------------------------------------------------
// Caps, headers, lifecycle
// ---------------------------------------------------------------------------

export function checkRunCap(
  rc: RunRequestContext,
  projectedCost: number,
): { blocked: boolean; warn: boolean; spent: number; cap: number | null; runId: string | null } {
  const runId = rc.runId;
  if (!runId) return { blocked: false, warn: false, spent: 0, cap: null, runId: null };
  const store = getRunStore();
  const run = store.getRun(runId);
  if (!run) return { blocked: false, warn: false, spent: 0, cap: null, runId };
  const cap = run.cap_usd;
  if (cap === null) return { blocked: false, warn: false, spent: run.cost_usd, cap: null, runId };
  if (run.cost_usd + projectedCost <= cap) {
    return { blocked: false, warn: false, spent: run.cost_usd, cap, runId };
  }
  const blocked = _config.runCapAction === 'block';
  const now = Date.now();
  if (store.markCapHit(runId, now)) {
    const alert = store.addAlert({
      ts: now,
      kind: 'run.cap_hit',
      run_id: runId,
      agent_label: rc.agentLabel ?? null,
      severity: 'critical',
      message: `Run ${runId} hit its cap: $${run.cost_usd.toFixed(4)} of $${cap.toFixed(4)}`,
      data: { run_id: runId, spent: run.cost_usd, cap, projected: projectedCost, action: _config.runCapAction },
    });
    deliverAlert(alert);
  }
  return { blocked, warn: !blocked, spent: run.cost_usd, cap, runId };
}

export function withRunHeaders<T extends Record<string, string>>(headers: T): T & Record<string, string> {
  const rc = runCtx.getStore();
  if (!rc?.runId) return headers;
  let run: RunRow | null = null;
  try { run = getRunStore().getRun(rc.runId); } catch { run = null; }
  const band: BandStatus = run?.band_status ?? 'none';
  return {
    ...headers,
    'X-RelayPlane-Run-Id': rc.runId,
    'X-RelayPlane-Run-Source': rc.runSource ?? 'header',
    'X-RelayPlane-Run-Cost-Usd': (run?.cost_usd ?? 0).toFixed(6),
    'X-RelayPlane-Run-Band': band,
  };
}

export function endRun(
  runId: string,
  opts?: { exitCode?: number | null; status?: RunStatus; now?: number },
): RunRow | null {
  const exitCode = opts?.exitCode ?? null;
  const status: RunStatus = opts?.status ?? (exitCode !== null && exitCode !== 0 ? 'failed' : 'completed');
  const now = opts?.now ?? Date.now();
  try {
    const run = getRunStore().closeRun(runId, { status, exit_code: exitCode, now });
    if (run) onRunClosed(run, now);
    return run;
  } catch {
    return null;
  }
}

/** POST /v1/runs body handler. Mints an id when none is supplied. */
export function registerRun(input: {
  run_id?: string;
  label?: string;
  parent_run_id?: string;
  tags?: Record<string, string>;
  cap_usd?: number;
}): { run: RunRow } | { error: string } {
  let runId: string;
  let parentRunId: string | null = null;
  let depth = 0;
  if (input.run_id) {
    const normalized = normalizeRunId(input.run_id);
    if (!normalized) return { error: 'invalid run_id' };
    runId = normalized.runId;
    parentRunId = normalized.parentRunId;
    depth = normalized.depth;
  } else {
    runId = mintRunId(input.label);
  }
  if (input.parent_run_id) {
    const normalizedParent = normalizeRunId(input.parent_run_id);
    if (!normalizedParent) return { error: 'invalid parent_run_id' };
    parentRunId = normalizedParent.runId;
    if (depth === 0) depth = 1;
  }
  if (input.label !== undefined && (input.label.length === 0 || input.label.length > MAX_LABEL_LEN)) {
    return { error: 'invalid label' };
  }
  if (input.cap_usd !== undefined && (!Number.isFinite(input.cap_usd) || input.cap_usd <= 0)) {
    return { error: 'invalid cap_usd' };
  }
  try {
    const opened = getRunStore().openRun({
      run_id: runId,
      parent_run_id: parentRunId,
      depth,
      label: input.label ?? null,
      run_source: 'header',
      tags: input.tags ?? {},
      cap_usd: input.cap_usd ?? _config.defaultRunCapUsd,
    });
    return { run: opened.run };
  } catch {
    return { error: 'run store unavailable' };
  }
}

/** Closes every run idle for longer than `idleCloseSeconds` and alerts once each. */
export function sweepIdleRuns(now?: number): RunRow[] {
  const at = now ?? Date.now();
  const closed: RunRow[] = [];
  try {
    const store = getRunStore();
    const cutoff = at - _config.idleCloseSeconds * 1000;
    for (const idle of store.idleRuns(cutoff)) {
      const row = store.closeRun(idle.run_id, { status: 'stale_closed', now: at });
      if (!row) continue;
      closed.push(row);
      onRunClosed(row, at);
      const alert = store.addAlert({
        ts: at,
        kind: 'run.stale_closed',
        run_id: row.run_id,
        agent_label: null,
        severity: 'info',
        message: `Run ${row.run_id} closed after ${_config.idleCloseSeconds}s idle`,
        data: {
          run_id: row.run_id,
          cost_usd: row.cost_usd,
          request_count: row.request_count,
          last_seen_at: row.last_seen_at,
        },
      });
      deliverAlert(alert);
    }
  } catch { /* sweeping is best effort */ }
  return closed;
}

export function startRunAttributionTimers(): void {
  if (idleTimer === null) {
    idleTimer = setInterval(() => { sweepIdleRuns(); }, 60_000);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }
  if (pruneTimer === null) {
    pruneTimer = setInterval(() => {
      try {
        getRunStore().pruneRetention(_config.retentionDays, _config.rollupRetentionDays);
      } catch { /* pruning is best effort */ }
    }, 3_600_000);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  }
}

export function stopRunAttributionTimers(): void {
  if (idleTimer !== null) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  if (pruneTimer !== null) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

/** Test helper: full module reset (timers, inference state, config, deps, store). */
export function _resetRunAttributionForTests(): void {
  stopRunAttributionTimers();
  gapRuns.clear();
  lastPromptByThread.clear();
  baselineByTrace.clear();
  cacheTallyByRun.clear();
  rateLimitRingByRun.clear();
  waveFiredAtByRun.clear();
  lastInvalidRunLogAt = 0;
  _config = resolveAttributionConfig(undefined);
  _deps = {};
  _resetRunStore();
}
