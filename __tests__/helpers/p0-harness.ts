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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ path: req.url ?? '', headers: req.headers, body });
      const model = String(body['model'] ?? 'mock-model');
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
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        get omitUsage() { return state.omitUsage; },
        set omitUsage(v: boolean) { state.omitUsage = v; },
        close: () => new Promise<void>((r) => server.close(() => r())),
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
}): Promise<SpawnedProxy> {
  const port = await freePort();
  const env = cleanEnv(opts.home, opts.env ?? {});
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

  return {
    port,
    home: opts.home,
    configPath: join(opts.home, '.relayplane', 'config.json'),
    proc,
    output: () => out,
    alive: () => !exited && proc.exitCode === null,
    stop: async () => {
      if (!exited) {
        proc.kill('SIGTERM');
        await new Promise<void>((r) => {
          const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } r(); }, 2000);
          proc.on('exit', () => { clearTimeout(t); r(); });
        });
      }
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
