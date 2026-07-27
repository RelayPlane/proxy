import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

// This test imports the breakdown handler logic that does not exist yet.
// It will fail at import time or at assertion time once the endpoint is added.
// The endpoint lives in standalone-proxy.ts but is not yet implemented.

const BASE_PORT = 14288;

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { reject(new Error(`non-JSON: ${d}`)); }
      });
    }).on('error', reject);
  });
}

function postJson(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: Number(opts.port),
      path: opts.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { reject(new Error(`non-JSON: ${d}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Inline minimal standalone server that exercises just the breakdown endpoint.
// If the endpoint does not exist yet this suite will fail with "route not found" assertions.

let proxyProcess: ReturnType<typeof import('node:child_process').spawn> | null = null;

// We test via a lightweight in-process HTTP server that mimics
// the routing done in standalone-proxy.ts once the handler is added.
// Since the handler does NOT exist yet, we simulate what the handler
// would be imported from once implemented and assert on the missing export.

// The actual test strategy: import the not-yet-existing breakdown handler
// and assert the shape. The import itself will throw if the module is absent.

async function tryBreakdownEndpoint(dimension: string, window?: string): Promise<any> {
  const qs = window ? `?dimension=${dimension}&window=${window}` : `?dimension=${dimension}`;
  const url = `http://127.0.0.1:${BASE_PORT}/v1/telemetry/breakdown${qs}`;
  return getJson(url);
}

// We spin up the actual proxy to validate the endpoint exists.
// Since it doesn't exist yet, the endpoint will 404 and tests fail.

let server: http.Server;

function makeEntry(overrides: Partial<{
  id: string; originalModel: string; targetModel: string; provider: string;
  tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number;
  success: boolean; timestamp: string; agentFingerprint?: string;
}>): object {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    originalModel: 'claude-haiku-4-5',
    targetModel: 'claude-haiku-4-5',
    provider: 'anthropic',
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0.001,
    latencyMs: 100,
    success: true,
    mode: 'proxy',
    escalated: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// Since we cannot import internal state from standalone-proxy.ts directly,
// we start a real proxy process and call the endpoints over HTTP.
// These tests are designed to FAIL because the endpoints do not exist yet.

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const PROXY_DIST = path.resolve(__dirname, '../dist/cli.js');

let childProc: ChildProcess | null = null;

beforeAll(async () => {
  // The dist may not exist yet; that alone will cause failures.
  // We start the proxy on BASE_PORT (14288) if possible.
  if (!fs.existsSync(PROXY_DIST)) {
    // dist not built: tests will fail at the fetch step, which is correct.
    return;
  }
  await new Promise<void>((resolve) => {
    childProc = spawn('node', [PROXY_DIST, 'start'], {
      env: { ...process.env, RELAYPLANE_PORT: String(BASE_PORT), NO_BROWSER: '1' },
      stdio: 'pipe',
    });
    // Wait up to 4s for the port to open
    const deadline = Date.now() + 4000;
    const poll = setInterval(() => {
      const sock = net.createConnection(BASE_PORT, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); clearInterval(poll); resolve(); });
      sock.on('error', () => { sock.destroy(); if (Date.now() > deadline) { clearInterval(poll); resolve(); } });
    }, 200);
  });
  // Seed a couple of entries via probe endpoint (does not exist yet, expected to fail)
  await postJson(`http://127.0.0.1:${BASE_PORT}/v1/test/probe`, {}).catch(() => null);
  await postJson(`http://127.0.0.1:${BASE_PORT}/v1/test/probe`, {}).catch(() => null);
}, 10000);

afterAll(async () => {
  childProc?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
});

describe('GET /v1/telemetry/breakdown', () => {
  it('test_breakdown_model_returns_required_fields - returns rows with all required fields', async () => {
    const { status, body } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('total_cost_usd');
    expect(body).toHaveProperty('window', '24h');
    expect(body).toHaveProperty('generated_at');
    // rows may be empty if probe failed, but the shape must be correct
    if (body.rows.length > 0) {
      const row = body.rows[0];
      expect(row).toHaveProperty('model_id');
      expect(row).toHaveProperty('provider');
      expect(row).toHaveProperty('requests');
      expect(row).toHaveProperty('input_tokens');
      expect(row).toHaveProperty('output_tokens');
      expect(row).toHaveProperty('cost_usd');
      expect(row).toHaveProperty('pct_of_window_spend');
      expect(row).toHaveProperty('avg_cost_per_request');
    }
  });

  it('test_breakdown_model_sorted_by_cost_desc - rows sorted by cost_usd descending', async () => {
    const { status, body } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
    const rows: { cost_usd: number }[] = body.rows;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.cost_usd).toBeGreaterThanOrEqual(rows[i]!.cost_usd);
    }
  });

  it('test_breakdown_model_window_24h - responds 200 for window=24h', async () => {
    const { status } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
  });

  it('test_breakdown_model_window_1h_strict - responds 200 for window=1h', async () => {
    const { status } = await tryBreakdownEndpoint('model', '1h');
    expect(status).toBe(200);
  });

  it('test_breakdown_model_unknown_window_falls_back_to_24h - window=bogus returns 200, not 400', async () => {
    const { status, body } = await tryBreakdownEndpoint('model', 'bogus');
    expect(status).toBe(200);
    expect(body).toHaveProperty('rows');
  });

  it('test_breakdown_agent_fingerprint_truncated_to_8 - agent rows have 8-char fingerprint', async () => {
    const { status, body } = await tryBreakdownEndpoint('agent', '24h');
    expect(status).toBe(200);
    expect(body).toHaveProperty('rows');
    for (const row of body.rows as { agent_fingerprint: string }[]) {
      expect(row.agent_fingerprint).toHaveLength(8);
    }
  });

  it('test_breakdown_agent_label_from_registry - rows have label field (null or string)', async () => {
    const { status, body } = await tryBreakdownEndpoint('agent', '24h');
    expect(status).toBe(200);
    for (const row of body.rows as { label: unknown }[]) {
      expect(row.label === null || typeof row.label === 'string').toBe(true);
    }
  });

  it('test_breakdown_agent_top_model_is_highest_cost - rows have top_model field', async () => {
    const { status, body } = await tryBreakdownEndpoint('agent', '24h');
    expect(status).toBe(200);
    for (const row of body.rows as { top_model: unknown }[]) {
      expect(typeof row.top_model).toBe('string');
    }
  });

  it('test_breakdown_agent_skips_unknown_fingerprint - no row has agent_fingerprint starting with "unknow"', async () => {
    const { status, body } = await tryBreakdownEndpoint('agent', '24h');
    expect(status).toBe(200);
    for (const row of body.rows as { agent_fingerprint: string }[]) {
      expect(row.agent_fingerprint).not.toMatch(/^unknow/);
    }
  });

  it('test_breakdown_pct_of_window_spend_sums_close_to_100 - pct sum near 100 when rows present', async () => {
    const { status, body } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
    const rows: { pct_of_window_spend: number; cost_usd: number }[] = body.rows;
    if (body.total_cost_usd > 0 && rows.length > 0) {
      const sum = rows.reduce((acc, r) => acc + r.pct_of_window_spend, 0);
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.5);
    }
  });

  it('test_breakdown_empty_when_no_history - dimension=agent returns rows array (may be empty)', async () => {
    const { status, body } = await tryBreakdownEndpoint('agent', '1h');
    expect(status).toBe(200);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total_cost_usd).toBe('number');
  });

  it('test_breakdown_model_includes_token_sums - rows have numeric input_tokens and output_tokens', async () => {
    const { status, body } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
    for (const row of body.rows as { input_tokens: unknown; output_tokens: unknown }[]) {
      expect(typeof row.input_tokens).toBe('number');
      expect(typeof row.output_tokens).toBe('number');
    }
  });
});

describe('POST /v1/test/probe', () => {
  it('test_probe_endpoint_appends_history_entry - returns ok:true and id starting with probe-', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${BASE_PORT}/v1/test/probe`, {});
    expect(status).toBe(200);
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('id');
    expect((body.id as string).startsWith('probe-')).toBe(true);
  });

  it('test_probe_endpoint_increments_history - after probe, model breakdown returns at least one row', async () => {
    await postJson(`http://127.0.0.1:${BASE_PORT}/v1/test/probe`, {});
    const { status, body } = await tryBreakdownEndpoint('model', '24h');
    expect(status).toBe(200);
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
  });
});
