/**
 * Shared harness for the 2026-09-04 install-test P0 regression suites.
 *
 * Spawns the BUILT proxy (dist/cli.js) as a child process in an isolated
 * HOME, exactly like a fresh `npm install -g @relayplane/proxy` user would,
 * and points its provider endpoints at an in-process mock upstream via the
 * RELAYPLANE_<PROVIDER>_BASE_URL overrides. No live network, no :4100.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const packageRoot = join(__dirname, '..', '..');
export const cliPath = join(packageRoot, 'dist', 'cli.js');

export interface UpstreamCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockUpstream {
  url: string;
  calls: UpstreamCall[];
  close(): Promise<void>;
  /** When true the SSE stream ends without a usage chunk even if asked. */
  omitUsage: boolean;
  /**
   * Artificial latency knob. Key is a substring of the first user message,
   * value is the delay in ms before the mock answers. The proxy does not
   * forward custom headers or query strings upstream, so matching on the
   * prompt text is the only way a test can slow one concurrent call down.
   */
  delays: Map<string, number>;
}

/** First user message text of an OpenAI-style or Anthropic-style body. */
export function firstUserText(body: Record<string, unknown>): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user') continue;
    return contentToText(msg.content);
  }
  return '';
}

/** Every user message text of a body, joined, for deterministic token math. */
export function allUserText(body: Record<string, unknown>): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user') continue;
    parts.push(contentToText(msg.content));
  }
  return parts.join('\n');
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Longest matching delay key wins, so a test can layer a broad and a narrow rule. */
function delayFor(delays: Map<string, number>, text: string): number {
  let best = 0;
  let bestKeyLength = -1;
  for (const [needle, ms] of delays) {
    if (needle && text.includes(needle) && needle.length > bestKeyLength) {
      best = ms;
      bestKeyLength = needle.length;
    }
  }
  return best;
}

/**
 * OpenAI-compatible mock upstream. Answers /chat/completions (and the
 * /v1-prefixed form) with a canned completion; streams SSE when
 * stream=true and appends the usage-only chunk ONLY when the caller sent
 * stream_options.include_usage, mirroring real OpenAI/OpenRouter behavior.
 */
export function startMockUpstream(): Promise<MockUpstream> {
  const calls: UpstreamCall[] = [];
  const state = { omitUsage: false };
  const delays = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ path: req.url ?? '', headers: req.headers, body });
      const model = String(body['model'] ?? 'mock-model');
      const wait = delayFor(delays, firstUserText(body));
      const answer = (): void => {
      if (body['stream'] === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: 'PONG' }));
        res.write(chunk({}, 'stop'));
        const so = body['stream_options'] as { include_usage?: boolean } | undefined;
        if (so?.include_usage === true && !state.omitUsage) {
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 21, completion_tokens: 2, total_tokens: 23 } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 },
      }));
      };
      if (wait > 0) setTimeout(answer, wait); else answer();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        delays,
        get omitUsage() { return state.omitUsage; },
        set omitUsage(v: boolean) { state.omitUsage = v; },
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

export interface MockAnthropicUpstream {
  url: string;
  calls: UpstreamCall[];
  /** Prompt-substring to delay-ms, same contract as MockUpstream.delays. */
  delays: Map<string, number>;
  /**
   * When set, every /v1/messages call answers with this HTTP status and an
   * Anthropic-shaped error body instead of a completion. The proxy parses the
   * error body as JSON on the failure path, so the body stays valid JSON.
   */
  failStatus: number | null;
  /**
   * Prompt-substring to remaining failure count. Takes precedence over
   * `failStatus` and decrements on each matching call, so a test can fail the
   * first N requests of one agent and let the rest through.
   */
  failures: Map<string, number>;
  close(): Promise<void>;
}

/** Longest matching key wins, same rule as the delay table. */
function failureKeyFor(failures: Map<string, number>, text: string): string | null {
  let best: string | null = null;
  for (const [needle, remaining] of failures) {
    if (!needle || remaining <= 0 || !text.includes(needle)) continue;
    if (best === null || needle.length > best.length) best = needle;
  }
  return best;
}

/**
 * Deterministic usage for the Anthropic mock. Tests price the exact same
 * numbers with estimateCost, so a run ledger assertion can be exact rather
 * than "greater than zero".
 */
export function anthropicMockUsage(userText: string): { input_tokens: number; output_tokens: number } {
  return { input_tokens: Math.ceil(userText.length / 4) + 10, output_tokens: 7 };
}

/**
 * Native Anthropic mock upstream. Answers POST /v1/messages (with or without
 * a query string) in both the JSON and the SSE shape, and 404s the
 * HEAD /api/hello probe Claude Code fires before its first request.
 */
export function startMockAnthropicUpstream(): Promise<MockAnthropicUpstream> {
  const calls: UpstreamCall[] = [];
  const delays = new Map<string, number>();
  const failures = new Map<string, number>();
  const state: { failStatus: number | null } = { failStatus: null };
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    const pathname = path.split('?')[0] ?? '';
    if (req.method === 'HEAD' || req.method === 'GET') {
      // Claude Code probes HEAD /api/hello; real Anthropic answers 404 there.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ path, headers: req.headers, body });
      if (!pathname.endsWith('/v1/messages')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: pathname } }));
        return;
      }
      const model = String(body['model'] ?? 'claude-sonnet-4-6');
      const usage = anthropicMockUsage(allUserText(body));
      const wait = delayFor(delays, firstUserText(body));
      const failureKey = failureKeyFor(failures, allUserText(body));
      const failStatus = failureKey !== null ? 429 : state.failStatus;
      if (failureKey !== null) failures.set(failureKey, (failures.get(failureKey) ?? 1) - 1);
      if (failStatus !== null) {
        const fail = (): void => {
          res.writeHead(failStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: failStatus === 429 ? 'rate_limit_error' : 'api_error', message: `mock upstream ${failStatus}` },
          }));
        };
        if (wait > 0) setTimeout(fail, wait); else fail();
        return;
      }
      const answer = (): void => {
        if (body['stream'] === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const evt = (type: string, data: Record<string, unknown>): string =>
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
          res.write(evt('message_start', {
            message: {
              id: 'msg_mock', type: 'message', role: 'assistant', model,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          }));
          res.write(evt('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
          res.write(evt('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG' } }));
          res.write(evt('content_block_stop', { index: 0 }));
          res.write(evt('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
          }));
          res.write(evt('message_stop', {}));
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'PONG' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }));
      };
      if (wait > 0) setTimeout(answer, wait); else answer();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        delays,
        failures,
        get failStatus() { return state.failStatus; },
        set failStatus(v: number | null) { state.failStatus = v; },
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface SpawnedProxy {
  port: number;
  home: string;
  configPath: string;
  proc: ChildProcess;
  output: () => string;
  alive: () => boolean;
  /** Kill the child and wait for exit WITHOUT deleting the home dir. */
  stopProcess: () => Promise<void>;
  stop: () => Promise<void>;
}

/** A fresh HOME with an optional pre-written ~/.relayplane/config.json. */
export function makeHome(config?: Record<string, unknown>): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'rp-p0-home-'));
  const dir = join(home, '.relayplane');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  if (config) writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { home, configPath };
}

/** Scrubbed env: no provider keys leak in from the developer's shell. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CI: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'RELAYPLANE_CONFIG_PATH', 'RELAYPLANE_HOME_OVERRIDE', 'RELAYPLANE_DAILY_CAP_USD', 'RELAYPLANE_PORT', 'RELAYPLANE_PROXY_PORT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

export async function spawnProxy(opts: {
  home: string;
  env?: Record<string, string>;
  args?: string[];
  /**
   * Point the native Anthropic path at a mock. Sets
   * RELAYPLANE_ANTHROPIC_BASE_URL and, unless the caller already supplied
   * one, a dummy ANTHROPIC_API_KEY so hasAnthropicAuth passes.
   */
  anthropicBaseUrl?: string;
}): Promise<SpawnedProxy> {
  const port = await freePort();
  const extraEnv: Record<string, string> = { ...(opts.env ?? {}) };
  if (opts.anthropicBaseUrl) {
    extraEnv['RELAYPLANE_ANTHROPIC_BASE_URL'] = opts.anthropicBaseUrl;
    if (!extraEnv['ANTHROPIC_API_KEY']) extraEnv['ANTHROPIC_API_KEY'] = 'sk-ant-dummy';
  }
  const env = cleanEnv(opts.home, extraEnv);
  const proc = spawn(process.execPath, [cliPath, 'start', '--port', String(port), '--offline', ...(opts.args ?? [])], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (d) => (out += d.toString()));
  proc.stderr?.on('data', (d) => (out += d.toString()));
  let exited = false;
  proc.on('exit', () => { exited = true; });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`proxy exited during startup:\n${out}`);
    if (out.includes('proxy listening on')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!out.includes('proxy listening on')) throw new Error(`proxy never became ready:\n${out}`);
  // Give the listener a beat to settle.
  await new Promise((r) => setTimeout(r, 150));

  const stopProcess = async (): Promise<void> => {
    if (exited) return;
    proc.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } r(); }, 2000);
      proc.on('exit', () => { clearTimeout(t); r(); });
    });
  };

  return {
    port,
    home: opts.home,
    configPath: join(opts.home, '.relayplane', 'config.json'),
    proc,
    output: () => out,
    alive: () => !exited && proc.exitCode === null,
    stopProcess,
    stop: async () => {
      await stopProcess();
      if (existsSync(opts.home)) rmSync(opts.home, { recursive: true, force: true });
    },
  };
}

export async function request(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: () => unknown; headers: Record<string, string> }> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  return new Promise((resolve, reject) => {
    const payload = init.body !== undefined ? JSON.stringify(init.body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(init.headers ?? {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text,
            json: () => JSON.parse(text),
            headers: res.headers as Record<string, string>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let _nonce = 0;
/** Unique prompt per call: the response cache keys on the body, and a cache HIT would mask what we test. */
export const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: `Reply with exactly the word PONG and nothing else, no punctuation, no explanation. (${process.pid}-${++_nonce})` }],
  ...extra,
});

/** The config `relayplane init` (non-TTY, OpenRouter-only) wrote in 1.9.51. */
export const initWrittenConfig1951 = {
  config_version: 4,
  device_id: 'test-device',
  telemetry_enabled: false,
  defaultProvider: 'openrouter',
  routing: {
    preferred_provider: 'auto',
    complexity: {
      simple: { description: 'Quick lookups, short answers, trivial edits' },
      moderate: { description: 'Standard reasoning, multi-step tasks' },
      complex: { description: 'Hard reasoning, refactors, deep analysis' },
      elite: { description: 'Frontier-class problems, research-grade tasks' },
    },
  },
};

// ---------------------------------------------------------------------------
// Run attribution helpers (PR1)
// ---------------------------------------------------------------------------

/** Native Anthropic request body. `claude-sonnet-4-6` stays on Anthropic. */
export const messagesBody = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 64,
  messages: [{ role: 'user', content: text }],
  ...extra,
});

/**
 * Config that makes a spawned proxy send `claude-sonnet-4-6` straight at the
 * Anthropic upstream: routing off (so nothing reclassifies or reroutes the
 * model), response cache off (a cache HIT would skip the upstream and mask
 * the ledger), telemetry off (no network).
 */
export const passthroughAnthropicConfig: Record<string, unknown> = {
  config_version: 4,
  device_id: 'test-device',
  telemetry_enabled: false,
  defaultProvider: 'anthropic',
  routing: { mode: 'passthrough', enabled: false },
  cache: { enabled: false },
};

/** One row of ~/.relayplane/history.jsonl, including the PR1 run fields. */
export interface HistoryRow {
  id: string;
  originalModel: string;
  targetModel: string;
  provider: string;
  mode: string;
  success: boolean;
  timestamp: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costEstimated?: boolean;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  responseModel?: string;
  statusCode?: number;
  agentId?: string;
  agentFingerprint?: string;
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

/**
 * Read ~/.relayplane/history.jsonl. The proxy buffers history and flushes at
 * 20 entries or 10 s, so a test that wants a small number of rows must call
 * `proxy.stopProcess()` first (SIGTERM triggers the shutdown flush) and only
 * then read. `stopProcess` deliberately leaves the home dir in place.
 */
export function readHistory(home: string): HistoryRow[] {
  const file = join(home, '.relayplane', 'history.jsonl');
  if (!existsSync(file)) return [];
  const rows: HistoryRow[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed) as HistoryRow); } catch { /* skip partial line */ }
  }
  return rows;
}

/** Poll history.jsonl until `want` rows land or the deadline passes. */
export async function waitForHistory(home: string, want: number, timeoutMs = 12_000): Promise<HistoryRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = readHistory(home);
  while (rows.length < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    rows = readHistory(home);
  }
  return rows;
}

export interface RunsDbRunRow {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  label: string | null;
  run_source: string;
  status: string;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  exit_code: number | null;
  reopen_count: number;
  request_count: number;
  error_count: number;
  rate_limit_count: number;
  retry_count: number;
  retry_cost_usd: number;
  drift_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number;
  baseline_usd: number;
  cap_usd: number | null;
  cap_hit_at: number | null;
  cache_state: string | null;
  band_status: string;
  tags: string;
  client_key: string | null;
  created_at: number;
}

export interface RunsDbRequestRow {
  trace_id: string;
  run_id: string;
  agent_label: string;
  thread_id: string;
  history_id: string | null;
  ts: number;
  model: string;
  requested_model: string | null;
  provider: string;
  attempt: number;
  is_retry: number;
  retry_reason: string | null;
  cache_state: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number;
  cost_estimated: number;
  latency_ms: number;
  success: number;
  status_code: number | null;
}

export interface RunsDbAgentRow {
  run_id: string;
  agent_label: string;
  thread_id: string;
  agent_source: string;
  agent_fingerprint: string | null;
  request_count: number;
  error_count: number;
  retry_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  models_seen: string;
  last_status_code: number | null;
}

export interface RunsDbAlertRow {
  id: number;
  ts: number;
  kind: string;
  run_id: string;
  agent_label: string | null;
  severity: string;
  message: string;
  data: string;
  delivered: number;
}

export interface RunsDbDump {
  runs: RunsDbRunRow[];
  requests: RunsDbRequestRow[];
  agents: RunsDbAgentRow[];
  alerts: RunsDbAlertRow[];
}

interface SqliteStatement {
  all(): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabase;

/**
 * Dump runs.db. The proxy keeps the file open in WAL mode; a second
 * READ-ONLY connection sees committed rows as long as the writer process is
 * still alive (the -wal and -shm files are on disk next to the db). Call this
 * BEFORE stopping the proxy. A missing db (nothing wrote it yet) reads as
 * three empty arrays so a red test fails on the assertion, not on an ENOENT.
 */
export function readRunsDb(home: string): RunsDbDump {
  const file = join(home, '.relayplane', 'runs.db');
  const empty: RunsDbDump = { runs: [], requests: [], agents: [], alerts: [] };
  if (!existsSync(file)) return empty;
  const requireFrom = createRequire(__filename);
  let Database: SqliteCtor;
  try {
    Database = requireFrom('better-sqlite3');
  } catch {
    return empty;
  }
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const table = <T>(name: string): T[] => {
      try {
        return db!.prepare(`SELECT * FROM ${name}`).all() as T[];
      } catch {
        return [];
      }
    };
    return {
      runs: table<RunsDbRunRow>('runs'),
      requests: table<RunsDbRequestRow>('run_requests'),
      agents: table<RunsDbAgentRow>('run_agents'),
      alerts: table<RunsDbAlertRow>('run_alerts'),
    };
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/** Poll runs.db until the named run carries at least `want` requests. */
export async function waitForRun(home: string, runId: string, want = 1, timeoutMs = 10_000): Promise<RunsDbDump> {
  const deadline = Date.now() + timeoutMs;
  let dump = readRunsDb(home);
  while (Date.now() < deadline) {
    const run = dump.runs.find((r) => r.run_id === runId);
    if (run && run.request_count >= want) return dump;
    await new Promise((r) => setTimeout(r, 200));
    dump = readRunsDb(home);
  }
  return dump;
}
