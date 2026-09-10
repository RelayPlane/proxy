#!/usr/bin/env node
/**
 * RelayPlane proxy behavioral canary
 * ==================================
 *
 * A self-contained audit + recurring dogfood monitor that exercises every
 * advertised proxy feature against a REAL running proxy and asserts the REAL
 * observed behavior. It is deliberately strict: a genuinely-broken feature
 * FAILs (that is a correct, valuable result, not a canary bug).
 *
 * It does two jobs:
 *   1. one-shot audit  - stands up an isolated proxy, runs every check, exits
 *      non-zero if any check FAILs.
 *   2. dogfood monitor - point it at an already-running proxy and it runs the
 *      non-destructive subset against that live instance (cron-friendly).
 *
 * FORWARDS ARE FREE + REAL: every completion is forwarded to a local Ollama
 * model (ollama/qwen2.5:0.5b). If Ollama is unreachable the forward-dependent
 * checks SKIP with an explicit warning - they never silently pass.
 *
 * Usage
 * -----
 *   # one-shot audit (spins up an isolated proxy on port 4199):
 *   node scripts/behavioral-canary.mjs
 *
 *   # choose the port for the spun-up proxy:
 *   CANARY_PORT=4210 node scripts/behavioral-canary.mjs
 *
 *   # dogfood monitor against an ALREADY-running proxy (non-destructive subset):
 *   CANARY_TARGET_URL=http://127.0.0.1:4801 node scripts/behavioral-canary.mjs
 *
 *   # point at a non-default Ollama:
 *   OLLAMA_URL=http://127.0.0.1:11434 node scripts/behavioral-canary.mjs
 *
 * Env
 * ---
 *   CANARY_PORT        port for the proxy this script starts       (default 4199)
 *   CANARY_TARGET_URL  run against this existing proxy instead of
 *                      spinning one up. The budget checks (which mutate a
 *                      global daily cap) SKIP in this mode so a live proxy is
 *                      never disturbed.
 *   OLLAMA_URL         Ollama base url                             (default http://127.0.0.1:11434)
 *
 * Isolation: the spun-up proxy runs with RELAYPLANE_HOME_OVERRIDE pointed at a
 * fresh temp dir, so every on-disk store (budget.db, runs.db, traces, agents,
 * routing log ...) is isolated from ~/.relayplane. We deliberately DO NOT
 * pre-write a partial config.json - the proxy auto-generates a complete one at
 * startup; a partial file trips a "config missing fields" path that degrades
 * run-cap / budget behavior.
 *
 * Exit code: 0 iff zero FAILs. Non-zero if any check FAILs.
 * Prints a verdict table and a `CANARY_RESULT pass=N fail=M skip=K` summary line.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- config -----------------------------------------------------------------
const MODEL = 'ollama/qwen2.5:0.5b';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const TARGET_URL = process.env.CANARY_TARGET_URL; // if set, use existing proxy
const MANAGED = !TARGET_URL;                        // we started the proxy ourselves
const PORT = Number.parseInt(process.env.CANARY_PORT ?? '4199', 10);
const BASE = TARGET_URL ? TARGET_URL.replace(/\/+$/, '') : `http://127.0.0.1:${PORT}`;

// ── Fixture-proxy mode ─────────────────────────────────────────────────────
// The canary re-execs itself with CANARY_FIXTURE_MODE=1 to stand up a short-
// lived, PRE-CONFIGURED proxy for the routing + cascade proofs. The proxy's
// config path is frozen at module import time, and a running proxy re-saves
// config.json from a cached copy shortly after any runtime write, so a live
// reconfigure is clobbered. A child proxy whose config.json is pre-written
// (with first_run_complete=true, which disables the startup auto-config) keeps
// the routing config we set, stable, for the life of the process.
if (process.env.CANARY_FIXTURE_MODE === '1') {
  const fxPort = Number.parseInt(process.env.CANARY_FIXTURE_PORT ?? '0', 10);
  const mod = await import('../dist/standalone-proxy.js');
  await mod.startProxy({ port: fxPort, host: '127.0.0.1', verbose: false });
  console.log('FIXTURE_READY');
  await new Promise(() => {}); // stay alive until the parent kills us
}

// --- result accounting -------------------------------------------------------
/** @type {Array<{name:string,status:'PASS'|'FAIL'|'SKIP',evidence:string}>} */
const results = [];
function record(name, status, evidence) {
  results.push({ name, status, evidence });
  console.log(`  [${status}] ${name} :: ${evidence}`);
}
const pass = (n, e) => record(n, 'PASS', e);
const fail = (n, e) => record(n, 'FAIL', e);
const skip = (n, e) => record(n, 'SKIP', e);

// --- tiny http helpers -------------------------------------------------------
async function req(method, p, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const hdrs = {};
  for (const [k, v] of res.headers.entries()) hdrs[k.toLowerCase()] = v;
  return { status: res.status, headers: hdrs, json, text };
}
/**
 * POST a chat completion to the proxy with a UNIQUE prompt every call, so the
 * response cache never short-circuits the forward path (a cache HIT bypasses
 * budget / run-cap / routing / attribution). Returns the raw response wrapper.
 */
let _callSeq = 0;
function forward(model, extraHeaders = {}, messages) {
  const nonce = `${Date.now()}-${_callSeq++}-${Math.floor(Math.random() * 1e6)}`;
  const msgs = messages
    ? messages.map((m, i) =>
        i === messages.length - 1 && typeof m.content === 'string'
          ? { ...m, content: `${m.content} [nonce ${nonce}]` }
          : m)
    : [{ role: 'user', content: `Say the single word: ping. [nonce ${nonce}]` }];
  return req('POST', '/v1/chat/completions', {
    headers: extraHeaders,
    body: { model, messages: msgs, max_tokens: 16 },
  });
}
async function pollUntil(fn, { timeoutMs = 6000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// --- Ollama reachability -----------------------------------------------------
async function ollamaUp() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json();
    const names = (data?.models ?? []).map((m) => m.name);
    return names.some((n) => n === 'qwen2.5:0.5b' || n.startsWith('qwen2.5:0.5b'));
  } catch {
    return false;
  }
}

// --- proxy lifecycle ---------------------------------------------------------
let server = null;
let tmpHome = null;

async function startIsolatedProxy() {
  // Fresh isolated home BEFORE importing the proxy so every on-disk store lands
  // under it. No config.json is written: the proxy writes a complete one itself.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-canary-'));
  process.env.RELAYPLANE_HOME_OVERRIDE = tmpHome;
  process.env.RELAYPLANE_NO_UPDATE_CHECK = '1';
  fs.mkdirSync(path.join(tmpHome, '.relayplane'), { recursive: true });

  const mod = await import('../dist/standalone-proxy.js');
  server = await mod.startProxy({ port: PORT, host: '127.0.0.1', verbose: false });

  const ok = await pollUntil(async () => {
    try {
      const r = await req('GET', '/health');
      return r.status === 200 ? r : null;
    } catch {
      return null;
    }
  }, { timeoutMs: 10000, intervalMs: 200 });
  if (!ok) throw new Error('proxy did not become healthy on /health');
}

async function teardown() {
  try {
    if (server) await new Promise((res) => server.close(() => res()));
  } catch { /* ignore */ }
  try {
    if (MANAGED && tmpHome && tmpHome.startsWith(os.tmpdir())) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

// --- helpers to read runs ----------------------------------------------------
async function listRuns(query = '') {
  const r = await req('GET', `/v1/runs${query}`);
  return r.status === 200 && Array.isArray(r.json?.runs) ? r.json.runs : [];
}
async function getRunDetail(id) {
  const r = await req('GET', `/v1/runs/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.json : null;
}
async function findRun(predicate, opts) {
  return pollUntil(async () => {
    const runs = await listRuns();
    return runs.find(predicate) ?? null;
  }, opts);
}

// --- the checks --------------------------------------------------------------
async function runChecks(ollamaReachable) {
  // 1. health
  {
    const r = await req('GET', '/health');
    if (r.status === 200 && (r.json?.status === 'ok' || r.json?.ok === true)) {
      pass('health', `GET /health -> 200 status=${JSON.stringify(r.json?.status ?? r.json?.ok)}`);
    } else {
      fail('health', `GET /health -> ${r.status} body=${r.text.slice(0, 120)}`);
    }
  }

  // 10. estimate_ungated (validates Part 1 - no Pro gate). No forward needed.
  {
    const r = await req('POST', '/v1/estimate', {
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'How much will this cost?' }] },
    });
    const cost = r.json?.estimated_cost_usd;
    if (r.status === 402 || r.json?.error === 'upgrade_required') {
      fail('estimate_ungated', `still gated: ${r.status} error=${r.json?.error}`);
    } else if (r.status === 200 && typeof cost === 'number' && Number.isFinite(cost)) {
      pass('estimate_ungated', `200 estimated_cost_usd=${cost} (no 402/upgrade_required)`);
    } else {
      fail('estimate_ungated', `unexpected: ${r.status} body=${r.text.slice(0, 160)}`);
    }
  }

  if (!ollamaReachable) {
    for (const n of ['real_forward', 'cost_priced', 'run_attribution', 'request_count_accuracy',
      'per_agent', 'run_inference', 'run_label', 'per_run_cap', 'routing', 'complexity_routing',
      'retry_tracking', 'local_first', 'budget_block', 'budget_warn']) {
      skip(n, `Ollama unreachable at ${OLLAMA_URL} - forward-dependent check cannot run`);
    }
    skip('cascade_failover', 'Ollama unreachable - the failover fallback target is local Ollama');
    return;
  }

  // 2. real_forward (also seeds an inferred, no-header run for checks 3/4/7)
  let firstForwardOk = false;
  {
    const r = await forward(MODEL);
    const content = r.json?.choices?.[0]?.message?.content;
    if (r.status === 200 && typeof content === 'string' && content.length > 0) {
      firstForwardOk = true;
      pass('real_forward', `200 content="${content.slice(0, 40).replace(/\s+/g, ' ')}"`);
    } else {
      fail('real_forward', `${r.status} body=${r.text.slice(0, 160)}`);
    }
  }

  // 4. run_attribution + 3. cost_priced (share the run list)
  {
    const run = await findRun((x) => (x.request_count ?? 0) >= 1, { timeoutMs: 6000 });
    if (!run) {
      fail('run_attribution', 'no run with request_count>=1 after forward');
      fail('cost_priced', 'no run to inspect for cost');
    } else {
      pass('run_attribution', `run ${run.run_id} request_count=${run.request_count}`);
      const tokIn = run.tokens_in ?? 0;
      const costPresent = typeof run.cost_usd === 'number' && Number.isFinite(run.cost_usd);
      if (tokIn > 0 && costPresent) pass('cost_priced', `tokens_in=${tokIn} cost_usd=${run.cost_usd}`);
      else fail('cost_priced', `tokens_in=${tokIn} cost_usd=${JSON.stringify(run.cost_usd)}`);
    }
  }

  // 7. run_inference (a forward with NO run headers lands in an inferred run)
  {
    const run = await findRun((x) => typeof x.run_source === 'string' && x.run_source.startsWith('inferred'),
      { timeoutMs: 6000 });
    if (run) pass('run_inference', `inferred run ${run.run_id} run_source=${run.run_source}`);
    else {
      const sources = [...new Set((await listRuns()).map((x) => x.run_source))];
      fail('run_inference', `no inferred run; observed sources=${JSON.stringify(sources)}`);
    }
  }

  // 8. run_label
  {
    const label = 'canary-label';
    await forward(MODEL, { 'X-RelayPlane-Run-Label': label });
    const run = await findRun((x) => x.label === label, { timeoutMs: 6000 });
    if (run) pass('run_label', `run ${run.run_id} label="${run.label}"`);
    else {
      const labels = [...new Set((await listRuns()).map((x) => x.label))];
      fail('run_label', `no run labeled "${label}"; observed labels=${JSON.stringify(labels)}`);
    }
  }

  // 5. request_count_accuracy - send EXACTLY 3 forwards tagged to one run.
  //    Manual testing showed 3 sent but only 1 counted; we report the REAL number.
  {
    const runId = uniq('canary-count');
    const hdrs = { 'X-RelayPlane-Run': runId, 'X-RelayPlane-Run-Label': 'canary-count' };
    for (let i = 0; i < 3; i++) await forward(MODEL, hdrs);
    // wait for the run to exist, then allow async settle before reading the count
    await pollUntil(async () => (await getRunDetail(runId)) ?? null, { timeoutMs: 6000 });
    await sleep(3000);
    const detail = await getRunDetail(runId);
    const observed = detail?.run?.request_count ?? 0;
    if (observed === 3) pass('request_count_accuracy', `sent 3, run.request_count=3`);
    else fail('request_count_accuracy', `sent 3 but run.request_count=${observed} (undercount is a real, valuable finding)`);
  }

  // 6. per_agent - forwards tagged with X-RelayPlane-Agent land as run agents.
  //    Agent tracking keys off the system prompt, so include one.
  {
    const runId = uniq('canary-agent');
    const sys = (name) => ([
      { role: 'system', content: `You are an agent named ${name}.` },
      { role: 'user', content: 'Say ping.' },
    ]);
    await forward(MODEL, { 'X-RelayPlane-Run': runId, 'X-RelayPlane-Agent': 'coder' }, sys('coder'));
    await forward(MODEL, { 'X-RelayPlane-Run': runId, 'X-RelayPlane-Agent': 'reviewer' }, sys('reviewer'));
    const detail = await pollUntil(async () => {
      const d = await getRunDetail(runId);
      return (d?.agents ?? []).some((a) => a.agent_label === 'coder') ? d : null;
    }, { timeoutMs: 6000 });
    const agents = detail?.agents ?? [];
    const coder = agents.find((a) => a.agent_label === 'coder');
    if (coder && coder.agent_source === 'header') {
      pass('per_agent', `agents=${JSON.stringify(agents.map((a) => a.agent_label))} coder.source=${coder.agent_source}`);
    } else if (coder) {
      fail('per_agent', `coder present but agent_source=${coder.agent_source} (expected "header")`);
    } else {
      fail('per_agent', `no "coder" agent; observed=${JSON.stringify(agents.map((a) => a.agent_label))}`);
    }
  }

  // 13. retry_tracking - run detail exposes retry_count + retry_cost_usd (default 0).
  //     PARTIAL: a real retry is not forced in this harness; we assert the fields exist.
  {
    const runs = await listRuns();
    const detail = runs[0] ? await getRunDetail(runs[0].run_id) : null;
    const rc = detail?.run?.retry_count;
    const rcost = detail?.run?.retry_cost_usd;
    if (typeof rc === 'number' && typeof rcost === 'number') {
      pass('retry_tracking', `retry_count=${rc} retry_cost_usd=${rcost} (fields present; retry not forced = PARTIAL)`);
    } else {
      fail('retry_tracking', `missing retry fields: retry_count=${JSON.stringify(rc)} retry_cost_usd=${JSON.stringify(rcost)}`);
    }
  }

  // 9. per_run_cap - a tiny per-run cap must BLOCK (429) with x-relayplane-run-cap-exceeded.
  {
    const runId = uniq('canary-cap');
    const reg = await req('POST', '/v1/runs', { body: { run_id: runId, cap_usd: 0.0000001 } });
    if (reg.status !== 200) {
      fail('per_run_cap', `could not register capped run: ${reg.status} ${reg.text.slice(0, 120)}`);
    } else {
      const r = await forward(MODEL, { 'X-RelayPlane-Run': runId });
      const capHdr = r.headers['x-relayplane-run-cap-exceeded'];
      if (r.status === 429 && capHdr === 'true') {
        pass('per_run_cap', `429 x-relayplane-run-cap-exceeded=true (cap enforced, request blocked before forward)`);
      } else {
        fail('per_run_cap', `expected 429+cap header, got ${r.status} cap-exceeded=${capHdr}`);
      }
    }
  }

  // 12. routing - the proxy exposes its routing decision via response headers.
  {
    const r = await forward(MODEL);
    const routed = r.headers['x-relayplane-routed-model'];
    const mode = r.headers['x-relayplane-routing-mode'];
    // Probe a dynamic alias too (routes to a cloud provider; needs creds to complete).
    const alias = await forward('relayplane:auto');
    const aliasRouted = alias.headers['x-relayplane-routed-model'];
    if (routed && mode && String(routed).length > 0) {
      pass('routing',
        `routed-model="${routed}" routing-mode="${mode}"; relayplane:auto -> ${alias.status}` +
        `${aliasRouted ? ` routed=${aliasRouted}` : ' (cloud alias needs provider creds to complete)'}`);
    } else {
      fail('routing', `missing routing headers on forward: routed-model=${JSON.stringify(routed)} routing-mode=${JSON.stringify(mode)}`);
    }
  }

  // ── MANAGED-only fixtures (routing + cascade) ────────────────────────────
  //    Proven against short-lived, PRE-CONFIGURED child proxies (see the
  //    CANARY_FIXTURE_MODE block near the top for why a child proxy, not a
  //    live reconfigure). Uses only free local Ollama, plus a local always-429
  //    stub as the cascade primary.
  const SMALL = 'qwen2.5:0.5b';
  const BIG = 'qwen2.5:1.5b';
  const bigPulled = ollamaReachable && await (async () => {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`);
      const data = await res.json();
      return (data?.models ?? []).some((m) => m.name === BIG || m.name.startsWith(`${BIG}`));
    } catch { return false; }
  })();
  const pickPort = () => 40000 + Math.floor(Math.random() * 20000);
  async function spawnFixtureProxy(configObj, extraEnv = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-canary-fx-'));
    fs.mkdirSync(path.join(home, '.relayplane'), { recursive: true });
    fs.writeFileSync(path.join(home, '.relayplane', 'config.json'), JSON.stringify(configObj, null, 2));
    const port = pickPort();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        CANARY_FIXTURE_MODE: '1',
        CANARY_FIXTURE_PORT: String(port),
        RELAYPLANE_HOME_OVERRIDE: home,
        RELAYPLANE_NO_UPDATE_CHECK: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const base = `http://127.0.0.1:${port}`;
    const healthy = await pollUntil(async () => {
      try { const r = await fetch(`${base}/health`); return r.ok ? true : null; } catch { return null; }
    }, { timeoutMs: 20000, intervalMs: 300 });
    return { child, base, home, healthy: !!healthy };
  }
  function killFixture(fx) {
    try { fx.child.kill('SIGKILL'); } catch { /* ignore */ }
    try { if (fx.home && fx.home.startsWith(os.tmpdir())) fs.rmSync(fx.home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  async function fxForward(base, model, messages) {
    const nonce = `${Date.now()}-${_callSeq++}-${Math.floor(Math.random() * 1e6)}`;
    const src = messages ?? [{ role: 'user', content: 'Say the single word: ping.' }];
    const msgs = src.map((m, i, arr) =>
      i === arr.length - 1 && typeof m.content === 'string' ? { ...m, content: `${m.content} [nonce ${nonce}]` } : m);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, max_tokens: 16 }),
    });
    const headers = {};
    for (const [k, v] of r.headers.entries()) headers[k.toLowerCase()] = v;
    return { status: r.status, headers };
  }
  const baseFixtureConfig = () => ({
    device_id: 'anon_canary_fixture',
    telemetry_enabled: false,
    lifecycle_enabled: false,
    first_run_complete: true,   // disables startup auto-config so our routing sticks
    config_version: 4,
    ollama: { enabled: true, baseUrl: OLLAMA_URL, models: [SMALL, BIG] },
  });

  // 12b. complexity_routing - "simple work to cheap models, hard work to premium".
  //      Map the complexity tiers to two DIFFERENT local Ollama models
  //      (simple -> qwen2.5:0.5b, complex -> qwen2.5:1.5b). A trivial prompt and
  //      a clearly-hard prompt must classify differently AND resolve to the
  //      cheap vs premium model, provably, for free.
  if (MANAGED) {
    const complexModel = bigPulled ? BIG : SMALL; // fall back to one model if BIG absent
    const cfg = {
      ...baseFixtureConfig(),
      routing: {
        mode: 'complexity',
        cascade: { enabled: false, models: [], escalateOn: 'error', maxEscalations: 1 },
        complexity: {
          enabled: true,
          simple: `ollama/${SMALL}`,
          moderate: `ollama/${complexModel}`,
          complex: `ollama/${complexModel}`,
          elite: `ollama/${complexModel}`,
        },
      },
    };
    const fx = await spawnFixtureProxy(cfg);
    if (!fx.healthy) {
      fail('complexity_routing', 'fixture proxy did not become healthy on /health');
      killFixture(fx);
    } else {
      const simplePrompt = [{ role: 'user', content: 'Say the single word: ping.' }];
      const complexPrompt = [{ role: 'user', content:
        'Analyze and compare three distributed microservice architectures, then design ' +
        'and implement an optimized migration strategy with a detailed step 1, step 2 ' +
        'and step 3, evaluating scalability and failure modes at each phase.' }];
      const simpleRes = await pollUntil(async () => {
        const x = await fxForward(fx.base, 'relayplane:auto', simplePrompt);
        return x.status === 200 && String(x.headers['x-relayplane-provider'] ?? '').includes('ollama') ? x : null;
      }, { timeoutMs: 30000, intervalMs: 500 });
      const complexRes = await pollUntil(async () => {
        const x = await fxForward(fx.base, 'relayplane:auto', complexPrompt);
        return x.status === 200 && String(x.headers['x-relayplane-provider'] ?? '').includes('ollama') ? x : null;
      }, { timeoutMs: 30000, intervalMs: 500 });
      const sCplx = simpleRes?.headers['x-relayplane-complexity'];
      const cCplx = complexRes?.headers['x-relayplane-complexity'];
      const sModel = simpleRes?.headers['x-relayplane-routed-model'];
      const cModel = complexRes?.headers['x-relayplane-routed-model'];
      if (!(simpleRes?.status === 200 && complexRes?.status === 200)) {
        fail('complexity_routing',
          `could not get two routed 200s from Ollama: simple=${simpleRes?.status ?? 'n/a'} complex=${complexRes?.status ?? 'n/a'}`);
      } else if (bigPulled && sCplx === 'simple' && cCplx !== 'simple' &&
                 String(sModel).includes(SMALL) && String(cModel).includes(BIG) && sModel !== cModel) {
        pass('complexity_routing',
          `simple prompt -> complexity=${sCplx} routed=${sModel}; complex prompt -> complexity=${cCplx} routed=${cModel} ` +
          `(proxy classified complexity and picked the cheap vs premium tier per config; both 200 from local Ollama)`);
      } else if (sCplx === 'simple' && cCplx !== 'simple' && String(sModel).length > 0 && String(cModel).length > 0) {
        pass('complexity_routing',
          `simple -> complexity=${sCplx} routed=${sModel}; complex -> complexity=${cCplx} routed=${cModel}; ` +
          `classification + per-map selection proven. NOT proven: a distinct physical model per tier ` +
          `(second local model ${BIG} unavailable, both tiers mapped to ${SMALL})`);
      } else {
        fail('complexity_routing',
          `classification/selection did not diverge: simple->complexity=${sCplx} routed=${sModel}, ` +
          `complex->complexity=${cCplx} routed=${cModel}`);
      }
      killFixture(fx);
    }
  } else {
    skip('complexity_routing', 'target-url mode: cannot stand up a reconfigured fixture proxy against a live instance');
  }

  // cascade_failover - "a 429 on one provider fails over instead of failing your run".
  //   Deterministic local fixture: point the openrouter provider baseURL at a
  //   local stub that ALWAYS returns 429, put it FIRST in the cascade and local
  //   Ollama SECOND. cooldowns are OFF so the primary is actually attempted on
  //   the asserted request; escalateOn:'error' makes a provider error escalate
  //   to the next model. Assert (a) the 429 primary was hit, (b) the run still
  //   returns 200, (c) from the Ollama fallback, with routing-mode=cascade.
  if (MANAGED) {
    let mockHits = 0;
    const mock429 = http.createServer((req, res) => {
      mockHits++;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'mock 429 (always)' } }));
    });
    await new Promise((r) => mock429.listen(0, '127.0.0.1', r));
    const mockPort = mock429.address().port;
    const cfg = {
      ...baseFixtureConfig(),
      ollama: { enabled: true, baseUrl: OLLAMA_URL, models: [SMALL] },
      reliability: { cooldowns: { enabled: false } },
      routing: {
        mode: 'cascade',
        cascade: {
          enabled: true,
          models: ['openrouter/mock-primary-model', `ollama/${SMALL}`],
          escalateOn: 'error',
          maxEscalations: 2,
        },
        complexity: { enabled: false },
      },
    };
    // The child proxy reads these at forward time: openrouter -> our always-429
    // stub, plus a key so the primary is actually forwarded (not short-circuited).
    const fx = await spawnFixtureProxy(cfg, {
      RELAYPLANE_OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}`,
      OPENROUTER_API_KEY: 'sk-mock-cascade-primary',
    });
    if (!fx.healthy) {
      fail('cascade_failover', 'fixture proxy did not become healthy on /health');
    } else {
      // Warm up until cascade mode is confirmed live, then assert one request.
      await pollUntil(async () => {
        const x = await fxForward(fx.base, 'relayplane:auto');
        return x.status === 200 && x.headers['x-relayplane-routing-mode'] === 'cascade' ? x : null;
      }, { timeoutMs: 30000, intervalMs: 500 });
      mockHits = 0;
      const cr = await fxForward(fx.base, 'relayplane:auto');
      const crProvider = cr.headers['x-relayplane-provider'];
      const crMode = cr.headers['x-relayplane-routing-mode'];
      const crModel = cr.headers['x-relayplane-routed-model'];
      if (cr.status === 200 && mockHits >= 1 && String(crProvider).includes('ollama') && crMode === 'cascade') {
        pass('cascade_failover',
          `primary openrouter endpoint returned 429 (${mockHits} attempt(s) this request); run recovered with 200 ` +
          `from provider=${crProvider} routed=${crModel} routing-mode=${crMode} (failover, not a failed run)`);
      } else {
        fail('cascade_failover',
          `expected 429-primary -> 200 Ollama fallback: status=${cr.status} primaryHits=${mockHits} ` +
          `provider=${crProvider} routing-mode=${crMode} routed=${crModel}`);
      }
    }
    killFixture(fx);
    await new Promise((r) => mock429.close(() => r()));
  } else {
    skip('cascade_failover',
      'target-url mode: proving 429 failover needs a controlled always-429 primary + local fallback in a ' +
      'purpose-built config (cascade models=[openrouter/x, ollama/qwen2.5:0.5b], escalateOn:error, cooldowns off, ' +
      'RELAYPLANE_OPENROUTER_BASE_URL -> local 429 stub); not constructable against a live external proxy.');
  }

  // 14. local_first - forwards work with NO account / NO Authorization header.
  //     We cannot fully prove zero-exfil from here, so we assert the honest,
  //     verifiable claim: the proxy forwards for free with no login/account.
  {
    if (firstForwardOk) pass('local_first', 'forward succeeded with no Authorization header / no account or login required');
    else skip('local_first', 'first forward did not succeed; cannot assert no-login forwarding');
  }

  // 11. budget cap modes (RUN LAST - mutates a global daily cap).
  if (!MANAGED) {
    skip('budget_block', 'target-url mode: skipping (would mutate a live proxy budget)');
    skip('budget_warn', 'target-url mode: skipping (would mutate a live proxy budget)');
  } else {
    // budget_warn: drive the daily-cap tracker into its warn band (>=80% of cap,
    // still under it) and assert the warn header on the OpenAI-compatible endpoint.
    {
      const CAP = 0.0006; // small cap so a handful of ollama forwards cross 80%
      await req('POST', '/control/budget/set', { body: { dailyUsd: CAP } });
      await sleep(300);
      const budgetPct = async () => Number((await req('GET', '/control/budget')).json?.pct_used ?? 0);
      let prePct = await budgetPct();
      let warnRes = null;
      // forward until the NEXT request would sit in the [80,100) warn band
      for (let i = 0; i < 14 && prePct < 100; i++) {
        if (prePct >= 80) { warnRes = await forward(MODEL); break; } // this request is in the warn band
        await forward(MODEL);
        await sleep(150);
        prePct = await budgetPct();
      }
      if (warnRes && warnRes.status === 200) {
        const warnHdr = warnRes.headers['x-relayplane-budget-warning'];
        if (warnHdr) {
          pass('budget_warn', `at ${prePct}% of cap: forward 200 + x-relayplane-budget-warning="${warnHdr}"`);
        } else {
          fail('budget_warn',
            `at ${prePct}% of cap: forward 200 (not blocked) but x-relayplane-budget-warning ABSENT on /v1/chat/completions ` +
            `(preRequestBudgetCheck warn/downgrade headers are dropped in the chat path; native /v1/messages attaches them via budgetExtraHeaders)`);
        }
      } else {
        skip('budget_warn', `could not position spend in the [80,100)% warn band (pct=${prePct}, forward status=${warnRes?.status ?? 'n/a'})`);
      }
    }
    // budget_block: microscopic cap must block the next forward with 429.
    {
      const setRes = await req('POST', '/control/budget/set', { body: { dailyUsd: 0.0000001 } });
      await sleep(300);
      if (setRes.status !== 200) {
        fail('budget_block', `could not set cap: ${setRes.status} ${setRes.text.slice(0, 120)}`);
      } else {
        const br = await forward(MODEL);
        const exceeded = br.headers['x-relayplane-budget-exceeded'];
        if (br.status === 429 && exceeded) pass('budget_block', `429 x-relayplane-budget-exceeded="${exceeded}" (daily cap enforced)`);
        else fail('budget_block', `expected 429+exceeded header, got ${br.status} exceeded=${exceeded}`);
      }
    }
  }

}

// --- main --------------------------------------------------------------------
async function main() {
  console.log('RelayPlane behavioral canary');
  console.log(`  target      : ${BASE}${MANAGED ? ' (managed - spun up here)' : ' (external)'}`);
  console.log(`  ollama      : ${OLLAMA_URL}  model=${MODEL}`);

  const ollamaReachable = await ollamaUp();
  console.log(`  ollama up   : ${ollamaReachable}`);
  if (!ollamaReachable) {
    console.log('  WARNING: Ollama unreachable - forward-dependent checks will SKIP (not pass).');
  }

  if (MANAGED) {
    console.log(`  starting isolated proxy on :${PORT} ...`);
    await startIsolatedProxy();
    console.log(`  home override: ${tmpHome}`);
  }

  console.log('\nchecks:');
  await runChecks(ollamaReachable);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nCANARY ERROR: ${err?.stack || err}`);
  exitCode = 2;
} finally {
  await teardown();
}

// --- verdict -----------------------------------------------------------------
const nPass = results.filter((r) => r.status === 'PASS').length;
const nFail = results.filter((r) => r.status === 'FAIL').length;
const nSkip = results.filter((r) => r.status === 'SKIP').length;

console.log('\n' + '='.repeat(84));
console.log('VERDICT');
console.log('='.repeat(84));
const padEnd = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
console.log(`${padEnd('CHECK', 26)}${padEnd('RESULT', 8)}EVIDENCE`);
console.log('-'.repeat(84));
for (const r of results) console.log(`${padEnd(r.name, 26)}${padEnd(r.status, 8)}${r.evidence}`);
console.log('-'.repeat(84));
console.log(`CANARY_RESULT pass=${nPass} fail=${nFail} skip=${nSkip}`);

if (nFail > 0 && exitCode === 0) exitCode = 1;
process.exit(exitCode);
