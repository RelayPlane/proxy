/**
 * `relayplane cc` — one-command setup + lifecycle for using RelayPlane as the
 * Claude Code gateway that delegates GLM/MiniMax subagents to their providers.
 *
 *   relayplane cc up      [--global | --project [path]] [--foreground]
 *   relayplane cc down    [--global | --project [path]]
 *   relayplane cc status
 *
 * Wires three things (proxy config is always global; the other two are scoped):
 *   - ~/.relayplane/config.json   nativeDelegate providers + routing.mode=standard
 *   - <scope>/.claude/settings.json   env.ANTHROPIC_BASE_URL → the proxy
 *   - <scope>/.claude/agents/{glm,minimax,deepseek-pro,deepseek-flash}.md  subagents
 *
 * Auth model: the main agent uses Claude Code's normal OAuth session
 * (passthrough). We never set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN, so the
 * OAuth session is left intact; if a turn ever fails auth, the user just
 * re-authorizes Claude Code. Provider keys (ZAI/MINIMAX/BYTEPLUS) live only in
 * ~/.relayplane/.env (chmod 600) and are injected into the proxy on start.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as net from 'net';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { openSync } from 'fs';

export const DELEGATE_PORT = 4100;
export const DELEGATE_HOST = '127.0.0.1';
export const DELEGATE_BASE_URL = `http://localhost:${DELEGATE_PORT}`;

type Json = Record<string, unknown>;

const PROVIDERS: Json = {
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic/v1/messages',
    openaiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    stripVendor: true,
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/anthropic/v1/messages',
    openaiBaseUrl: 'https://api.minimax.io/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    stripVendor: true,
  },
  // BytePlus ModelArk coding plan (Anthropic-compatible). Friendly slugs are
  // pinned to concrete date-versioned checkpoints via modelMap:
  //   byteplus/deepseek-pro   → deepseek-v4-pro-260425
  //   byteplus/deepseek-flash → deepseek-v4-flash-260425
  byteplus: {
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v1/messages',
    openaiBaseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    apiKeyEnv: 'BYTEPLUS_API_KEY',
    stripVendor: true,
    modelMap: {
      'byteplus/deepseek-pro': 'deepseek-v4-pro-260425',
      'byteplus/deepseek-flash': 'deepseek-v4-flash-260425',
    },
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic/v1/messages',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    stripVendor: true,
    modelMap: {
      'deepseek/deepseek-pro': 'deepseek-v4-pro',
      'deepseek/deepseek-flash': 'deepseek-v4-flash',
    },
  },
};

export const DELEGATE_KEY_SPECS = [
  { env: 'ZAI_API_KEY', label: 'z.ai (GLM) API key' },
  { env: 'MINIMAX_API_KEY', label: 'MiniMax API key' },
  { env: 'BYTEPLUS_API_KEY', label: 'BytePlus ModelArk (DeepSeek) API key' },
  { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek direct API key' },
];
const CLAUDE_CODE_KEY_SPECS = DELEGATE_KEY_SPECS.filter(({ env }) => env !== 'DEEPSEEK_API_KEY');

const AGENTS: Record<string, string> = {
  'glm.md': `---
name: glm
description: General-purpose helper that runs on Zhipu GLM (glm-5.2) via RelayPlane native delegation. Use for routine coding, summarization, and analysis tasks where GLM is preferred over Claude.
model: zai/glm-5.2
---

You are a focused engineering assistant running on the GLM model.
Answer directly and concisely. When editing code, make minimal, surgical changes
and match the surrounding style.
`,
  'minimax.md': `---
name: minimax
description: Reasoning-heavy helper that runs on MiniMax-M3 via RelayPlane native delegation. Use for tasks that benefit from explicit step-by-step reasoning (planning, debugging, multi-step analysis).
model: minimax/MiniMax-M3
---

You are a careful reasoning assistant running on the MiniMax-M3 model.
Think through the problem step by step, then give a clear, actionable answer.
When editing code, make minimal, surgical changes and match the surrounding style.
`,
  'deepseek-pro.md': `---
name: deepseek-pro
description: Capable coding helper that runs on DeepSeek-V4-Pro (deepseek-v4-pro-260425) via RelayPlane native delegation to BytePlus ModelArk. Use for substantial coding, refactoring, and analysis tasks.
model: byteplus/deepseek-pro
---

You are a capable engineering assistant running on the DeepSeek-V4-Pro model.
Answer directly and precisely. When editing code, make minimal, surgical changes
and match the surrounding style.
`,
  'deepseek-flash.md': `---
name: deepseek-flash
description: Fast, low-cost coding helper that runs on DeepSeek-V4-Flash (deepseek-v4-flash-260425) via RelayPlane native delegation to BytePlus ModelArk. Use for quick edits, summaries, and routine tasks where speed matters.
model: byteplus/deepseek-flash
---

You are a fast engineering assistant running on the DeepSeek-V4-Flash model.
Answer concisely. When editing code, make minimal, surgical changes and match the
surrounding style.
`,
};

// ── paths ────────────────────────────────────────────────────────────────────
function relayDir(): string { return join(homedir(), '.relayplane'); }
export function delegateConfigPath(): string { return process.env['RELAYPLANE_CONFIG_PATH'] || join(relayDir(), 'config.json'); }
export function delegateEnvFilePath(): string { return join(relayDir(), '.env'); }
function pidFilePath(): string { return join(relayDir(), 'proxy.pid'); }
function logFilePath(): string { return join(relayDir(), 'proxy.log'); }

interface Scope { kind: 'global' | 'project'; settingsPath: string; agentsDir: string; root: string; }
function resolveScope(args: string[]): Scope {
  const projIdx = args.indexOf('--project');
  if (projIdx !== -1) {
    const maybePath = args[projIdx + 1];
    const root = maybePath && !maybePath.startsWith('--') ? maybePath : process.cwd();
    return { kind: 'project', root, settingsPath: join(root, '.claude', 'settings.json'), agentsDir: join(root, '.claude', 'agents') };
  }
  const home = homedir();
  return { kind: 'global', root: home, settingsPath: join(home, '.claude', 'settings.json'), agentsDir: join(home, '.claude', 'agents') };
}

// ── json + fs helpers ────────────────────────────────────────────────────────
function readJson(p: string): Json {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as Json) : {}; }
  catch { console.warn(`  ⚠️  ${p} is not valid JSON — leaving it untouched and merging in memory.`); return {}; }
}
function writeJson(p: string, obj: Json): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}
function ensureDir(p: string): void { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

// ── hidden prompt (no extra deps) ────────────────────────────────────────────
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mute = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (s: string) => { if (!mute) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    mute = true;
  });
}

// ── keys: ~/.relayplane/.env (chmod 600) ─────────────────────────────────────
function parseEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
function writeEnvFile(p: string, kv: Record<string, string>): void {
  ensureDir(relayDir());
  const body = '# RelayPlane provider keys — injected into the proxy on start. Do not commit.\n' +
    Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(p, body, 'utf-8');
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
}

export async function collectDelegateKeys(
  keySpecs: ReadonlyArray<{ env: string; label: string }> = DELEGATE_KEY_SPECS,
): Promise<Record<string, string>> {
  const stored = parseEnvFile(delegateEnvFilePath());
  const result: Record<string, string> = { ...stored };
  for (const { env, label } of keySpecs) {
    if (process.env[env]) { result[env] = process.env[env]!; continue; }   // env wins
    if (stored[env]) continue;                                              // already saved
    if (!process.stdin.isTTY) {
      console.error(`  ✗ ${env} not set and no TTY for prompting. Set it in the environment or ${delegateEnvFilePath()} and retry.`);
      process.exit(1);
    }
    const val = await promptHidden(`  Enter ${label} (${env}): `);
    if (!val) { console.error(`  ✗ ${env} is required.`); process.exit(1); }
    result[env] = val;
  }
  writeEnvFile(delegateEnvFilePath(), result);
  return result;
}

// ── proxy config ─────────────────────────────────────────────────────────────
export function applyDelegateProxyConfig(): { routingChanged: boolean; prevMode?: string } {
  const cfg = readJson(delegateConfigPath());
  cfg['enabled'] = cfg['enabled'] !== false;
  cfg['first_run_complete'] = true;                       // stop auto-config from rewriting routing.mode
  const routing = (cfg['routing'] as Json) || {};
  const prevMode = routing['mode'] as string | undefined;
  const routingChanged = prevMode !== undefined && prevMode !== 'standard';
  routing['mode'] = 'standard';                           // delegation only fires in passthrough/standard
  cfg['routing'] = routing;
  const cache = (cfg['cache'] as Json) || {};
  cache['enabled'] = false;                               // avoid stream/non-stream cache collision for delegated calls
  cfg['cache'] = cache;
  const nd = (cfg['nativeDelegate'] as Json) || {};
  const providers = (nd['providers'] as Json) || {};
  providers['zai'] = PROVIDERS['zai'];
  providers['minimax'] = PROVIDERS['minimax'];
  providers['byteplus'] = PROVIDERS['byteplus'];
  providers['deepseek'] = PROVIDERS['deepseek'];
  nd['providers'] = providers;
  const switches = (nd['switch'] as Json) || {};
  switches['pro'] = {
    strategy: 'failover',
    members: ['deepseek/deepseek-pro', 'byteplus/deepseek-pro'],
  };
  switches['flash'] = {
    strategy: 'failover',
    members: ['deepseek/deepseek-flash', 'byteplus/deepseek-flash'],
  };
  nd['switch'] = switches;
  cfg['nativeDelegate'] = nd;
  writeJson(delegateConfigPath(), cfg);
  return { routingChanged, prevMode };
}

// ── claude code wiring (scoped) ──────────────────────────────────────────────
function setBaseUrl(scope: Scope): void {
  const s = readJson(scope.settingsPath);
  const env = (s['env'] as Json) || {};
  env['ANTHROPIC_BASE_URL'] = DELEGATE_BASE_URL;          // do NOT touch ANTHROPIC_API_KEY/AUTH_TOKEN (keep OAuth)
  s['env'] = env;
  writeJson(scope.settingsPath, s);
  if (scope.kind === 'global') {                          // skip Claude Code onboarding gate
    const dotClaude = join(homedir(), '.claude.json');
    const j = readJson(dotClaude);
    if (!j['hasCompletedOnboarding']) { j['hasCompletedOnboarding'] = true; writeJson(dotClaude, j); }
  }
}
function unsetBaseUrl(scope: Scope): void {
  if (!existsSync(scope.settingsPath)) return;
  const s = readJson(scope.settingsPath);
  const env = s['env'] as Json | undefined;
  if (env && env['ANTHROPIC_BASE_URL'] === DELEGATE_BASE_URL) {
    delete env['ANTHROPIC_BASE_URL'];
    if (Object.keys(env).length === 0) delete s['env'];
    writeJson(scope.settingsPath, s);
  }
}
function writeAgents(scope: Scope): void {
  ensureDir(scope.agentsDir);
  for (const [name, body] of Object.entries(AGENTS)) writeFileSync(join(scope.agentsDir, name), body, 'utf-8');
}
function removeAgents(scope: Scope): void {
  for (const name of Object.keys(AGENTS)) { const p = join(scope.agentsDir, name); if (existsSync(p)) { try { unlinkSync(p); } catch { /* ignore */ } } }
}

// ── proxy daemon lifecycle ───────────────────────────────────────────────────
export function isDelegatePortUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port: DELEGATE_PORT, host: DELEGATE_HOST });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}
export async function startDelegateDaemon(keys: Record<string, string>): Promise<boolean> {
  if (await isDelegatePortUp()) { console.log(`  ✓ Proxy already running on :${DELEGATE_PORT}`); return true; }
  ensureDir(relayDir());
  const out = openSync(logFilePath(), 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'start', '--port', String(DELEGATE_PORT)], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...keys },                     // inject provider keys into the proxy process
  });
  child.unref();
  writeFileSync(pidFilePath(), String(child.pid));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isDelegatePortUp()) { console.log(`  ✓ Proxy started (pid ${child.pid}, log ${logFilePath()})`); return true; }
  }
  console.error(`  ✗ Proxy did not come up within 5s — see ${logFilePath()}`);
  return false;
}
export function stopDelegateDaemon(): void {
  const pf = pidFilePath();
  if (!existsSync(pf)) { console.log('  ℹ️  No proxy.pid — nothing to stop (it may not be managed by RelayPlane setup).'); return; }
  try {
    const pid = parseInt(readFileSync(pf, 'utf-8').trim(), 10);
    if (!isNaN(pid)) { try { process.kill(pid); console.log(`  ✓ Stopped proxy (pid ${pid})`); } catch { console.log('  ℹ️  Proxy process already gone.'); } }
    unlinkSync(pf);
  } catch { /* best-effort */ }
}

// ── commands ─────────────────────────────────────────────────────────────────
async function ccUp(args: string[]): Promise<void> {
  const scope = resolveScope(args);
  const foreground = args.includes('--foreground');
  console.log(`\n  RelayPlane × Claude Code — setup (${scope.kind}${scope.kind === 'project' ? `: ${scope.root}` : ''})\n`);

  const keys = await collectDelegateKeys(CLAUDE_CODE_KEY_SPECS);
  console.log(`  ✓ Provider keys saved to ${delegateEnvFilePath()} (chmod 600)`);

  const { routingChanged, prevMode } = applyDelegateProxyConfig();
  console.log(`  ✓ Proxy config: ${delegateConfigPath()} (zai + minimax + byteplus + deepseek delegated, routing.mode=standard, cache off)`);
  if (routingChanged) console.log(`    ⚠️  Changed routing.mode "${prevMode}" → "standard" (delegation needs passthrough).`);

  setBaseUrl(scope);
  console.log(`  ✓ Claude Code wiring: ${scope.settingsPath} (ANTHROPIC_BASE_URL=${DELEGATE_BASE_URL}; OAuth left intact)`);

  writeAgents(scope);
  console.log(`  ✓ Subagents: ${Object.keys(AGENTS).map((n) => join(scope.agentsDir, n)).join(', ')}`);

  if (foreground) {
    console.log('\n  Setup complete. Start the proxy in this terminal:\n    relayplane start\n');
  } else {
    console.log('');
    await startDelegateDaemon(keys);
  }

  console.log('\n  Done. Next:');
  console.log(`    • ${scope.kind === 'project' ? `cd ${scope.root} && ` : ''}claude   ← main agent uses your Claude OAuth; delegate to the "glm" / "minimax" subagents`);
  console.log('    • Auth: if a Claude turn fails auth, just re-login Claude Code (OAuth is the default).');
  console.log('    • Persistent service: `relayplane service install` (systemd) to survive reboots.');
  console.log(`    • Tear down: relayplane cc down ${scope.kind === 'project' ? '--project' : '--global'}\n`);
}

function ccDown(args: string[]): void {
  const scope = resolveScope(args);
  console.log(`\n  RelayPlane × Claude Code — teardown (${scope.kind})\n`);
  unsetBaseUrl(scope);
  console.log(`  ✓ Removed ANTHROPIC_BASE_URL from ${scope.settingsPath}`);
  removeAgents(scope);
  console.log(`  ✓ Removed glm.md / minimax.md from ${scope.agentsDir}`);
  stopDelegateDaemon();
  console.log(`\n  Left in place: ${delegateConfigPath()} and ${delegateEnvFilePath()} (delete manually to fully reset).\n`);
}

async function ccStatus(): Promise<void> {
  console.log('\n  RelayPlane × Claude Code — status\n');
  const up = await isDelegatePortUp();
  console.log(`  Proxy (:${DELEGATE_PORT}): ${up ? '🟢 running' : '🔴 not running'}`);
  if (up) {
    try {
      const r = await fetch(`${DELEGATE_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
      console.log(`  Health: ${r.ok ? 'ok' : 'HTTP ' + r.status}`);
    } catch { console.log('  Health: (port open, /health not reachable)'); }
  }
  const cfg = readJson(delegateConfigPath());
  const providers = ((cfg['nativeDelegate'] as Json)?.['providers'] as Json) || {};
  const routing = (cfg['routing'] as Json)?.['mode'] ?? '(unset)';
  console.log(`  Config: ${delegateConfigPath()}  routing.mode=${routing}  delegated=[${Object.keys(providers).join(', ') || 'none'}]`);
  const env = parseEnvFile(delegateEnvFilePath());
  console.log(`  Keys (${delegateEnvFilePath()}): ${DELEGATE_KEY_SPECS.map((k) => `${k.env}=${env[k.env] || process.env[k.env] ? 'set' : 'MISSING'}`).join(', ')}`);
  for (const scope of [resolveScope(['--global']), resolveScope(['--project'])]) {
    const s = readJson(scope.settingsPath);
    const wired = ((s['env'] as Json)?.['ANTHROPIC_BASE_URL']) === DELEGATE_BASE_URL;
    const hasAgents = Object.keys(AGENTS).every((n) => existsSync(join(scope.agentsDir, n)));
    console.log(`  ${scope.kind.padEnd(7)}: base_url=${wired ? '✓' : '✗'}  agents=${hasAgents ? '✓' : '✗'}  (${scope.settingsPath})`);
  }
  console.log('');
}

export async function handleCcCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'up': await ccUp(args.slice(1)); break;
    case 'down': ccDown(args.slice(1)); break;
    case 'status': await ccStatus(); break;
    default:
      console.log(`
  relayplane cc — set up RelayPlane as the Claude Code gateway for GLM/MiniMax subagents

  Usage:
    relayplane cc up      [--global | --project [path]] [--foreground]
    relayplane cc down    [--global | --project [path]]
    relayplane cc status

  --global   (default) wire ~/.claude (settings + agents) for all projects
  --project  wire <path>/.claude (settings + agents) for one repo only
  --foreground   configure only; start the proxy yourself with \`relayplane start\`
`);
      if (sub && sub !== 'help' && sub !== '--help' && sub !== '-h') process.exit(1);
  }
}
