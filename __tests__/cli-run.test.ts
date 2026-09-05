/**
 * `relayplane run` / `relayplane runs` against a stub proxy.
 *
 * Everything here uses async `spawn`, never `spawnSync`: the stub HTTP server
 * lives in this very process, and `spawnSync` freezes the event loop, so the
 * parent could never accept() the child's request. That is the same deadlock
 * vitest.config.ts patches around for the locked cli-surface.test.ts.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cliPath, packageRoot, makeHome, cleanEnv, freePort, passthroughAnthropicConfig } from './helpers/p0-harness';

interface StubCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface StubProxy {
  port: number;
  url: string;
  calls: StubCall[];
  /** Paths answered with 404, to exercise the graceful-degradation branches. */
  missing: Set<string>;
  listRuns: Record<string, unknown>[];
  close(): Promise<void>;
}

function summaryRun(runId: string, exitCode: number): Record<string, unknown> {
  const started = Date.now() - 102_000;
  return {
    run_id: runId,
    label: 't',
    status: exitCode === 0 ? 'completed' : 'failed',
    request_count: 2,
    cost_usd: 0.5,
    baseline_usd: 1.25,
    retry_count: 1,
    retry_cost_usd: 0.1,
    band_status: 'none',
    band_lo: null,
    band_hi: null,
    rate_limit_count: 0,
    drift_count: 0,
    started_at: started,
    ended_at: Date.now(),
  };
}

function startStubProxy(): Promise<StubProxy> {
  const calls: StubCall[] = [];
  const missing = new Set<string>();
  const listRuns: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not JSON, fine */ }
      calls.push({ method: req.method ?? 'GET', path: url, body });

      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (missing.has(pathname)) { json(404, { error: 'not_found' }); return; }

      if (req.method === 'POST' && pathname === '/v1/runs') {
        const runId = typeof body['run_id'] === 'string' ? body['run_id'] : 'stub-run';
        json(200, { run_id: runId, dashboard_url: `http://stub/dashboard#run=${runId}`, run: summaryRun(runId, 0) });
        return;
      }

      const endMatch = /^\/v1\/runs\/(.+)\/end$/.exec(pathname);
      if (req.method === 'POST' && endMatch) {
        const runId = decodeURIComponent(endMatch[1] ?? '');
        const exitCode = typeof body['exit_code'] === 'number' ? body['exit_code'] : 0;
        json(200, { run: summaryRun(runId, exitCode), agents: [] });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/runs') { json(200, { runs: listRuns, next_cursor: null }); return; }

      const idMatch = /^\/v1\/runs\/([^/]+)$/.exec(pathname);
      if (req.method === 'GET' && idMatch) {
        const runId = decodeURIComponent(idMatch[1] ?? '');
        json(200, {
          run: summaryRun(runId, 0),
          agents: [{ agent_label: 'coder', request_count: 2, cost_usd: 0.5, models_seen: { 'claude-sonnet-4-6': 2 }, retry_cost_usd: 0.1 }],
          drift: [{ agent_label: 'coder', requested_model: 'claude-sonnet-4-6', model: 'claude-haiku-4-5', count: 1 }],
        });
        return;
      }

      json(404, { error: 'not_found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        calls,
        missing,
        listRuns,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

interface CliResult { status: number | null; stdout: string; stderr: string }

function runCli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: cleanEnv(home, { RELAYPLANE_NO_UPDATE_CHECK: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('relayplane run', () => {
  let stub: StubProxy;
  let home: string;

  beforeAll(async () => {
    expect(existsSync(cliPath)).toBe(true);
    stub = await startStubProxy();
    home = makeHome(passthroughAnthropicConfig).home;
  });

  afterAll(async () => {
    await stub.close();
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it('exports the run env contract to the child, closes the run, and mirrors the child exit code', async () => {
    const before = stub.calls.length;
    const res = await runCli(
      [
        'run', '--label', 't', '--proxy', stub.url, '--',
        process.execPath, '-e',
        'console.log(process.env.ANTHROPIC_CUSTOM_HEADERS); console.log(process.env.RELAYPLANE_RUN_ID); process.exit(3)',
      ],
      home,
    );

    expect(res.status).toBe(3);
    expect(res.stdout).toContain('X-RelayPlane-Run: t-');
    expect(res.stdout).toContain('X-RelayPlane-Run-Label: t');

    const opened = stub.calls.slice(before).find((c) => c.method === 'POST' && c.path === '/v1/runs');
    expect(opened).toBeDefined();
    const runId = String(opened?.body['run_id'] ?? '');
    expect(runId).toMatch(/^t-\d{8}-[0-9a-f]{6}$/);
    // The child echoed RELAYPLANE_RUN_ID, so the id the proxy was told about
    // is byte-identical to the one the wrapped process saw.
    expect(res.stdout).toContain(runId);

    const ended = stub.calls.slice(before).find((c) => c.method === 'POST' && c.path.endsWith('/end'));
    expect(ended).toBeDefined();
    expect(ended?.path).toBe(`/v1/runs/${runId}/end`);
    expect(ended?.body['exit_code']).toBe(3);

    // The rollup is stderr, so piping stdout of a wrapped command stays clean.
    expect(res.stderr).toContain(`Run ${runId}`);
    expect(res.stderr).toContain('notional');
  }, 20000);

  it('sets ANTHROPIC_BASE_URL to the proxy for a child that has none', async () => {
    const res = await runCli(
      ['run', '--proxy', stub.url, '--', process.execPath, '-e', 'console.log(process.env.ANTHROPIC_BASE_URL)'],
      home,
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(stub.url);
  }, 20000);

  it('still runs the child and mirrors exit 0 when the proxy is down', async () => {
    const deadPort = await freePort();
    const res = await runCli(
      ['run', '--label', 'offline', '--proxy', `http://127.0.0.1:${deadPort}`, '--', process.execPath, '-e', 'console.log("ran anyway")'],
      home,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ran anyway');
    expect(res.stderr).toContain('the proxy did not answer');
  }, 20000);

  it('prints the machine readable rollup on stdout with --json', async () => {
    const res = await runCli(
      ['run', '--label', 't', '--proxy', stub.url, '--json', '--', process.execPath, '-e', 'process.exit(0)'],
      home,
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { run: { run_id: string }; dashboard_url: string };
    expect(parsed.run.run_id).toMatch(/^t-\d{8}-[0-9a-f]{6}$/);
    expect(parsed.dashboard_url).toContain('#run=');
  }, 20000);

  it('sends the tags and cap it was given', async () => {
    const before = stub.calls.length;
    const res = await runCli(
      [
        'run', '--label', 'tagged', '--tag', 'env:prod', '--tag', 'team:core', '--cap', '0.5',
        '--proxy', stub.url, '--', process.execPath, '-e', 'console.log(process.env.RELAYPLANE_RUN_HEADERS)',
      ],
      home,
    );
    expect(res.status).toBe(0);
    const headers = JSON.parse(res.stdout.trim()) as Record<string, string>;
    expect(headers['X-RelayPlane-Tags']).toBe('env:prod,team:core');
    expect(headers['X-RelayPlane-Run-Cap-Usd']).toBe('0.5');

    const opened = stub.calls.slice(before).find((c) => c.method === 'POST' && c.path === '/v1/runs');
    expect(opened?.body['tags']).toEqual({ env: 'prod', team: 'core' });
    expect(opened?.body['cap_usd']).toBe(0.5);
  }, 20000);

  it('exits 127 with a one-line error when the command does not exist', async () => {
    const res = await runCli(
      ['run', '--proxy', stub.url, '--', 'definitely-not-a-real-binary-xyz'],
      home,
    );
    expect(res.status).toBe(127);
    expect(res.stderr).toContain('cannot run "definitely-not-a-real-binary-xyz"');
  }, 20000);

  it('rejects a missing -- separator instead of guessing', async () => {
    const res = await runCli(['run', '--label', 't', 'echo'], home);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Missing "--"');
  }, 20000);

  it('forwards --help past the separator to the child instead of printing our help', async () => {
    // A wrapper that swallows the wrapped command's own --help is a wrapper
    // that breaks `relayplane run -- claude --help`.
    const res = await runCli(
      ['run', '--proxy', stub.url, '--', 'bash', '-c', 'echo "child-saw:$*"', 'wrapped', '--help'],
      home,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('child-saw:--help');
    expect(res.stdout).not.toContain('RelayPlane Proxy - Intelligent AI Model Routing');
  }, 20000);
});

describe('relayplane runs', () => {
  let stub: StubProxy;
  let home: string;

  beforeAll(async () => {
    stub = await startStubProxy();
    home = makeHome(passthroughAnthropicConfig).home;
  });

  afterAll(async () => {
    await stub.close();
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it('prints valid JSON for `runs list --json`', async () => {
    stub.listRuns.length = 0;
    stub.listRuns.push({
      run_id: 'nightly-20260905-aabbcc',
      label: 'nightly',
      status: 'completed',
      run_source: 'header',
      started_at: Date.now() - 60_000,
      last_seen_at: Date.now(),
      ended_at: Date.now(),
      request_count: 12,
      cost_usd: 1.5,
      retry_cost_usd: 0.2,
      band_status: 'in',
      agent_count: 2,
    });

    const res = await runCli(['runs', 'list', '--proxy', stub.url, '--json'], home);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { runs: { run_id: string }[] };
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.run_id).toBe('nightly-20260905-aabbcc');
  }, 20000);

  it('renders a table and the notional honesty line without --json', async () => {
    const res = await runCli(['runs', '--proxy', stub.url], home);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nightly-20260905-aabbcc');
    expect(res.stdout).toContain('RUN');
    expect(res.stdout).toContain('notional');
  }, 20000);

  it('shows one run with its agent table and drift lines', async () => {
    const res = await runCli(['runs', 'show', 'nightly-20260905-aabbcc', '--proxy', stub.url], home);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Run nightly-20260905-aabbcc');
    expect(res.stdout).toContain('AGENT');
    expect(res.stdout).toContain('Model drift');
    expect(res.stdout).toContain('claude-sonnet-4-6 -> claude-haiku-4-5');
  }, 20000);

  it('degrades gracefully with exit 1 when the proxy 404s a route it does not ship yet', async () => {
    stub.missing.add('/v1/runs/bands');
    try {
      const res = await runCli(['runs', 'band', 'nightly', '--proxy', stub.url], home);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('HTTP 404');
      expect(res.stderr).toContain('run API');
    } finally {
      stub.missing.delete('/v1/runs/bands');
    }
  }, 20000);

  it('degrades gracefully with exit 1 when the proxy is not reachable at all', async () => {
    const deadPort = await freePort();
    const res = await runCli(['runs', 'list', '--proxy', `http://127.0.0.1:${deadPort}`], home);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`Proxy not reachable on :${deadPort}`);
  }, 20000);
});
