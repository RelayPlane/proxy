#!/usr/bin/env node
/**
 * RelayPlane QA harness — per-vendor native delegation (offline, no real keys).
 *
 * Boots the real proxy (dist/standalone-proxy.js) against two local mock
 * upstreams and a sandboxed config/data dir, then drives /v1/messages and
 * asserts routing, model translation, provider-key isolation, no-token-leak,
 * streaming, and fail-closed behavior.
 *
 * Run from repo root:  node .claude/skills/relayplane-qa/scripts/qa-native-delegate.mjs
 * Exit code 0 = all assertions passed, 1 = at least one failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const DIST = path.join(REPO_ROOT, 'dist', 'standalone-proxy.js');

const FAKE_CLAUDE_TOKEN = 'sk-ant-oat-CLAUDE-SECRET-DO-NOT-LEAK';
const ZAI_PORT = 9101;
const MM_PORT = 9102;
const PROXY_PORT = 4899;

// ── assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

// ── mock upstreams: record every request, answer Anthropic-style ─────────────
const calls = { zai: [], minimax: [] };
function makeMock(bucket) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls[bucket].push({ headers: req.headers, body });
      const model = body.model ?? 'unknown';
      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 },
        }));
      }
    });
  });
}
const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r));

// ── sandbox: temp config + data dir, fake provider keys ──────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-qa-'));
const configPath = path.join(tmp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  enabled: true,
  // Mark onboarding done so the proxy's first-run auto-config does NOT overwrite
  // routing.mode (a fresh config with no ANTHROPIC_API_KEY is auto-rewritten to
  // "complexity", which silently bypasses native delegation). See SKILL.md.
  first_run_complete: true,
  // Disable the response cache for the QA: its key omits `stream` (so a streaming
  // request collides with a prior non-streaming one) and its cacheDir ignores
  // RELAYPLANE_HOME_OVERRIDE (so it would read/write the operator's real
  // ~/.relayplane/cache). Neither affects the delegation feature under test.
  cache: { enabled: false },
  routing: { mode: 'standard' },
  nativeDelegate: {
    providers: {
      zai:     { baseUrl: `http://127.0.0.1:${ZAI_PORT}/v1/messages`, apiKeyEnv: 'ZAI_API_KEY', stripVendor: true },
      minimax: { baseUrl: `http://127.0.0.1:${MM_PORT}/v1/messages`,  apiKeyEnv: 'MINIMAX_API_KEY' },
    },
  },
}, null, 2));

process.env.RELAYPLANE_CONFIG_PATH = configPath;
process.env.RELAYPLANE_HOME_OVERRIDE = tmp;
process.env.ZAI_API_KEY = 'fake-zai-key';
process.env.MINIMAX_API_KEY = 'fake-mm-key';
delete process.env.ANTHROPIC_API_KEY;

function call(model, { stream = false } = {}) {
  return fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FAKE_CLAUDE_TOKEN}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, stream, messages: [{ role: 'user', content: 'reply OK' }] }),
    signal: AbortSignal.timeout(8000),
  });
}
const noLeak = (headers) => !Object.values(headers).some((v) => String(v).includes('CLAUDE-SECRET'));

async function main() {
  const zai = makeMock('zai'), mm = makeMock('minimax');
  await Promise.all([listen(zai, ZAI_PORT), listen(mm, MM_PORT)]);
  const { startProxy } = await import(DIST);
  const server = await startProxy({ port: PROXY_PORT });
  await new Promise((r) => setTimeout(r, 300));

  try {
    // T1 — GLM slug routes to z.ai, vendor stripped, provider key only
    console.log('\nT1  zai/glm-5.2 (non-streaming) → z.ai');
    {
      const r = await call('zai/glm-5.2');
      const j = await r.json().catch(() => ({}));
      const c = calls.zai.at(-1);
      ok('proxy returned 200', r.status === 200, `status=${r.status}`);
      ok('z.ai mock hit once', calls.zai.length === 1, `count=${calls.zai.length}`);
      ok('minimax mock NOT hit', calls.minimax.length === 0);
      ok('outgoing model is bare "glm-5.2" (stripVendor)', c?.body?.model === 'glm-5.2', `got=${c?.body?.model}`);
      ok('upstream auth is ZAI provider key', c?.headers?.authorization === 'Bearer fake-zai-key', `got=${c?.headers?.authorization}`);
      ok('Claude token NOT leaked upstream', noLeak(c?.headers ?? {}));
      ok('response echoes glm model', String(j.model ?? '').includes('glm'), `got=${j.model}`);
    }

    // T2 — MiniMax slug routes to minimax, slug kept, its own key
    console.log('\nT2  minimax/MiniMax-M1 (non-streaming) → MiniMax');
    {
      const r = await call('minimax/MiniMax-M1');
      const c = calls.minimax.at(-1);
      ok('proxy returned 200', r.status === 200, `status=${r.status}`);
      ok('minimax mock hit once', calls.minimax.length === 1, `count=${calls.minimax.length}`);
      ok('z.ai mock still only 1 call', calls.zai.length === 1);
      ok('outgoing model kept as full slug', c?.body?.model === 'minimax/MiniMax-M1', `got=${c?.body?.model}`);
      ok('upstream auth is MINIMAX provider key', c?.headers?.authorization === 'Bearer fake-mm-key', `got=${c?.headers?.authorization}`);
      ok('Claude token NOT leaked upstream', noLeak(c?.headers ?? {}));
    }

    // T3 — Anthropic slug is NOT delegated (stays native)
    console.log('\nT3  claude-3-5-haiku → native Anthropic (no delegation)');
    {
      const before = { z: calls.zai.length, m: calls.minimax.length };
      await call('claude-3-5-haiku-20241022').catch(() => {}); // real upstream may fail; we only assert no delegation
      ok('z.ai mock not hit', calls.zai.length === before.z);
      ok('minimax mock not hit', calls.minimax.length === before.m);
    }

    // T4 — streaming is delegated and piped back as SSE
    console.log('\nT4  zai/glm-5.2 (stream:true) → z.ai SSE');
    {
      const r = await call('zai/glm-5.2', { stream: true });
      const text = await r.text();
      const c = calls.zai.at(-1);
      ok('content-type is event-stream', (r.headers.get('content-type') ?? '').includes('text/event-stream'), r.headers.get('content-type') ?? '');
      ok('SSE chunks streamed back', text.includes('message_stop') || text.includes('content_block_delta'), `len=${text.length}`);
      ok('upstream saw stream:true', c?.body?.stream === true);
    }

    // T5 — fail-closed: missing provider key must NOT leak to OpenRouter fallback
    console.log('\nT5  fail-closed: ZAI_API_KEY unset → not delegated');
    {
      delete process.env.ZAI_API_KEY; // read per-request inside resolveNativeDelegate
      const before = calls.zai.length;
      const r = await call('zai/glm-5.2').catch(() => ({ status: 0 }));
      ok('z.ai mock NOT hit', calls.zai.length === before, `count=${calls.zai.length}`);
      ok('request rejected (not silently rerouted)', r.status === 400 || r.status === 0, `status=${r.status}`);
      process.env.ZAI_API_KEY = 'fake-zai-key';
    }
  } finally {
    server.close?.();
    zai.close(); mm.close();
  }

  console.log(`\n──────────────\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
