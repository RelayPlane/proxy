#!/usr/bin/env node
/**
 * RelayPlane Proxy CLI
 * 
 * Intelligent AI model routing proxy server.
 * 
 * Usage:
 *   npx @relayplane/proxy [command] [options]
 *   relayplane-proxy [command] [options]
 * 
 * Commands:
 *   (default)              Start the proxy server
 *   status                 Show proxy status (circuit state, stats, process info)
 *   enable                 Enable RelayPlane proxy routing
 *   disable                Disable RelayPlane proxy routing (passthrough mode)
 *   telemetry [on|off|status]  Manage telemetry settings
 *   stats                  Show usage statistics
 *   config                 Show configuration
 *   ensure-running         Start proxy if not running (idempotent, safe for hooks)
 *
 * Options:
 *   --port <number>    Port to listen on (default: 4100)
 *   --host <string>    Host to bind to (default: 127.0.0.1)
 *   --offline          Disable all network calls except LLM endpoints
 *   --audit            Show telemetry payloads before sending
 *   -v, --verbose      Enable verbose logging
 *   -h, --help         Show this help message
 *   --version          Show version
 * 
 * Environment Variables:
 *   ANTHROPIC_API_KEY  Anthropic API key
 *   OPENAI_API_KEY     OpenAI API key
 *   GEMINI_API_KEY     Google Gemini API key
 *   XAI_API_KEY        xAI/Grok API key
 *   OPENROUTER_API_KEY OpenRouter API key
 * 
 * @packageDocumentation
 */

import { startProxy } from './standalone-proxy.js';
import { fireDashboardLinked } from './lifecycle-telemetry.js';
import {
  loadConfig,
  isFirstRun,
  markFirstRunComplete,
  isTelemetryEnabled,
  enableTelemetry,
  disableTelemetry,
  getConfigPath,
  setApiKey,
  getMeshConfig,
  updateMeshConfig,
} from './config.js';
import {
  printTelemetryDisclosure,
  setAuditMode,
  setOfflineMode,
  getTelemetryStats,
  getTelemetryPath,
} from './telemetry.js';

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { homedir } from 'os';
import { loadPolicy, POLICY_FILE, type RoutingPolicy, type AgentPolicy } from './agent-policy.js';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import * as net from 'net';
import * as readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import * as os from 'node:os';
import { analyzeTraffic, estimateDailyCost } from './policy-analyzer.js';
import { detectAvailableProviders, suggestPolicies } from './policy-suggestions.js';
import type { AgentAnalysis } from './policy-analyzer.js';
import type { PolicySuggestion } from './policy-suggestions.js';
import { getAgentRegistry, loadAgentRegistry, flushAgentRegistry, renameAgent } from './agent-tracker.js';
import { getRoutingLog } from './routing-log.js';
import { resolvePolicy } from './agent-policy.js';
import { getResponseCache } from './response-cache.js';
import { getBudgetManager, getBudgetTracker } from './budget.js';
import { getAlertManager } from './alerts.js';

// __dirname is available natively in CJS

let VERSION = '0.0.0';
try {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  VERSION = pkg.version ?? '0.0.0';
} catch {
  // fallback
}

/**
 * Check for newer version (non-blocking, best-effort).
 * Primary: api.relayplane.com/v1/check (also serves as anonymous install ping).
 * Fallback: npm registry direct (if our API is down).
 * Returns update message string or null.
 */
async function checkForUpdate(): Promise<string | null> {
  if (process.env.RELAYPLANE_NO_UPDATE_CHECK === '1') return null;

  // Primary: call our API (also logs the install ping server-side)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const url = `https://api.relayplane.com/v1/check?v=${encodeURIComponent(VERSION)}&os=${encodeURIComponent(process.platform)}&arch=${encodeURIComponent(process.arch)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json() as { latest?: string; update?: boolean };
      if (data.update === true && data.latest) {
        return `\n  ⬆️  Update available: v${VERSION} → v${data.latest}\n     Run: npm update -g @relayplane/proxy\n`;
      }
      return null;
    }
  } catch {
    // API unavailable — fall through to npm fallback
  }

  // Fallback: hit npm registry directly
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://registry.npmjs.org/@relayplane/proxy/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === VERSION) return null;
    const cur = VERSION.split('.').map(Number);
    const lat = latest.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((lat[i] ?? 0) > (cur[i] ?? 0)) {
        return `\n  ⬆️  Update available: v${VERSION} → v${latest}\n     Run: npm update -g @relayplane/proxy\n`;
      }
      if ((lat[i] ?? 0) < (cur[i] ?? 0)) return null;
    }
    return null;
  } catch {
    return null; // Network error, offline, etc. — silently skip
  }
}

// ============================================
// CREDENTIALS MANAGEMENT
// ============================================

interface Credentials {
  apiKey: string;
  plan?: string;
  email?: string;
  teamId?: string;
  teamName?: string;
  loggedInAt?: string;
}

const CREDENTIALS_PATH = join(homedir(), '.relayplane', 'credentials.json');

function loadCredentials(): Credentials | null {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

function saveCredentials(creds: Credentials): void {
  const dir = dirname(CREDENTIALS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n');
}

function clearCredentials(): void {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      writeFileSync(CREDENTIALS_PATH, '{}');
    }
  } catch {}
}

const API_URL = process.env.RELAYPLANE_API_URL || 'https://api.relayplane.com';

// ============================================
// LOGIN COMMAND (Device OAuth Flow)
// ============================================

async function handleLoginCommand(): Promise<void> {
  const existing = loadCredentials();
  if (existing?.apiKey) {
    console.log('');
    console.log('  ✅ Already logged in');
    if (existing.email) console.log(`     Account: ${existing.email}`);
    if (existing.plan) console.log(`     Plan: ${existing.plan}`);
    console.log('');
    console.log('  Run `relayplane logout` first to switch accounts.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  🔐 Logging in to RelayPlane...');
  console.log('');

  try {
    // Start device auth flow
    const startRes = await fetch(`${API_URL}/v1/cli/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'relayplane-proxy', version: VERSION }),
    });

    if (!startRes.ok) {
      console.error('  ❌ Failed to start login flow. Is the API reachable?');
      process.exit(1);
    }

    const { deviceCode, userCode, verificationUrl: rawVerificationUrl, pollIntervalSec, expiresIn } = await startRes.json() as any;

    // Override old dashboard URL if the API returns it
    const verificationUrl = rawVerificationUrl?.includes('app.relayplane.com')
      ? rawVerificationUrl.replace('app.relayplane.com', 'relayplane.com')
      : rawVerificationUrl;

    console.log(`  Your one-time code:`);
    console.log('');
    console.log(`    📋 ${userCode}`);
    console.log('');

    // Try to auto-open the browser, fall back to "press Enter" prompt
    let browserOpened = false;
    const tryOpenBrowser = () => {
      try {
        const { execSync } = require('child_process');
        const openCmd = process.platform === 'darwin' ? 'open' 
          : process.platform === 'win32' ? 'start' 
          : 'xdg-open';
        execSync(`${openCmd} "${verificationUrl}" 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    };

    // Check if we have a display / can open a browser
    const hasDisplay = process.platform === 'darwin' || process.platform === 'win32' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;

    if (hasDisplay) {
      browserOpened = tryOpenBrowser();
    }

    if (browserOpened) {
      console.log(`  ✅ Browser opened to: ${verificationUrl}`);
      console.log(`     Paste the code above and approve.`);
    } else if (process.stdin.isTTY) {
      // Interactive terminal — let user press Enter to try opening, or copy manually
      console.log(`  Press Enter to open ${verificationUrl}`);
      console.log(`  (or open it manually and paste the code above)`);
      console.log('');

      // Wait for Enter (non-blocking — start polling in parallel)
      const waitForEnter = new Promise<void>((resolve) => {
        const onData = () => {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isRaw === false || !process.stdin.setRawMode) {
            // Normal line mode — Enter was pressed
          }
          tryOpenBrowser();
          resolve();
        };
        process.stdin.once('data', onData);
        // Auto-resolve after 30s so we don't block forever
        setTimeout(() => {
          process.stdin.removeListener('data', onData);
          resolve();
        }, 30000);
      });

      // Don't await — let polling start immediately
      waitForEnter.catch(() => {});
    } else {
      // Non-interactive (piped, CI, agent) — just show the URL
      console.log(`  Open this URL in your browser:`);
      console.log(`    ${verificationUrl}`);
      console.log(`  Then enter the code above.`);
    }

    console.log('');
    console.log(`  Waiting for approval (expires in ${Math.floor(expiresIn / 60)} minutes)...`);

    // Poll for approval
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, (pollIntervalSec || 5) * 1000));

      const pollRes = await fetch(`${API_URL}/v1/cli/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });

      if (!pollRes.ok) continue;

      const pollData = await pollRes.json() as any;

      if (pollData.status === 'approved') {
        saveCredentials({
          apiKey: pollData.accessToken,
          plan: pollData.plan || 'free',
          teamId: pollData.teamId,
          teamName: pollData.teamName,
          loggedInAt: new Date().toISOString(),
        });

        console.log('');
        console.log('  ✅ Login successful!');
        if (pollData.teamName) console.log(`     Team: ${pollData.teamName}`);
        console.log(`     Plan: ${pollData.plan || 'free'}`);
        console.log('');
        // Lifecycle telemetry: dashboard linked
        fireDashboardLinked();
        // Signal running proxy to pick up new credentials
        const proxyRunning = await fetch('http://127.0.0.1:4100/health', { signal: AbortSignal.timeout(1000) })
          .then(r => r.ok).catch(() => false);
        if (proxyRunning) {
          console.log('  ☁️  Cloud sync activated (proxy detected and notified).');
        } else {
          console.log('  ☁️  Cloud sync will activate on next proxy start.');
        }
        console.log('');
        return;
      }

      if (pollData.status === 'denied') {
        console.log('');
        console.log('  ❌ Login denied.');
        console.log('');
        process.exit(1);
      }

      if (pollData.status === 'expired') {
        console.log('');
        console.log('  ⏰ Login expired. Please try again.');
        console.log('');
        process.exit(1);
      }

      // Still pending, continue polling
      process.stdout.write('.');
    }

    console.log('');
    console.log('  ⏰ Login timed out. Please try again.');
    console.log('');
    process.exit(1);
  } catch (err) {
    console.error('  ❌ Login failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ============================================
// LOGOUT COMMAND
// ============================================

function handleLogoutCommand(): void {
  const creds = loadCredentials();
  clearCredentials();
  console.log('');
  if (creds?.apiKey) {
    console.log('  ✅ Logged out successfully.');
    console.log('     Cloud sync will stop on next proxy restart.');
  } else {
    console.log('  ℹ️  Not logged in.');
  }
  console.log('');
}

// ============================================
// UPGRADE COMMAND
// ============================================

function handleUpgradeCommand(): void {
  const url = 'https://relayplane.com/pricing';
  console.log('');
  console.log('  🚀 Opening pricing page...');
  console.log(`     ${url}`);
  console.log('');

  try {
    const { exec: execCmd } = require('child_process');
    const openCmd = process.platform === 'darwin' ? 'open' 
      : process.platform === 'win32' ? 'start' 
      : 'xdg-open';
    execCmd(`${openCmd} "${url}"`);
  } catch {}
}

// ============================================
// ENHANCED STATUS COMMAND  
// ============================================

async function handleCloudStatusCommand(): Promise<void> {
  const creds = loadCredentials();
  
  console.log('');
  console.log('  📊 RelayPlane Status');
  console.log('  ════════════════════');
  console.log('');
  
  // Proxy status
  let proxyReachable = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('http://127.0.0.1:4100/health', { signal: controller.signal });
    clearTimeout(timeout);
    proxyReachable = res.ok;
  } catch {}

  console.log(`  Proxy:       ${proxyReachable ? '🟢 Running' : '🔴 Stopped'}`);

  // Autostart status
  const rpConfig = loadRelayplaneConfig();
  if (rpConfig.autostart) {
    console.log(`  Autostart:   ✅ Enabled`);
  }
  
  // Auth status
  if (creds?.apiKey) {
    console.log(`  Account:     ✅ Logged in${creds.email ? ` (${creds.email})` : ''}`);
    console.log(`  Plan:        ${creds.plan || 'free'}`);
    console.log(`  API Key:     ••••${creds.apiKey.slice(-4)}`);
    
    // Check cloud sync
    if (proxyReachable) {
      console.log(`  Cloud sync:  ☁️  Active`);
    } else {
      console.log(`  Cloud sync:  ⏸️  Proxy not running`);
    }
    
    // Try to get fresh plan info from API
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${API_URL}/v1/cli/teams/current`, {
        signal: controller.signal,
        headers: { 'Authorization': `Bearer ${creds.apiKey}` },
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.plan && data.plan !== creds.plan) {
          creds.plan = data.plan;
          saveCredentials(creds);
          console.log(`  Plan (live):  ${data.plan}`);
        }
        if (data.teamName) console.log(`  Team:        ${data.teamName}`);
      }
    } catch {}
  } else {
    console.log(`  Account:     ❌ Not logged in`);
    console.log(`  Plan:        free (local only)`);
    console.log(`  Cloud sync:  ❌ Disabled`);
  }
  
  console.log('');
  if (!creds?.apiKey) {
    console.log('  Run `relayplane login` to enable cloud features.');
  } else if (creds.plan === 'free') {
    console.log('  Run `relayplane upgrade` to unlock cloud dashboard.');
  }
  console.log('');
}

/**
 * Singleton guard: start the proxy if not already running on :4100, exit immediately if it is.
 * Designed for use in Claude Code SessionStart hooks — fast, idempotent, no duplicate processes.
 */
async function handleEnsureRunning(): Promise<void> {
  const PORT = 4100;
  const HOST = '127.0.0.1';
  const relayDir = join(homedir(), '.relayplane');
  const pidFile = join(relayDir, 'proxy.pid');
  const logFile = join(relayDir, 'proxy.log');

  function isPortListening(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ port: PORT, host: HOST });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });
  }

  // Fast path: already running
  if (await isPortListening()) {
    console.log(`RelayPlane already running on :${PORT}`);
    return;
  }

  // Clean up stale PID file
  if (existsSync(pidFile)) {
    try {
      const stalePid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(stalePid)) {
        try { process.kill(stalePid, 0); } catch { unlinkSync(pidFile); }
      }
    } catch { /* best-effort */ }
  }

  // Ensure ~/.relayplane exists
  if (!existsSync(relayDir)) {
    mkdirSync(relayDir, { recursive: true });
  }

  // Spawn proxy as detached daemon
  const child = spawn(process.execPath, [process.argv[1]!], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
  child.unref();

  const pid = child.pid!;
  writeFileSync(pidFile, String(pid));

  // Poll for port to come up (up to 3s)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isPortListening()) {
      console.log(`RelayPlane started (pid: ${pid})`);
      return;
    }
  }

  process.stderr.write(`Error: RelayPlane did not start within 3s (pid: ${pid}, log: ${logFile})\n`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`
RelayPlane Proxy - Intelligent AI Model Routing

Usage:
  npx @relayplane/proxy [command] [options]
  relayplane-proxy [command] [options]

Commands:
  (default)              Start the proxy server
  init                   Interactive setup wizard (API key, budget cap, routing mode)
  login                  Log in to RelayPlane (opens browser)
  logout                 Clear stored credentials
  status                 Show proxy status, plan, and cloud sync
  upgrade                Open pricing page in browser
  enable                 Enable RelayPlane proxy routing
  disable                Disable RelayPlane proxy routing (passthrough mode)
  telemetry [on|off|status]  Manage telemetry settings
  stats                  Show usage statistics
  config                 Show configuration
  config set-key <key>   Set RelayPlane API key
  budget [status|set|reset]  Manage spend budgets and limits
  alerts [list|counts]   View cost alerts and anomaly history
  cache [on|off|status|clear|stats]  Manage response cache
  service [install|uninstall|status]  Manage system service (systemd/launchd)
  autostart [on|off|status]  Manage autostart on boot (systemd, legacy)
  mesh [status|on|off|sync|contribute]  Mesh learning layer management
  ensure-running         Start proxy if not running (idempotent, safe for hooks)

Options:
  --port <number>    Port to listen on (default: 4100)
  --host <string>    Host to bind to (default: 127.0.0.1)
  --offline          Disable all network calls except LLM endpoints
  --audit            Show telemetry payloads before sending
  -v, --verbose      Enable verbose logging
  -h, --help         Show this help message
  --version          Show version

Environment Variables:
  ANTHROPIC_API_KEY  Anthropic API key
  OPENAI_API_KEY     OpenAI API key
  GEMINI_API_KEY     Google Gemini API key (optional)
  XAI_API_KEY        xAI/Grok API key (optional)
  OPENROUTER_API_KEY OpenRouter API key (optional)

Example:
  # Start proxy on default port
  npx @relayplane/proxy

  # Start with audit mode (see telemetry before it's sent)
  npx @relayplane/proxy --audit

  # Start in offline mode (no telemetry transmission)
  npx @relayplane/proxy --offline

  # Disable telemetry completely
  npx @relayplane/proxy telemetry off

  # Point your agent at the proxy:
  # ANTHROPIC_BASE_URL=http://localhost:4100 your-agent
  # OPENAI_BASE_URL=http://localhost:4100/v1 your-agent

Learn more: https://relayplane.com/docs
`);
}

function printVersion(): void {
  console.log(`RelayPlane Proxy v${VERSION}`);
}

function handleTelemetryCommand(args: string[]): void {
  const subcommand = args[0];
  
  switch (subcommand) {
    case 'on':
      enableTelemetry();
      console.log('✅ Telemetry enabled');
      console.log('   Anonymous usage data will be collected to improve routing.');
      console.log('   Run with --audit to see exactly what\'s collected.');
      break;
      
    case 'off':
      disableTelemetry();
      console.log('✅ Telemetry disabled');
      console.log('   No usage data will be collected.');
      console.log('   The proxy will continue to work normally.');
      break;
      
    case 'status':
    default:
      const enabled = isTelemetryEnabled();
      console.log('');
      console.log('📊 Telemetry Status');
      console.log('───────────────────');
      console.log(`   Enabled: ${enabled ? '✅ Yes' : '❌ No'}`);
      console.log(`   Data file: ${getTelemetryPath()}`);
      console.log('');
      console.log('   To enable:  relayplane-proxy telemetry on');
      console.log('   To disable: relayplane-proxy telemetry off');
      console.log('   To audit:   relayplane-proxy --audit');
      console.log('');
      break;
  }
}

function handleStatsCommand(): void {
  const stats = getTelemetryStats();
  
  console.log('');
  console.log('📊 Usage Statistics');
  console.log('═══════════════════');
  console.log('');
  console.log(`  Total requests: ${stats.totalEvents}`);
  console.log(`  Actual cost:    $${stats.totalCost.toFixed(4)}`);
  console.log(`  Without RP:     $${stats.baselineCost.toFixed(4)}`);
  if (stats.savings > 0) {
    console.log(`  💰 You saved:   $${stats.savings.toFixed(4)} (${stats.savingsPercent.toFixed(1)}%)`);
  } else if (stats.totalEvents > 0 && stats.baselineCost === 0) {
    console.log(`  ⚠️  No token data yet — savings will appear after new requests`);
  }
  console.log(`  Success rate:   ${(stats.successRate * 100).toFixed(1)}%`);
  console.log('');
  
  if (Object.keys(stats.byModel).length > 0) {
    console.log('  By Model:');
    for (const [model, data] of Object.entries(stats.byModel)) {
      const savingsNote = data.baselineCost > 0
        ? ` (saved $${(data.baselineCost - data.cost).toFixed(4)} vs Opus)`
        : '';
      console.log(`    ${model}: ${data.count} requests, $${data.cost.toFixed(4)}${savingsNote}`);
    }
    console.log('');
  }
  
  if (Object.keys(stats.byTaskType).length > 0) {
    console.log('  By Task Type:');
    for (const [taskType, data] of Object.entries(stats.byTaskType)) {
      console.log(`    ${taskType}: ${data.count} requests, $${data.cost.toFixed(4)}`);
    }
    console.log('');
  }
  
  if (stats.totalEvents === 0) {
    console.log('  No data yet. Start using the proxy to collect statistics.');
    console.log('');
  }
}

async function handleStatusCommand(): Promise<void> {
  const { RelayPlaneMiddleware } = await import('./middleware.js');
  const { resolveConfig } = await import('./relay-config.js');

  const resolved = resolveConfig();
  const middleware = new RelayPlaneMiddleware({ config: { ...resolved, autoStart: false } });

  // Check if proxy is actually running by hitting /health
  let proxyReachable = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${resolved.proxyUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    proxyReachable = res.ok;
  } catch {
    // not running
  }

  console.log('');
  console.log(middleware.formatStatus());
  console.log('');
  if (proxyReachable) {
    console.log(`  🟢 Proxy is reachable at ${resolved.proxyUrl}`);
  } else {
    console.log(`  🔴 Proxy is not reachable at ${resolved.proxyUrl}`);
  }
  console.log('');

  middleware.destroy();
}

function getOpenClawConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function handleEnableDisableCommand(enable: boolean): void {
  const configPath = getOpenClawConfigPath();
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      // start fresh
    }
  }

  if (!config.relayplane || typeof config.relayplane !== 'object') {
    config.relayplane = {};
  }
  (config.relayplane as Record<string, unknown>).enabled = enable;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`✅ RelayPlane ${enable ? 'enabled' : 'disabled'}`);
  console.log(`   Updated ${configPath}`);
}

function handleConfigCommand(args: string[]): void {
  const subcommand = args[0];
  
  if (subcommand === 'set-key' && args[1]) {
    setApiKey(args[1]);
    console.log('✅ API key saved');
    console.log('   Pro features will be enabled on next proxy start.');
    return;
  }
  
  const config = loadConfig();
  
  console.log('');
  console.log('⚙️  Configuration');
  console.log('═════════════════');
  console.log('');
  console.log(`  Config file: ${getConfigPath()}`);
  console.log(`  Device ID:   ${config.device_id}`);
  console.log(`  Telemetry:   ${config.telemetry_enabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`  API Key:     ${config.api_key ? '••••' + config.api_key.slice(-4) : 'Not set'}`);
  console.log(`  Created:     ${config.created_at}`);
  console.log('');
  console.log('  To set API key: relayplane-proxy config set-key <your-key>');
  console.log('');
}

// ============================================
// AUTOSTART COMMAND
// ============================================

const RELAYPLANE_CONFIG_PATH = join(homedir(), '.relayplane', 'config.json');
const SERVICE_NAME = 'relayplane-proxy';
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

function loadRelayplaneConfig(): Record<string, any> {
  try {
    if (existsSync(RELAYPLANE_CONFIG_PATH)) {
      return JSON.parse(readFileSync(RELAYPLANE_CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveRelayplaneConfig(config: Record<string, any>): void {
  const dir = dirname(RELAYPLANE_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(RELAYPLANE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function hasSystemd(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('which systemctl', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function sanitizePosixUsername(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-\.]{0,31}$/.test(cleaned)) {
    console.error(`SUDO_USER "${cleaned}" is not a valid POSIX username. Aborting.`);
    process.exit(1);
  }
  return cleaned;
}

async function handleAutostartCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';

  if (process.platform !== 'linux' || !hasSystemd()) {
    console.log('  ⚠️  Autostart is only supported on Linux with systemd.');
    return;
  }

  if (sub === 'on') {
    if (!isRoot()) {
      console.log('  ⚠️  Autostart requires root. Try: sudo relayplane autostart on');
      return;
    }

    const { execSync } = require('child_process');
    // Detect binary path
    let binPath: string;
    try {
      binPath = execSync('which relayplane', { encoding: 'utf8' }).trim();
    } catch {
      if (isRoot()) {
        console.warn('  ⚠️  Could not find relayplane in PATH (sudo may have stripped it).');
        console.warn('     If the service fails to start, try: sudo env "PATH=$PATH" relayplane autostart on');
      }
      binPath = process.argv[0] ?? 'relayplane';
    }

    // Detect the real invoking user (not root) — sanitize to prevent injection
    const sudoUser = sanitizePosixUsername(process.env.SUDO_USER);
    let serviceUser: string;
    let serviceHome: string;
    if (sudoUser === 'root') {
      // root ran sudo as root — use root's real home
      serviceUser = 'root';
      serviceHome = '/root';
    } else if (sudoUser) {
      serviceUser = sudoUser;
      serviceHome = `/home/${sudoUser}`;
    } else {
      const userEnv = sanitizePosixUsername(process.env.USER);
      serviceUser = (userEnv && userEnv !== 'root') ? userEnv : 'root';
      serviceHome = (userEnv && userEnv !== 'root') ? `/home/${userEnv}` : homedir();
    }
    const resolvedAutoHome = resolve(serviceHome);
    if (resolvedAutoHome !== '/root' && !resolvedAutoHome.startsWith('/home/')) {
      console.error(`Computed home "${resolvedAutoHome}" is outside expected paths. Aborting.`);
      process.exit(1);
    }
    serviceHome = resolvedAutoHome;

    // Capture API keys from current environment for systemd
    const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY'];
    const envLines = envKeys
      .filter(k => process.env[k])
      .map(k => `Environment=${k}=${process.env[k]}`)
      .join('\n');

    const envFileLines = [
      `EnvironmentFile=-${serviceHome}/.env`,
      `EnvironmentFile=-${serviceHome}/.openclaw/.env`,
      `EnvironmentFile=-${serviceHome}/.relayplane/.env`,
    ].join('\n');

    const serviceContent = `[Unit]
Description=RelayPlane Proxy - Intelligent AI Model Routing
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${serviceUser}
ExecStart=${binPath}
Restart=always
RestartSec=3
${envFileLines}
Environment=HOME=${serviceHome}
${envLines}

[Install]
WantedBy=multi-user.target
`;

    writeFileSync(SERVICE_PATH, serviceContent);
    chmodSync(SERVICE_PATH, 0o600);
    execSync('systemctl daemon-reload && systemctl enable relayplane-proxy && systemctl start relayplane-proxy', { stdio: 'inherit' });

    // Save preference
    const config = loadRelayplaneConfig();
    config.autostart = true;
    saveRelayplaneConfig(config);

    console.log('  ✅ Autostart enabled. RelayPlane will start on boot and restart on crash.');
    return;
  }

  if (sub === 'off') {
    if (!isRoot()) {
      console.log('  ⚠️  Autostart requires root. Try: sudo relayplane autostart off');
      return;
    }

    const { execSync } = require('child_process');
    try {
      execSync('systemctl stop relayplane-proxy && systemctl disable relayplane-proxy', { stdio: 'inherit' });
    } catch {
      // Service may not exist
    }

    // Remove service file if it exists
    try {
      if (existsSync(SERVICE_PATH)) {
        const { unlinkSync } = require('fs');
        unlinkSync(SERVICE_PATH);
        execSync('systemctl daemon-reload', { stdio: 'inherit' });
      }
    } catch {}

    // Save preference
    const config = loadRelayplaneConfig();
    config.autostart = false;
    saveRelayplaneConfig(config);

    console.log('  ✅ Autostart disabled.');
    return;
  }

  // status (default)
  const { execSync } = require('child_process');
  let isEnabled = false;
  let isActive = false;

  try {
    const enabled = execSync(`systemctl is-enabled ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf8' }).trim();
    isEnabled = enabled === 'enabled';
  } catch {}

  try {
    const active = execSync(`systemctl is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf8' }).trim();
    isActive = active === 'active';
  } catch {}

  console.log('');
  console.log('  🔄 Autostart Status');
  console.log('  ═══════════════════');
  console.log(`  Service:  ${isEnabled ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`  Running:  ${isActive ? '🟢 Active' : '🔴 Inactive'}`);
  console.log('');
  if (!isEnabled) {
    console.log('  To enable:  sudo relayplane autostart on');
  } else {
    console.log('  To disable: sudo relayplane autostart off');
  }
  console.log('');
}

async function handleMeshCommand(args: string[]): Promise<void> {
  const meshCfg = getMeshConfig();
  const sub = args[0] ?? 'status';

  if (sub === 'status') {
    // Try hitting the running proxy's mesh stats endpoint
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:4100/v1/mesh/stats', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as { enabled: boolean; atoms_local: number; atoms_synced: number; last_sync: string | null; endpoint: string };
        console.log('');
        console.log('🧠 Mesh Learning Layer');
        console.log('══════════════════════');
        console.log(`  Enabled:       ${data.enabled ? '✅' : '❌'}`);
        console.log(`  Atoms (local): ${data.atoms_local}`);
        console.log(`  Atoms (synced): ${data.atoms_synced}`);
        console.log(`  Last sync:     ${data.last_sync ?? 'never'}`);
        console.log(`  Endpoint:      ${data.endpoint}`);
        console.log('');
        return;
      }
    } catch {
      // Proxy not running
    }

    console.log('');
    console.log('🧠 Mesh Learning Layer (proxy not running)');
    console.log('══════════════════════════════════════════');
    console.log(`  Enabled:        ${meshCfg.enabled ? '✅' : '❌'}`);
    console.log(`  Contribute:     ${meshCfg.contribute ? '✅' : '❌'}`);
    console.log(`  Endpoint:       ${meshCfg.endpoint}`);
    console.log(`  Sync interval:  ${meshCfg.sync_interval_ms / 1000}s`);
    console.log('');
    console.log('  Start the proxy to see live status.');
    console.log('');
    return;
  }

  if (sub === 'on') {
    updateMeshConfig({ enabled: true });
    console.log('  ✅ Mesh enabled. Restart the proxy for changes to take effect.');
    return;
  }

  if (sub === 'off') {
    updateMeshConfig({ enabled: false });
    console.log('  ❌ Mesh disabled. Restart the proxy for changes to take effect.');
    return;
  }

  if (sub === 'sync') {
    try {
      const res = await fetch('http://127.0.0.1:4100/v1/mesh/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { sync: { pushed?: number; pulled?: number; errors?: string[] } };
        if (data.sync.errors && data.sync.errors.length > 0) {
          console.log(`⚠️  Sync errors: ${data.sync.errors.join('; ')}`);
        } else {
          console.log(`✅ Synced: pushed ${data.sync.pushed ?? 0}, pulled ${data.sync.pulled ?? 0}`);
        }
      } else {
        console.log('❌ Sync failed — is the proxy running?');
      }
    } catch {
      console.log('❌ Cannot connect to proxy. Start it first.');
    }
    return;
  }

  if (sub === 'contribute') {
    const value = args[1]?.toLowerCase();
    if (!value || value === 'status') {
      console.log(`\n  Mesh contribution: ${meshCfg.contribute ? '✅ Enabled' : '❌ Disabled'}`);
      console.log('');
      return;
    }
    if (value === 'on') {
      updateMeshConfig({ contribute: true });
      console.log('\n  ✅ Mesh contribution enabled. Restart proxy for changes.\n');
      return;
    }
    if (value === 'off') {
      updateMeshConfig({ contribute: false });
      console.log('\n  ❌ Mesh contribution disabled. Restart proxy for changes.\n');
      return;
    }
    console.log('Usage: relayplane mesh contribute [on|off|status]');
    return;
  }

  console.log('Unknown mesh subcommand. Available: status, on, off, sync, contribute');
}

// ============================================
// SERVICE INSTALL/UNINSTALL/STATUS COMMAND
// ============================================

function getServiceAssetPath(): string {
  return join(__dirname, '..', 'assets', 'relayplane-proxy.service');
}

function generateLaunchdPlist(binPath: string): string {
  const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
  const envDict = envKeys
    .filter(k => process.env[k])
    .map(k => `      <key>${k}</key>\n      <string>${process.env[k]}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.relayplane.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homedir()}/Library/Logs/relayplane-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/Library/Logs/relayplane-proxy.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
${envDict}
  </dict>
</dict>
</plist>
`;
}

async function handleServiceCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const dryRun = args.includes('--dry-run');
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  if (!isMac && !isLinux) {
    console.log('  ⚠️  Service management is only supported on Linux (systemd) and macOS (launchd).');
    return;
  }

  const { execSync } = require('child_process');

  // Detect binary path
  let binPath: string;
  try {
    binPath = execSync('which relayplane', { encoding: 'utf8' }).trim();
  } catch {
    if (isRoot()) {
      console.warn('  ⚠️  Could not find relayplane in PATH (sudo may have stripped it).');
      console.warn('     If the service fails to start, try: sudo env "PATH=$PATH" relayplane service install');
    }
    binPath = process.argv[0] ?? 'relayplane';
  }

  if (sub === 'install') {
    if (isLinux) {
      if (!hasSystemd()) {
        console.log('  ⚠️  systemd not found on this system.');
        return;
      }
      if (!isRoot() && !dryRun) {
        console.log('  ⚠️  Service install requires root. Try: sudo relayplane service install');
        return;
      }

      // Detect the real invoking user (not root) — sanitize to prevent injection
      const sudoUser = sanitizePosixUsername(process.env.SUDO_USER);
      let serviceUser: string;
      let serviceHome: string;
      if (sudoUser === 'root') {
        // root ran sudo as root — use root's real home
        serviceUser = 'root';
        serviceHome = '/root';
      } else if (sudoUser) {
        serviceUser = sudoUser;
        serviceHome = `/home/${sudoUser}`;
      } else {
        const userEnv = sanitizePosixUsername(process.env.USER);
        serviceUser = (userEnv && userEnv !== 'root') ? userEnv : 'root';
        serviceHome = (userEnv && userEnv !== 'root') ? `/home/${userEnv}` : homedir();
      }
      const resolvedSvcHome = resolve(serviceHome);
      if (resolvedSvcHome !== '/root' && !resolvedSvcHome.startsWith('/home/')) {
        console.error(`Computed home "${resolvedSvcHome}" is outside expected paths. Aborting.`);
        process.exit(1);
      }
      serviceHome = resolvedSvcHome;

      // Read the shipped service template and patch ExecStart
      const assetPath = getServiceAssetPath();
      let serviceContent: string;
      if (existsSync(assetPath)) {
        serviceContent = readFileSync(assetPath, 'utf8');
        serviceContent = serviceContent.replace(/^ExecStart=.*$/m, `ExecStart=${binPath}`);
        serviceContent = serviceContent.replace(/^User=.*$/m, `User=${serviceUser}`);
        serviceContent = serviceContent.replace(/^Environment=HOME=.*$/m, `Environment=HOME=${serviceHome}`);
        // Insert EnvironmentFile lines before Environment= lines
        const envFileLines = [
          `EnvironmentFile=-${serviceHome}/.env`,
          `EnvironmentFile=-${serviceHome}/.openclaw/.env`,
          `EnvironmentFile=-${serviceHome}/.relayplane/.env`,
        ].join('\n');
        serviceContent = serviceContent.replace(/^(Environment=HOME=.*)$/m, `${envFileLines}
$1`);
      } else {
        // Fallback: generate inline — reuse already-sanitized serviceUser/serviceHome from above

        const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
        const envLines = envKeys
          .filter(k => process.env[k])
          .map(k => `Environment=${k}=${process.env[k]}`)
          .join('\n');
        const envFileLines = [
          `EnvironmentFile=-${serviceHome}/.env`,
          `EnvironmentFile=-${serviceHome}/.openclaw/.env`,
          `EnvironmentFile=-${serviceHome}/.relayplane/.env`,
        ].join('\n');
        serviceContent = `[Unit]
Description=RelayPlane Proxy - Intelligent AI Model Routing
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
User=${serviceUser}
ExecStart=${binPath}
Restart=always
RestartSec=5
WatchdogSec=30
StandardOutput=journal
StandardError=journal
${envFileLines}
Environment=HOME=${serviceHome}
Environment=NODE_ENV=production
${envLines}

[Install]
WantedBy=multi-user.target
`;
      }

      // Append current env API keys not already in template
      const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
      for (const key of envKeys) {
        if (process.env[key] && !serviceContent.includes(`Environment=${key}=`)) {
          serviceContent = serviceContent.replace(
            /\[Install\]/,
            `Environment=${key}=${process.env[key]}\n\n[Install]`
          );
        }
      }

      if (dryRun) {
        console.log('');
        console.log('  [DRY RUN] Would write to /etc/systemd/system/relayplane-proxy.service:');
        console.log('  ─────────────────────────────────────────');
        console.log(serviceContent);
        console.log('  ─────────────────────────────────────────');
        console.log('  [DRY RUN] Would run: systemctl daemon-reload && systemctl enable --now relayplane-proxy');
        console.log('');
        return;
      }

      writeFileSync(SERVICE_PATH, serviceContent);
      chmodSync(SERVICE_PATH, 0o600);
      execSync('systemctl daemon-reload && systemctl enable --now relayplane-proxy', { stdio: 'inherit' });

      const config = loadRelayplaneConfig();
      config.autostart = true;
      saveRelayplaneConfig(config);

      console.log('');
      console.log('  ✅ Service installed and started.');
      console.log('     RelayPlane will start on boot and restart on crash.');
      console.log('     Run `relayplane service status` to verify.');
      console.log('');

    } else if (isMac) {
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.relayplane.proxy.plist');

      const plistContent = generateLaunchdPlist(binPath);

      if (dryRun) {
        console.log('');
        console.log(`  [DRY RUN] Would write to ${plistPath}:`);
        console.log('  ─────────────────────────────────────────');
        console.log(plistContent);
        console.log('  ─────────────────────────────────────────');
        console.log(`  [DRY RUN] Would run: launchctl load ${plistPath}`);
        console.log('');
        return;
      }

      const dir = dirname(plistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(plistPath, plistContent);
      execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });

      console.log('');
      console.log('  ✅ Service installed and loaded via launchd.');
      console.log('     RelayPlane will start on login and restart on crash.');
      console.log('');
    }
    return;
  }

  if (sub === 'uninstall') {
    if (isLinux) {
      if (!isRoot() && !dryRun) {
        console.log('  ⚠️  Service uninstall requires root. Try: sudo relayplane service uninstall');
        return;
      }

      if (dryRun) {
        console.log('');
        console.log('  [DRY RUN] Would run: systemctl stop relayplane-proxy && systemctl disable relayplane-proxy');
        console.log('  [DRY RUN] Would remove /etc/systemd/system/relayplane-proxy.service');
        console.log('  [DRY RUN] Would run: systemctl daemon-reload');
        console.log('');
        return;
      }

      try {
        execSync('systemctl stop relayplane-proxy && systemctl disable relayplane-proxy', { stdio: 'inherit' });
      } catch { /* may not exist */ }

      try {
        if (existsSync(SERVICE_PATH)) {
          const { unlinkSync } = require('fs');
          unlinkSync(SERVICE_PATH);
          execSync('systemctl daemon-reload', { stdio: 'inherit' });
        }
      } catch {}

      const config = loadRelayplaneConfig();
      config.autostart = false;
      saveRelayplaneConfig(config);

      console.log('');
      console.log('  ✅ Service uninstalled.');
      console.log('');

    } else if (isMac) {
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.relayplane.proxy.plist');

      if (dryRun) {
        console.log('');
        console.log(`  [DRY RUN] Would run: launchctl unload ${plistPath}`);
        console.log(`  [DRY RUN] Would remove ${plistPath}`);
        console.log('');
        return;
      }

      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'inherit' });
      } catch {}

      try {
        if (existsSync(plistPath)) {
          const { unlinkSync } = require('fs');
          unlinkSync(plistPath);
        }
      } catch {}

      console.log('');
      console.log('  ✅ Service uninstalled from launchd.');
      console.log('');
    }
    return;
  }

  // status (default)
  if (isLinux && hasSystemd()) {
    let isEnabled = false;
    let isActive = false;
    let statusOutput = '';

    try {
      const enabled = execSync(`systemctl is-enabled ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf8' }).trim();
      isEnabled = enabled === 'enabled';
    } catch {}

    try {
      const active = execSync(`systemctl is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf8' }).trim();
      isActive = active === 'active';
    } catch {}

    try {
      statusOutput = execSync(`systemctl status ${SERVICE_NAME} 2>&1 || true`, { encoding: 'utf8' });
    } catch {}

    console.log('');
    console.log('  🔧 Service Status (systemd)');
    console.log('  ═══════════════════════════');
    console.log(`  Enabled:  ${isEnabled ? '✅ Yes' : '❌ No'}`);
    console.log(`  Running:  ${isActive ? '🟢 Active' : '🔴 Inactive'}`);
    console.log('');
    if (statusOutput) {
      console.log(statusOutput.split('\n').map(l => '  ' + l).join('\n'));
    }
    if (!isEnabled) {
      console.log('  To install: sudo relayplane service install');
    } else {
      console.log('  To uninstall: sudo relayplane service uninstall');
    }
    console.log('');

  } else if (isMac) {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.relayplane.proxy.plist');
    const installed = existsSync(plistPath);
    let isLoaded = false;

    try {
      const output = execSync('launchctl list com.relayplane.proxy 2>&1', { encoding: 'utf8' });
      isLoaded = !output.includes('Could not find');
    } catch {}

    console.log('');
    console.log('  🔧 Service Status (launchd)');
    console.log('  ═══════════════════════════');
    console.log(`  Installed: ${installed ? '✅ Yes' : '❌ No'}`);
    console.log(`  Loaded:    ${isLoaded ? '🟢 Yes' : '🔴 No'}`);
    console.log('');
    if (!installed) {
      console.log('  To install: relayplane service install');
    } else {
      console.log('  To uninstall: relayplane service uninstall');
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for help
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  // Check for version
  if (args.includes('--version')) {
    printVersion();
    process.exit(0);
  }

  // Handle commands
  const command = args[0];
  
  if (command === 'init') {
    await handleInitWizard();
    process.exit(0);
  }

  if (command === 'start') {
    // "relayplane start" just falls through to start the server
    args.shift();
  }

  const knownCommands = new Set([
    'init', 'start', 'telemetry', 'stats', 'config', 'login', 'logout', 'upgrade',
    'status', 'autostart', 'service', 'mesh', 'cache', 'budget', 'alerts', 'enable', 'disable',
    'ensure-running', 'agents', 'policy', 'setup',
  ]);

  if (command && !command.startsWith('-') && !knownCommands.has(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run relayplane --help to see available commands.');
    process.exit(1);
  }

  if (command === 'telemetry') {
    handleTelemetryCommand(args.slice(1));
    process.exit(0);
  }
  
  if (command === 'stats') {
    handleStatsCommand();
    process.exit(0);
  }
  
  if (command === 'config') {
    handleConfigCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'login') {
    await handleLoginCommand();
    process.exit(0);
  }

  if (command === 'logout') {
    handleLogoutCommand();
    process.exit(0);
  }

  if (command === 'upgrade') {
    handleUpgradeCommand();
    process.exit(0);
  }

  if (command === 'status') {
    await handleCloudStatusCommand();
    process.exit(0);
  }

  if (command === 'autostart') {
    await handleAutostartCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'service') {
    await handleServiceCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'mesh') {
    await handleMeshCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'cache') {
    handleCacheCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'budget') {
    handleBudgetCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'alerts') {
    handleAlertsCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'enable') {
    handleEnableDisableCommand(true);
    process.exit(0);
  }

  if (command === 'disable') {
    handleEnableDisableCommand(false);
    process.exit(0);
  }

  if (command === 'ensure-running') {
    await handleEnsureRunning();
    process.exit(0);
  }

  if (command === 'agents') {
    handleAgentsCommand(args.slice(1));
    process.exit(0);
  }

  if (command === 'setup') {
    await handleSetupCommand();
    process.exit(0);
  }

  if (command === 'policy') {
    await handlePolicyCommand(args.slice(1));
    process.exit(0);
  }

  // Parse server options
  let port = 4100;
  let host = '127.0.0.1';
  let verbose = false;
  let audit = false;
  let offline = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Error: Invalid port number');
        process.exit(1);
      }
      i++;
    } else if (arg === '--host' && args[i + 1]) {
      host = args[i + 1]!;
      i++;
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (arg === '--audit') {
      audit = true;
    } else if (arg === '--offline') {
      offline = true;
    }
  }

  // Set modes
  setAuditMode(audit);
  setOfflineMode(offline);

  // First run disclosure
  if (isFirstRun()) {
    printTelemetryDisclosure();
    markFirstRunComplete();
    
    // Wait for user to read (brief pause)
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Auto-load .env file (cwd first, then home directory) so keys set in .env work without manual export
  const envPaths = [join(process.cwd(), '.env'), join(homedir(), '.env')];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const lines = readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx < 1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      } catch { /* best-effort */ }
      break; // Only load first .env found
    }
  }

  // Check for at least one API key
  const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];
  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  const hasGeminiKey = !!process.env['GEMINI_API_KEY'];
  const hasXAIKey = !!process.env['XAI_API_KEY'];
  const hasOpenRouterKey = !!process.env['OPENROUTER_API_KEY'];
  const hasDeepSeekKey = !!process.env['DEEPSEEK_API_KEY'];
  const hasGroqKey = !!process.env['GROQ_API_KEY'];
  const hasMoonshotKey = !!process.env['MOONSHOT_API_KEY'];

  if (!hasAnthropicKey && !hasOpenAIKey && !hasGeminiKey && !hasXAIKey && !hasOpenRouterKey && !hasDeepSeekKey && !hasGroqKey && !hasMoonshotKey) {
    // Max plan / Claude Code users: no API key needed — auth passes through from Claude Code
    console.log('  ℹ️  No API key set — running in passthrough mode.');
    console.log('     Claude Code (Max plan) users: this is correct, no key needed.');
    console.log('     API key users: set ANTHROPIC_API_KEY to enable env-based auth.');
    console.log('');
  }

  // Print startup info
  console.log('');
  console.log('  ╭─────────────────────────────────────────╮');
  console.log(`  │       RelayPlane Proxy v${VERSION}          │`);
  console.log('  │    Intelligent AI Model Routing         │');
  console.log('  ╰─────────────────────────────────────────╯');
  console.log('');
  
  // Show modes
  const telemetryEnabled = isTelemetryEnabled();
  const creds = loadCredentials();
  console.log('  Mode:');
  if (offline) {
    console.log('    🔒 Offline (no telemetry transmission)');
  } else if (audit) {
    console.log('    🔍 Audit (showing telemetry payloads)');
  } else if (telemetryEnabled) {
    console.log('    📊 Telemetry enabled (--audit to inspect, telemetry off to disable)');
  } else {
    console.log('    📴 Telemetry disabled');
  }

  // Cloud sync status
  if (creds?.apiKey && !offline) {
    console.log(`    ☁️  Cloud sync: active (plan: ${creds.plan || 'free'})`);
  } else if (!creds?.apiKey) {
    console.log('    💻 Local only (run `relayplane login` for cloud sync)');
  }
  
  console.log('');
  console.log('  Providers:');
  if (hasAnthropicKey) {
    console.log('    ✓ Anthropic (API key)');
  } else {
    console.log('    ✓ Anthropic (Max plan / Claude Code passthrough)');
  }
  if (hasOpenAIKey) console.log('    ✓ OpenAI');
  if (hasGeminiKey) console.log('    ✓ Google Gemini');
  if (hasXAIKey) console.log('    ✓ xAI (Grok)');
  if (hasOpenRouterKey) console.log('    ✓ OpenRouter');
  if (hasDeepSeekKey) console.log('    ✓ DeepSeek');
  if (hasGroqKey) console.log('    ✓ Groq');
  console.log('');

  try {
    await startProxy({ port, host, verbose });
    
    console.log('  Ready. Point Claude Code at the proxy:');
    console.log('');
    console.log(`    export ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log('    # then run: claude (Max plan — no API key needed)');
    console.log('');
    console.log(`  Dashboard → http://localhost:${port}`);
    console.log('');
    if (!hasAnthropicKey) {
      console.log('  Tip: add the export to your ~/.zshrc or ~/.bashrc to make it permanent.');
      console.log('');
    }

    // Non-blocking update check (fires after startup, doesn't delay anything)
    if (!offline) {
      checkForUpdate().then(msg => {
        if (msg) console.log(msg);
      });
    }
  } catch (err) {
    console.error('Failed to start proxy:', err);
    process.exit(1);
  }
}

function handleAlertsCommand(args: string[]): void {
  const sub = args[0] ?? 'list';
  const alertMgr = getAlertManager({ enabled: true });

  try { alertMgr.init(); } catch { /* ok */ }

  if (sub === 'list' || sub === 'recent') {
    const limit = parseInt(args[1] ?? '20', 10);
    const recent = alertMgr.getRecent(limit);
    console.log('');
    console.log('🔔 Recent Alerts');
    console.log('═════════════════');
    if (recent.length === 0) {
      console.log('  No alerts yet.');
    } else {
      for (const a of recent) {
        const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : 'ℹ️';
        const time = new Date(a.timestamp).toISOString().slice(0, 19);
        console.log(`  ${icon} [${time}] ${a.type}: ${a.message}`);
      }
    }
    console.log('');
    alertMgr.close();
    return;
  }

  if (sub === 'counts') {
    const counts = alertMgr.getCounts();
    console.log('');
    console.log('🔔 Alert Counts');
    console.log(`   Threshold: ${counts.threshold}`);
    console.log(`   Anomaly:   ${counts.anomaly}`);
    console.log(`   Breach:    ${counts.breach}`);
    console.log('');
    alertMgr.close();
    return;
  }

  console.log('Usage: relayplane alerts [list|counts]');
  alertMgr.close();
}

// ============================================
// INIT WIZARD
// ============================================

/**
 * Interactive 6-step setup wizard for new users (esp. refugees from direct Anthropic billing).
 * Prompts for: API key, daily budget cap, routing mode → writes ~/.relayplane/config.json.
 *
 * Falls back to non-interactive init when stdin is not a TTY (CI/CD, piped scripts).
 */
async function handleInitWizard(): Promise<void> {
  const configDir = join(homedir(), '.relayplane');
  const configPath = join(configDir, 'config.json');

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;

  if (!isTTY) {
    // Non-interactive: ensure config exists, auto-detect OpenRouter-only setups, and exit
    loadConfig();

    // Auto-detect OpenRouter-only setup
    const hasOpenRouterKey = !!process.env['OPENROUTER_API_KEY'];
    const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];
    const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
    if (hasOpenRouterKey && !hasAnthropicKey && !hasOpenAIKey) {
      try {
        let rawCfg: Record<string, unknown> = {};
        if (existsSync(configPath)) rawCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (!rawCfg['defaultProvider']) {
          rawCfg['defaultProvider'] = 'openrouter';
          writeFileSync(configPath, JSON.stringify(rawCfg, null, 2));
          console.log('[RelayPlane] Auto-configured defaultProvider: "openrouter" (OpenRouter-only setup detected)');
        }
      } catch { /* best-effort — never block init */ }
    }

    console.log('✅ RelayPlane initialized');
    console.log(`   Config: ${configPath}`);
    return;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));

  const hr = '  ─────────────────────────────────────────────────';

  // Load raw config JSON (may include fields unknown to ProxyConfig)
  let rawConfig: Record<string, unknown> = {};
  const configExists = existsSync(configPath);
  if (configExists) {
    try {
      rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      rawConfig = {};
    }
  }

  // Detect existing values
  const existingProviders = rawConfig['providers'] as Record<string, unknown> | undefined;
  const existingAnthropicAccounts = (
    existingProviders?.['anthropic'] as Record<string, unknown> | undefined
  )?.['accounts'] as Array<{ label: string; apiKey: string }> | undefined;
  const existingApiKey = existingAnthropicAccounts?.[0]?.apiKey ?? '';

  const existingBudget = rawConfig['budget'] as Record<string, unknown> | undefined;
  const existingDailyUsd = typeof existingBudget?.['dailyUsd'] === 'number'
    ? (existingBudget['dailyUsd'] as number)
    : null;
  const existingOnBreach = typeof existingBudget?.['onBreach'] === 'string'
    ? (existingBudget['onBreach'] as string)
    : null;

  // ── Banner ───────────────────────────────────────────────────────────────

  console.log('');
  console.log('  ╭─────────────────────────────────────────────╮');
  console.log('  │       RelayPlane Setup Wizard               │');
  console.log('  │  Cost-intelligent routing for AI agents     │');
  console.log('  ╰─────────────────────────────────────────────╯');
  console.log('');

  if (configExists) {
    console.log(`  Existing config found at: ${configPath}`);
    console.log('  (Pre-filling with saved values — press Enter to keep)');
  } else {
    console.log('  No config found — setting up fresh.');
  }
  console.log('');

  // ── Step 1: API Key ───────────────────────────────────────────────────────

  console.log('  Step 1/4  ·  Anthropic API Key');
  console.log(hr);
  console.log('  RelayPlane routes requests through your own API key.');
  console.log('  Your key is stored locally in ~/.relayplane/config.json');
  console.log('  and is never sent to RelayPlane servers.');
  console.log('');

  let apiKeyDisplay = '';
  if (existingApiKey) {
    const masked = existingApiKey.slice(0, 12) + '****' + existingApiKey.slice(-4);
    apiKeyDisplay = ` [${masked}]`;
  }

  const rawApiKey = await prompt(`  ? Anthropic API key (sk-ant-...)${apiKeyDisplay}: `);
  const apiKey = rawApiKey || existingApiKey;

  if (apiKey && !apiKey.startsWith('sk-ant-') && !apiKey.startsWith('sk-')) {
    console.log('  ⚠️  Key format looks unexpected (expected sk-ant-... or sk-...). Proceeding anyway.');
  }
  console.log('');

  // ── Step 2: Daily Budget ──────────────────────────────────────────────────

  console.log('  Step 2/4  ·  Daily Budget Cap');
  console.log(hr);
  console.log('  Set a daily spend limit to protect against runaway costs.');
  console.log('  RelayPlane can automatically downgrade models when you approach the cap.');
  console.log('');

  const defaultDaily = existingDailyUsd ?? 10;
  const rawDaily = await prompt(`  ? Daily budget cap in USD [default: $${defaultDaily.toFixed(2)}]: `);

  let dailyCapUsd: number = defaultDaily;
  if (rawDaily) {
    const parsed = parseFloat(rawDaily.replace(/^\$/, ''));
    if (!isNaN(parsed) && parsed > 0) {
      dailyCapUsd = parsed;
    } else {
      console.log(`  ⚠️  Invalid value, using default $${defaultDaily.toFixed(2)}`);
    }
  }
  console.log('');

  // ── Step 3: Routing Mode ──────────────────────────────────────────────────

  console.log('  Step 3/4  ·  Routing Mode');
  console.log(hr);
  console.log('  How should RelayPlane handle budget breaches?');
  console.log('');
  console.log('    [1] Smart  — Auto-downgrade to cheaper models (recommended)');
  console.log('    [2] Strict — Block all requests when daily limit is reached (402)');
  console.log('    [3] Off    — No budget enforcement');
  console.log('');

  let defaultMode = '1';
  if (existingOnBreach === 'block') defaultMode = '2';
  else if (existingBudget?.['enabled'] === false) defaultMode = '3';

  const rawMode = await prompt(`  ? Your choice [${defaultMode}]: `);
  const modeChoice = rawMode || defaultMode;

  let onBreach: string;
  let budgetEnabled: boolean;
  let modeLabel: string;

  if (modeChoice === '2') {
    onBreach = 'block';
    budgetEnabled = true;
    modeLabel = 'strict (block on breach)';
  } else if (modeChoice === '3') {
    onBreach = 'downgrade';
    budgetEnabled = false;
    modeLabel = 'off (no enforcement)';
  } else {
    onBreach = 'downgrade';
    budgetEnabled = true;
    modeLabel = 'smart (auto-downgrade)';
  }
  console.log('');

  // ── Step 4: Summary + confirm ─────────────────────────────────────────────

  console.log('  Step 4/4  ·  Summary');
  console.log(hr);
  if (apiKey) {
    const masked = apiKey.slice(0, 12) + '****' + apiKey.slice(-4);
    console.log(`  API Key:     ${masked}`);
  } else {
    console.log('  API Key:     (none — will use ANTHROPIC_API_KEY env var)');
  }
  console.log(`  Daily cap:   $${dailyCapUsd.toFixed(2)}`);
  console.log(`  Routing:     ${modeLabel}`);
  console.log(`  Config:      ${configPath}`);
  console.log('');

  const confirm = await prompt('  ? Write config and finish? [Y/n]: ');
  rl.close();

  if (confirm.toLowerCase() === 'n') {
    console.log('');
    console.log('  Aborted — no changes written.');
    console.log('');
    return;
  }

  // ── Step 5 (internal): Write config ─────────────────────────────────────

  // Ensure base RelayPlane config exists (device_id, telemetry, etc.)
  const baseConfig = loadConfig();
  // loadConfig() already wrote a config.json with base fields; now read it back as raw JSON
  // so we can safely merge in provider + budget fields without losing anything.
  try {
    rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    rawConfig = {};
  }

  // Write provider API key if provided
  if (apiKey) {
    const providers = (rawConfig['providers'] as Record<string, unknown>) ?? {};
    const anthropic = (providers['anthropic'] as Record<string, unknown>) ?? {};
    const accounts = (anthropic['accounts'] as Array<Record<string, unknown>>) ?? [];

    if (accounts.length > 0) {
      // Update first account's key
      accounts[0]!['apiKey'] = apiKey;
      accounts[0]!['label'] = accounts[0]!['label'] ?? 'default';
    } else {
      accounts.push({ label: 'default', apiKey });
    }

    anthropic['accounts'] = accounts;
    providers['anthropic'] = anthropic;
    rawConfig['providers'] = providers;
  }

  // Write budget config
  const budget = (rawConfig['budget'] as Record<string, unknown>) ?? {};
  budget['enabled'] = budgetEnabled;
  budget['dailyUsd'] = dailyCapUsd;
  budget['dailyCapUSD'] = dailyCapUsd;
  budget['onBreach'] = onBreach;
  rawConfig['budget'] = budget;

  // Atomic write
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath + '.tmp', JSON.stringify(rawConfig, null, 2) + '\n');
  const { renameSync } = require('fs');
  renameSync(configPath + '.tmp', configPath);

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log('');
  console.log('  ✅ RelayPlane configured!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Start the proxy:');
  console.log('         relayplane start');
  console.log('');
  console.log('    2. Point your AI agent at the proxy:');
  console.log('         export ANTHROPIC_BASE_URL=http://localhost:4100');
  console.log('         export OPENAI_BASE_URL=http://localhost:4100');
  console.log('');
  console.log('    3. Check your costs:');
  console.log('         relayplane stats');
  console.log('         relayplane budget status');
  console.log('');

  void baseConfig; // suppress unused warning
}

function handleBudgetCommand(args: string[]): void {
  const sub = args[0] ?? 'status';
  const budget = getBudgetManager();

  if (sub === 'status') {
    try { budget.init(); } catch { /* ok */ }
    const status = budget.getStatus();
    const config = budget.getConfig();
    const tracker = getBudgetTracker();
    try { tracker.init(); } catch { /* ok */ }
    const cap = tracker.getCap();
    const todaySpend = tracker.getDailySpend();
    console.log('');
    console.log('💰 Budget Status');
    console.log(`   Enabled:     ${config.enabled ? '✅' : '❌'}`);
    if (cap !== null) {
      const pct = cap > 0 ? (todaySpend / cap) * 100 : 0;
      const bar = pct >= 100 ? '🚫 BLOCKED' : pct >= 80 ? '⚠️  warning' : '✅ ok';
      console.log(`   Daily cap:   $${todaySpend.toFixed(4)} / $${cap.toFixed(2)} (${pct.toFixed(1)}%) ${bar}`);
    } else {
      console.log(`   Daily cap:   $${todaySpend.toFixed(4)} / unlimited`);
    }
    console.log(`   Daily:       $${status.dailySpend.toFixed(4)} / $${status.dailyLimit} (${status.dailyPercent.toFixed(1)}%)`);
    console.log(`   Hourly:      $${status.hourlySpend.toFixed(4)} / $${status.hourlyLimit} (${status.hourlyPercent.toFixed(1)}%)`);
    console.log(`   Per-request: max $${config.perRequestUsd}`);
    console.log(`   On breach:   ${config.onBreach}`);
    if (status.breached) {
      console.log(`   ⚠️  BREACHED: ${status.breachType}`);
    }
    console.log('');
    tracker.close();
    budget.close();
    return;
  }

  if (sub === 'set') {
    const daily = args.find((a, i) => args[i - 1] === '--daily');
    const hourly = args.find((a, i) => args[i - 1] === '--hourly');
    const perReq = args.find((a, i) => args[i - 1] === '--per-request');
    if (daily) budget.setLimits({ dailyUsd: parseFloat(daily) });
    if (hourly) budget.setLimits({ hourlyUsd: parseFloat(hourly) });
    if (perReq) budget.setLimits({ perRequestUsd: parseFloat(perReq) });
    console.log('✅ Budget limits updated');
    budget.close();
    return;
  }

  if (sub === 'reset') {
    try { budget.init(); } catch { /* ok */ }
    budget.reset();
    console.log('✅ Budget spend reset for current window');
    budget.close();
    return;
  }

  if (sub === 'history') {
    const daysArg = parseInt(args[1] ?? '7', 10);
    const days = isNaN(daysArg) ? 7 : daysArg;
    const tracker = getBudgetTracker();
    try { tracker.init(); } catch { /* ok */ }
    const history = tracker.getHistory(days);
    const cap = tracker.getCap();
    console.log('');
    console.log(`📅 Budget History (last ${days} days)`);
    if (cap !== null) {
      console.log(`   Daily cap: $${cap.toFixed(2)}`);
    }
    if (history.length === 0) {
      console.log('   No spend recorded.');
    } else {
      for (const day of history) {
        const pct = cap !== null && cap > 0 ? ` (${((day.totalSpend / cap) * 100).toFixed(1)}%)` : '';
        console.log(`   ${day.date}  $${day.totalSpend.toFixed(4)}${pct}`);
        for (const [model, amt] of Object.entries(day.byModel)) {
          console.log(`     ↳ ${model}: $${amt.toFixed(4)}`);
        }
      }
    }
    console.log('');
    tracker.close();
    budget.close();
    return;
  }

  console.log('Usage: relayplane budget [status|set|reset|history]');
  console.log('  set --daily <usd> --hourly <usd> --per-request <usd>');
  console.log('  history [days]   Show daily spend history (default: 7 days)');
  budget.close();
}

function handleCacheCommand(args: string[]): void {
  const sub = args[0] ?? 'status';
  const cache = getResponseCache();

  if (sub === 'status') {
    try { cache.init(); } catch { /* ok */ }
    const status = cache.getStatus();
    console.log('');
    console.log('📦 Response Cache Status');
    console.log(`   Enabled:    ${status.enabled ? '✅' : '❌'}`);
    console.log(`   Entries:    ${status.entries}`);
    console.log(`   Size:       ${status.sizeMb} MB`);
    console.log(`   Hit rate:   ${status.hitRate}`);
    console.log(`   Saved:      $${status.savedCostUsd}`);
    console.log('');
    return;
  }

  if (sub === 'clear') {
    try { cache.init(); } catch { /* ok */ }
    cache.clear();
    console.log('✅ Cache cleared');
    return;
  }

  if (sub === 'stats') {
    try { cache.init(); } catch { /* ok */ }
    const stats = cache.getStats();
    console.log('');
    console.log('📊 Cache Statistics');
    console.log(`   Total entries:  ${stats.totalEntries}`);
    console.log(`   Total size:     ${(stats.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`   Hit rate:       ${(stats.hitRate * 100).toFixed(1)}%`);
    console.log(`   Hits: ${stats.hits}  Misses: ${stats.misses}  Bypasses: ${stats.bypasses}`);
    console.log(`   Saved:          $${stats.savedCostUsd.toFixed(4)} across ${stats.savedRequests} requests`);
    console.log('');
    const models = Object.entries(stats.byModel);
    if (models.length > 0) {
      console.log('   By Model:');
      for (const [model, m] of models) {
        console.log(`     ${model}: ${m.entries} entries, ${m.hits} hits, $${m.savedCostUsd.toFixed(4)} saved`);
      }
    }
    const tasks = Object.entries(stats.byTaskType);
    if (tasks.length > 0) {
      console.log('   By Task Type:');
      for (const [task, t] of tasks) {
        console.log(`     ${task}: ${t.entries} entries, ${t.hits} hits, $${t.savedCostUsd.toFixed(4)} saved`);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'on') {
    cache.setEnabled(true);
    console.log('✅ Cache enabled');
    return;
  }

  if (sub === 'off') {
    cache.setEnabled(false);
    console.log('✅ Cache disabled');
    return;
  }

  console.log('Usage: relayplane cache [status|clear|stats|on|off]');
}

// ─── agents commands ──────────────────────────────────────────────────────────

function handleAgentsCommand(subArgs: string[]): void {
  const sub = subArgs[0];
  if (sub !== 'list') {
    console.log('Usage: relayplane agents list');
    return;
  }

  const registryFile = join(homedir(), '.relayplane', 'agents.json');
  if (!existsSync(registryFile)) {
    console.log('No agents found. Run the proxy to start tracking agents.');
    return;
  }

  let registry: Record<string, { name: string; fingerprint: string; lastSeen: string; totalRequests: number; totalCost: number }>;
  try {
    registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
  } catch {
    console.error('Failed to read agents registry');
    return;
  }

  const entries = Object.values(registry);
  if (entries.length === 0) {
    console.log('No agents found.');
    return;
  }

  // Format relative time
  function relTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }

  const fpLen = 18;
  const nameLen = 16;
  const lastLen = 18;
  const reqLen = 10;
  const costLen = 10;

  const header =
    'FINGERPRINT'.padEnd(fpLen) +
    'NAME'.padEnd(nameLen) +
    'LAST SEEN'.padEnd(lastLen) +
    'REQUESTS'.padEnd(reqLen) +
    'COST'.padEnd(costLen);
  console.log('');
  console.log(header);
  console.log('-'.repeat(fpLen + nameLen + lastLen + reqLen + costLen));
  for (const e of entries) {
    const row =
      (e.fingerprint ?? '—').padEnd(fpLen) +
      (e.name ?? '—').padEnd(nameLen) +
      relTime(e.lastSeen ?? '').padEnd(lastLen) +
      (e.totalRequests?.toLocaleString() ?? '0').padEnd(reqLen) +
      ('$' + (e.totalCost ?? 0).toFixed(2)).padEnd(costLen);
    console.log(row);
  }
  console.log('');
}

// ─── policy commands ──────────────────────────────────────────────────────────

async function handlePolicyCommand(subArgs: string[]): Promise<void> {
  const sub = subArgs[0];

  if (sub === 'show') {
    if (!existsSync(POLICY_FILE)) {
      console.log("No policy file found. Run 'relayplane policy init' to create one.");
      return;
    }
    const policy = loadPolicy();
    console.log('');
    console.log('Policy file:', POLICY_FILE);
    console.log(`Version: ${policy.version}`);
    if (policy.agents && Object.keys(policy.agents).length > 0) {
      console.log('');
      console.log('Agent rules:');
      for (const [name, agent] of Object.entries(policy.agents)) {
        let line = `  ${name}: preferred=${agent.preferred}`;
        if (agent.escalateTo) line += ` escalateTo=${agent.escalateTo}`;
        if (agent.neverDowngrade) line += ' neverDowngrade=true';
        if (agent.budgetPerDay !== undefined) line += ` budgetPerDay=$${agent.budgetPerDay}`;
        console.log(line);
      }
    }
    if (policy.tasks && Object.keys(policy.tasks).length > 0) {
      console.log('');
      console.log('Task rules:');
      for (const [taskType, task] of Object.entries(policy.tasks)) {
        let line = `  ${taskType}: preferred=${task.preferred}`;
        if (task.escalateTo) line += ` escalateTo=${task.escalateTo}`;
        if (task.neverDowngrade) line += ' neverDowngrade=true';
        console.log(line);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'init') {
    const force = subArgs.includes('--force');
    if (existsSync(POLICY_FILE) && !force) {
      console.error("policy.yaml already exists. Use --force to overwrite.");
      process.exit(1);
    }

    const registryFile = join(homedir(), '.relayplane', 'agents.json');
    let registry: Record<string, { name: string; fingerprint: string; totalRequests: number; totalCost: number }> = {};
    if (existsSync(registryFile)) {
      try {
        registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
      } catch {
        // use empty registry
      }
    }

    const agents: Record<string, {
      fingerprint: string;
      preferred: string;
    }> = {};

    for (const [fp, entry] of Object.entries(registry)) {
      const avgCost = entry.totalRequests > 0 ? entry.totalCost / entry.totalRequests : 0;
      const preferred = avgCost > 0.01 ? 'anthropic/claude-sonnet-4-6' : 'cheapest-capable';
      agents[entry.name] = {
        fingerprint: fp,
        preferred,
      };
    }

    const policy = { version: 1, agents: Object.keys(agents).length > 0 ? agents : undefined };
    const yaml = yamlDump(policy, { lineWidth: 120 });

    mkdirSync(join(homedir(), '.relayplane'), { recursive: true });
    writeFileSync(POLICY_FILE, yaml, 'utf-8');
    const count = Object.keys(agents).length;
    console.log(`Wrote ${POLICY_FILE} with ${count} agent${count !== 1 ? 's' : ''}. Edit to customize, then restart the proxy.`);
    return;
  }

  if (sub === 'set-agent') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: relayplane policy set-agent <name> --preferred <model> [--escalate <model>] [--budget <amount>]');
      process.exit(1);
    }

    // Parse options
    let preferred: string | undefined;
    let escalateTo: string | undefined;
    let budget: number | undefined;

    for (let i = 2; i < subArgs.length; i++) {
      if (subArgs[i] === '--preferred' && subArgs[i + 1]) {
        preferred = subArgs[i + 1];
        i++;
      } else if (subArgs[i] === '--escalate' && subArgs[i + 1]) {
        escalateTo = subArgs[i + 1];
        i++;
      } else if (subArgs[i] === '--budget' && subArgs[i + 1]) {
        budget = parseFloat(subArgs[i + 1]!);
        i++;
      }
    }

    if (!preferred) {
      console.error('--preferred is required');
      process.exit(1);
    }

    // Load or create policy
    let rawPolicy: Record<string, unknown> = { version: 1 };
    if (existsSync(POLICY_FILE)) {
      try {
        rawPolicy = (yamlLoad(readFileSync(POLICY_FILE, 'utf-8')) as Record<string, unknown>) ?? { version: 1 };
      } catch {
        rawPolicy = { version: 1 };
      }
    }

    if (!rawPolicy.agents || typeof rawPolicy.agents !== 'object') {
      rawPolicy.agents = {};
    }
    const agentsObj = rawPolicy.agents as Record<string, Record<string, unknown>>;
    const existing = agentsObj[name] ?? {};
    const updated: Record<string, unknown> = { ...existing, preferred };
    if (escalateTo) updated['escalateTo'] = escalateTo;
    if (budget !== undefined && !isNaN(budget)) updated['budgetPerDay'] = budget;
    agentsObj[name] = updated;

    // Atomic write via tmp + rename
    mkdirSync(join(homedir(), '.relayplane'), { recursive: true });
    const tmp = POLICY_FILE + '.tmp';
    writeFileSync(tmp, yamlDump(rawPolicy, { lineWidth: 120 }), 'utf-8');
    renameSync(tmp, POLICY_FILE);
    console.log(`Updated policy for agent "${name}": preferred=${preferred}${escalateTo ? ` escalateTo=${escalateTo}` : ''}${budget !== undefined ? ` budgetPerDay=$${budget}` : ''}`);
    return;
  }

  // ── policy auto ──────────────────────────────────────────────────────────

  if (sub === 'auto') {
    const yesFlag = subArgs.includes('--yes') || subArgs.includes('-y');
    let lookbackDays = 7;
    const lookbackIdx = subArgs.indexOf('--lookback');
    if (lookbackIdx !== -1 && subArgs[lookbackIdx + 1]) {
      lookbackDays = parseInt(subArgs[lookbackIdx + 1]!, 10) || 7;
    }

    process.stdout.write(`Analyzing ${lookbackDays} days of traffic...`);
    const analyses = await analyzeTraffic({ lookbackDays });
    process.stdout.write('\n');

    if (analyses.length === 0) {
      console.log('');
      console.log('  No traffic data found.');
      console.log('  Run RelayPlane for at least a day and try again.');
      console.log('  (or use --lookback 30 to look further back)');
      console.log('');
      return;
    }

    const availableProviders = detectAvailableProviders();
    await _runPolicyAutoDisplay(analyses, availableProviders, yesFlag, true);
    return;
  }

  // ── policy suggest ────────────────────────────────────────────────────────

  if (sub === 'suggest') {
    let lookbackDays = 7;
    const lookbackIdx = subArgs.indexOf('--lookback');
    if (lookbackIdx !== -1 && subArgs[lookbackIdx + 1]) {
      lookbackDays = parseInt(subArgs[lookbackIdx + 1]!, 10) || 7;
    }

    process.stdout.write(`Analyzing ${lookbackDays} days of traffic...`);
    const analyses = await analyzeTraffic({ lookbackDays });
    process.stdout.write('\n');

    if (analyses.length === 0) {
      console.log('');
      console.log('  No traffic data found.');
      console.log('  Run RelayPlane for at least a day and try again.');
      console.log('');
      return;
    }

    const availableProviders = detectAvailableProviders();
    await _runPolicyAutoDisplay(analyses, availableProviders, false, false);
    return;
  }

  // ── policy test ───────────────────────────────────────────────────────────

  if (sub === 'test') {
    let requestCount = 50;
    let policyPath: string | undefined;
    for (let i = 1; i < subArgs.length; i++) {
      if (subArgs[i] === '--requests' && subArgs[i + 1]) {
        requestCount = parseInt(subArgs[i + 1]!, 10) || 50;
        i++;
      } else if (subArgs[i] === '--policy' && subArgs[i + 1]) {
        policyPath = subArgs[i + 1];
        i++;
      }
    }

    const entries = getRoutingLog({ limit: requestCount });
    if (entries.length === 0) {
      console.log('No routing log entries found. Run RelayPlane first to generate traffic.');
      return;
    }

    let testPolicy: RoutingPolicy;
    let policySource: string;

    if (policyPath) {
      const raw = readFileSync(policyPath, 'utf-8');
      testPolicy = yamlLoad(raw) as RoutingPolicy;
      policySource = basename(policyPath);
    } else if (existsSync(POLICY_FILE)) {
      testPolicy = loadPolicy();
      policySource = 'policy.yaml';
    } else {
      const analyses = await analyzeTraffic({ lookbackDays: 7 });
      const providers = detectAvailableProviders();
      const suggestions = suggestPolicies(analyses, providers);
      testPolicy = _buildPolicyFromSuggestions(analyses, suggestions);
      policySource = 'proposed policy';
    }

    console.log(`Replaying last ${entries.length} requests against ${policySource}...`);
    console.log('');

    const changes: Array<{ fingerprint: string; taskType: string; from: string; to: string; savedCost: number }> = [];
    for (const entry of entries) {
      const resolution = resolvePolicy(
        testPolicy,
        entry.agentFingerprint ?? undefined,
        entry.agentName ?? undefined,
        entry.taskType,
        entry.complexity as 'simple' | 'moderate' | 'complex',
        entry.resolvedModel,
      );
      if (resolution.model !== entry.resolvedModel) {
        const savedCost =
          estimateDailyCost(entry.inputTokens ?? 1000, entry.outputTokens ?? 200, 1, entry.resolvedModel) -
          estimateDailyCost(entry.inputTokens ?? 1000, entry.outputTokens ?? 200, 1, resolution.model);
        changes.push({
          fingerprint: (entry.agentFingerprint ?? 'unknown').slice(0, 8),
          taskType: entry.taskType,
          from: entry.resolvedModel,
          to: resolution.model,
          savedCost,
        });
      }
    }

    const total = entries.length;
    const changed = changes.length;
    const same = total - changed;

    if (changed === 0) {
      console.log(`  All ${total} requests would route identically. No savings from this policy.`);
    } else {
      console.log(`  ${changed}/${total} would route differently`);
      console.log(`  ${same}/${total} would route identically`);
      console.log('');
      console.log('Changes:');
      for (const c of changes) {
        console.log(`  ${c.fingerprint} / ${c.taskType}:  ${c.from} → ${c.to}`);
      }
    }

    const totalSavings = Math.max(0, changes.reduce((sum, c) => sum + c.savedCost, 0));
    console.log('');
    console.log(`Estimated savings across these ${total} requests: $${totalSavings.toFixed(4)}`);

    // Only prompt if testing proposed policy (not existing or --policy flag)
    if (!policyPath && !existsSync(POLICY_FILE) && changes.length > 0) {
      console.log('');
      process.stdout.write('Apply this policy now? (y/n) ');
      const answer = await _promptLine();
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        const analyses = await analyzeTraffic({ lookbackDays: 7 });
        const providers = detectAvailableProviders();
        const suggestions = suggestPolicies(analyses, providers);
        const yaml = _buildPolicyYaml(analyses, suggestions);
        mkdirSync(join(homedir(), '.relayplane'), { recursive: true });
        const tmp = POLICY_FILE + '.tmp';
        writeFileSync(tmp, yaml, 'utf-8');
        renameSync(tmp, POLICY_FILE);
        const n = analyses.length;
        console.log(`\nPolicy applied. Routing active for ${n} agent${n !== 1 ? 's' : ''}.`);
      } else {
        console.log('Discarded. No changes made.');
      }
    }
    return;
  }

  // ── policy rename ─────────────────────────────────────────────────────────

  if (sub === 'rename') {
    const arg = subArgs[1];
    const newName = subArgs[2];
    if (!arg || !newName) {
      console.error('Usage: relayplane policy rename <fingerprint-or-name> <new-name>');
      process.exit(1);
    }

    loadAgentRegistry();
    const registry = getAgentRegistry();

    // Find by fingerprint (exact) or name (case-insensitive)
    let foundFp: string | undefined;
    let oldName: string | undefined;
    for (const [fp, entry] of Object.entries(registry)) {
      if (fp === arg || entry.name.toLowerCase() === arg.toLowerCase()) {
        foundFp = fp;
        oldName = entry.name;
        break;
      }
    }

    if (!foundFp || !oldName) {
      console.error(`Error: No agent found with fingerprint or name "${arg}".`);
      process.exit(1);
    }

    renameAgent(foundFp, newName);
    flushAgentRegistry();

    // Update POLICY_FILE if it exists
    if (existsSync(POLICY_FILE)) {
      try {
        let rawPolicy = yamlLoad(readFileSync(POLICY_FILE, 'utf-8')) as Record<string, unknown>;
        if (!rawPolicy) rawPolicy = { version: 1 };
        const agents = rawPolicy['agents'] as Record<string, unknown> | undefined;
        if (agents && agents[oldName] !== undefined) {
          agents[newName] = agents[oldName];
          delete agents[oldName];
          const tmp = POLICY_FILE + '.tmp';
          writeFileSync(tmp, yamlDump(rawPolicy, { lineWidth: 120 }), 'utf-8');
          renameSync(tmp, POLICY_FILE);
        }
      } catch {
        // Best-effort — don't fail rename if policy update fails
      }
    }

    console.log(`Renamed: ${oldName} → ${newName} (${foundFp})`);
    return;
  }

  // ── policy reset ──────────────────────────────────────────────────────────

  if (sub === 'reset') {
    const confirm = subArgs.includes('--confirm');

    if (!confirm) {
      const existingPolicy = loadPolicy();
      const agentCount = Object.keys(existingPolicy.agents ?? {}).length;
      console.log('This will remove your routing policy and return to passthrough mode.');
      console.log(`All ${agentCount} agent rule${agentCount !== 1 ? 's' : ''} will be deleted.`);
      console.log('Run again with --confirm to proceed: relayplane policy reset --confirm');
      return;
    }

    if (!existsSync(POLICY_FILE)) {
      console.log('No policy file found — already in passthrough mode.');
      return;
    }

    renameSync(POLICY_FILE, POLICY_FILE + '.bak');
    console.log('Policy reset. RelayPlane is now in passthrough mode.');
    console.log(`Backup saved at: ${POLICY_FILE}.bak`);
    return;
  }

  console.log('Usage: relayplane policy [auto|suggest|test|rename|reset|init|show|set-agent]');
}

// ─── Policy auto helpers ───────────────────────────────────────────────────────

function _promptLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
    rl.once('close', () => resolve(''));
  });
}

function _buildPolicyFromSuggestions(
  analyses: AgentAnalysis[],
  suggestions: PolicySuggestion[],
): RoutingPolicy {
  const agents: Record<string, AgentPolicy> = {};
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i]!;
    const s = suggestions[i]!;
    if (s.noSuggestion) continue;
    const entry: AgentPolicy = {
      fingerprint: a.fingerprint,
      preferred: s.suggestedModel,
    };
    if (s.escalateTo) entry.escalateTo = s.escalateTo;
    if (s.escalateOn) entry.escalateOn = s.escalateOn;
    if (s.neverDowngrade) entry.neverDowngrade = true;
    agents[a.name] = entry;
  }
  return { version: 1, agents };
}

function _buildPolicyYaml(analyses: AgentAnalysis[], suggestions: PolicySuggestion[]): string {
  const isoDate = new Date().toISOString().slice(0, 10);
  const header = [
    '# RelayPlane routing policy',
    `# Generated by \`relayplane policy auto\` on ${isoDate}`,
    '# Edit manually or re-run `relayplane policy auto` to regenerate.',
    '# Reset to passthrough: `relayplane policy reset`',
    '',
  ].join('\n');

  const agents: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i]!;
    const s = suggestions[i]!;
    if (s.noSuggestion) continue;
    const entry: Record<string, unknown> = {
      fingerprint: a.fingerprint,
      preferred: s.suggestedModel,
    };
    if (s.escalateTo) entry['escalateTo'] = s.escalateTo;
    if (s.escalateOn) entry['escalateOn'] = s.escalateOn;
    if (s.neverDowngrade) entry['neverDowngrade'] = true;
    agents[a.name] = entry;
  }

  const body = yamlDump({ version: 1, agents }, { lineWidth: 120 });
  return header + body;
}

async function _runPolicyAutoDisplay(
  analyses: AgentAnalysis[],
  availableProviders: string[],
  autoApply: boolean,
  interactive: boolean,
): Promise<void> {
  const suggestions = suggestPolicies(analyses, availableProviders);

  // Phase 2 — Agent display
  const n = analyses.length;
  console.log('');
  console.log(`Detected ${n} agent${n !== 1 ? 's' : ''}:`);
  console.log('');

  const maxNameLen = Math.max(...analyses.map(a => a.name.length)) + 2;
  const lowDataAgents: string[] = [];

  for (const a of analyses) {
    const fpShort = a.fingerprint.slice(0, 8);
    const namePad = a.name.padEnd(maxNameLen);
    const pct = Math.round((a.taskDistribution[a.dominantTask] ?? 0) * 100);
    const avgK = Math.round(a.avgTotalTokens / 1000);
    const estFlag = a.tokensAreEstimated ? ' ~' : '';
    const cost = a.costPerDay.toFixed(2);
    console.log(`  ${fpShort}  →  "${namePad}"  (${pct}% ${a.dominantTask} tasks, avg ${avgK}K tokens${estFlag}, $${cost}/day)`);
    if (a.totalRequests < 3) {
      lowDataAgents.push(a.name);
    }
  }

  if (lowDataAgents.length > 0) {
    console.log('');
    for (const name of lowDataAgents) {
      const a = analyses.find(x => x.name === name)!;
      console.log(`  ⚠ ${name}: only ${a.totalRequests} requests — suggestions may be inaccurate`);
    }
  }

  // Phase 3 — Suggestions
  console.log('');
  console.log('Suggested policy (based on task patterns + your available keys):');
  console.log('');

  const maxSuggestNameLen = Math.max(...analyses.map(a => a.name.length)) + 2;
  let totalMonthlySavings = 0;

  for (const s of suggestions) {
    const namePad = s.agentName.padEnd(maxSuggestNameLen);
    if (s.noSuggestion) {
      console.log(`  ${namePad}  →  ${s.currentModel}  (already optimal)`);
    } else {
      const escNote = s.escalateTo ? `  (escalate to ${s.escalateTo} on complexity)` : '';
      const savingsNote = s.estimatedDailySavings > 0.01
        ? `saves ~$${s.estimatedDailySavings.toFixed(2)}/day`
        : '(no change)';
      console.log(`  ${namePad}  →  ${s.suggestedModel}${escNote}  ${savingsNote}`);
      totalMonthlySavings += s.estimatedMonthlySavings;
    }
  }

  console.log('');
  console.log(`Projected monthly savings: ~$${Math.round(totalMonthlySavings)}`);
  console.log('');

  if (!interactive) {
    // policy suggest — print CTA and exit
    console.log('To apply this policy, run: relayplane policy auto');
    return;
  }

  // Phase 4 — Confirmation
  if (existsSync(POLICY_FILE)) {
    const existingPolicy = loadPolicy();
    const existingAgents = Object.keys(existingPolicy.agents ?? {}).join(', ');
    console.log(`⚠ Existing policy will be replaced. Previous: ${existingAgents || 'no agents'}.`);
    console.log('');
  }

  let answer: string;
  if (autoApply) {
    answer = 'y';
  } else {
    process.stdout.write('Apply this policy? (y/n/edit) ');
    answer = await _promptLine();
  }

  if (answer === 'edit' || answer === 'e') {
    const tmpPath = join(os.tmpdir(), `relayplane-policy-${Date.now()}.yaml`);
    const proposedYaml = _buildPolicyYaml(analyses, suggestions);
    writeFileSync(tmpPath, proposedYaml, 'utf-8');

    const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'nano';
    try {
      spawnSync(editor, [tmpPath], { stdio: 'inherit' });
    } catch {
      spawnSync('vi', [tmpPath], { stdio: 'inherit' });
    }

    const editedYaml = readFileSync(tmpPath, 'utf-8');
    try { unlinkSync(tmpPath); } catch { /* ok */ }

    // Validate the edited YAML
    const parsed = yamlLoad(editedYaml) as { version?: number } | null;
    if (!parsed || parsed.version !== 1) {
      console.error('Invalid policy YAML (must have version: 1). Discarded.');
      return;
    }

    mkdirSync(join(homedir(), '.relayplane'), { recursive: true });
    const tmp = POLICY_FILE + '.tmp';
    writeFileSync(tmp, editedYaml, 'utf-8');
    renameSync(tmp, POLICY_FILE);
    console.log('\nPolicy applied (edited version).');
    return;
  }

  if (answer === '' || answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
    console.log('Discarded. No changes made.');
    return;
  }

  // Phase 5 — Write
  const yaml = _buildPolicyYaml(analyses, suggestions);
  mkdirSync(join(homedir(), '.relayplane'), { recursive: true });
  const tmp = POLICY_FILE + '.tmp';
  writeFileSync(tmp, yaml, 'utf-8');
  renameSync(tmp, POLICY_FILE);
  const agentCount = analyses.filter((_, i) => !suggestions[i]?.noSuggestion).length;
  console.log('');
  console.log(`Policy applied. Routing active for ${agentCount} agent${agentCount !== 1 ? 's' : ''}.`);
  console.log('Run `relayplane policy show` to review.');
}

// ─── setup command ─────────────────────────────────────────────────────────────

async function handleSetupCommand(): Promise<void> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;

  console.log('Welcome to RelayPlane.');
  console.log('Cost intelligence for AI agents.');
  console.log('');

  // Step 1 — Provider detection
  console.log('Step 1/3 — Providers');
  console.log('  Which AI providers do you have API keys for?');
  console.log('');

  const detectedProviders = detectAvailableProviders();
  const allProviders: Array<{ name: string; displayName: string; detected: boolean; detectedEnv?: string; isLocal?: boolean }> = [
    { name: 'anthropic',  displayName: 'Anthropic',     detected: detectedProviders.includes('anthropic'), detectedEnv: process.env['ANTHROPIC_API_KEY'] ? 'ANTHROPIC_API_KEY' : undefined },
    { name: 'openai',     displayName: 'OpenAI',        detected: detectedProviders.includes('openai'),    detectedEnv: process.env['OPENAI_API_KEY'] ? 'OPENAI_API_KEY' : undefined },
    { name: 'google',     displayName: 'Google Gemini', detected: detectedProviders.includes('google'),    detectedEnv: process.env['GEMINI_API_KEY'] ? 'GEMINI_API_KEY' : (process.env['GOOGLE_API_KEY'] ? 'GOOGLE_API_KEY' : undefined) },
    { name: 'groq',       displayName: 'Groq',          detected: detectedProviders.includes('groq'),      detectedEnv: process.env['GROQ_API_KEY'] ? 'GROQ_API_KEY' : undefined },
    { name: 'openrouter', displayName: 'OpenRouter',    detected: detectedProviders.includes('openrouter'), detectedEnv: process.env['OPENROUTER_API_KEY'] ? 'OPENROUTER_API_KEY' : undefined },
    { name: 'ollama',     displayName: 'Ollama',        detected: false, isLocal: true },
  ];

  for (const p of allProviders) {
    const checkbox = p.detected ? '[x]' : '[ ]';
    const detectedNote = p.detected && p.detectedEnv ? ` (detected: ${p.detectedEnv})` : '';
    const localNote = p.isLocal ? '  (local)' : '';
    console.log(`  ${checkbox} ${p.displayName}${detectedNote}${localNote}`);
  }
  console.log('');

  let confirmedProviders = [...detectedProviders];

  if (!isTTY) {
    // Non-TTY fast path
    if (confirmedProviders.length === 0) {
      console.log('  ⚠ No provider keys detected. RelayPlane will run in passthrough/observe mode.');
      console.log('  You can add keys later: relayplane config set-key');
    }
    console.log('');
    console.log('Step 2/3 — Routing mode');
    console.log('  Auto mode selected (non-interactive).');
    console.log('');
    console.log('Step 3/3 — Done');
    console.log('');
    console.log('  RelayPlane is ready.');
    console.log('');
    console.log('  Proxy:        http://localhost:4100');
    console.log('  Configure:    ANTHROPIC_BASE_URL=http://localhost:4100');
    console.log('');
    console.log('  Next: run RelayPlane for a day, then:');
    console.log('    relayplane policy auto    # auto-configure routing');
    console.log('    relayplane policy suggest  # preview recommendations');
    console.log('');
    console.log('  Docs: https://relayplane.com/docs');
    console.log('');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));

  const addInput = await prompt('Press Enter to confirm, or list provider names to add (comma-separated): ');
  if (addInput) {
    const extras = addInput.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const e of extras) {
      if (!confirmedProviders.includes(e)) confirmedProviders.push(e);
    }
  }

  if (confirmedProviders.length === 0) {
    console.log('  ⚠ No provider keys detected. RelayPlane will run in passthrough/observe mode.');
    console.log('  You can add keys later: relayplane config set-key');
  }

  // Step 2 — Routing mode
  console.log('');
  console.log('Step 2/3 — Routing mode');
  console.log('  How should RelayPlane route your requests?');
  console.log('');
  console.log('  1. Auto (recommended) — route by task complexity, cheapest capable model');
  console.log('  2. Manual — I\'ll configure routing rules myself');
  console.log('  3. Passthrough — just observe costs, no routing changes');
  console.log('');

  const modeInput = await prompt('Choice [1]: ');
  let routingMode: 'auto' | 'manual' | 'passthrough' = 'auto';
  if (modeInput === '2' || modeInput.toLowerCase() === 'manual') routingMode = 'manual';
  else if (modeInput === '3' || modeInput.toLowerCase() === 'passthrough') routingMode = 'passthrough';

  rl.close();

  mkdirSync(join(homedir(), '.relayplane'), { recursive: true });

  if (routingMode === 'auto') {
    if (existsSync(POLICY_FILE)) {
      console.log('  (Existing policy preserved — run `relayplane policy auto` to update it)');
    } else {
      const autoYaml = [
        '# RelayPlane routing policy',
        '# Run `relayplane policy auto` after a day of traffic to auto-configure.',
        '# Auto mode: suggestions will be based on your actual traffic patterns.',
        '',
        'version: 1',
        '',
        '# agents will be added here by `relayplane policy auto`',
        '',
      ].join('\n');
      writeFileSync(POLICY_FILE, autoYaml, 'utf-8');
    }
  } else if (routingMode === 'manual') {
    console.log('  Run `relayplane policy init` to scaffold a policy template.');
  }
  // passthrough: do not write any policy file

  // Step 3 — Done
  console.log('');
  console.log('Step 3/3 — Done');
  console.log('');
  console.log('  RelayPlane is ready.');
  console.log('');
  console.log('  Proxy:        http://localhost:4100');
  console.log('  Configure:    ANTHROPIC_BASE_URL=http://localhost:4100');
  console.log('');
  console.log('  Next: run RelayPlane for a day, then:');
  console.log('    relayplane policy auto    # auto-configure routing');
  console.log('    relayplane policy suggest  # preview recommendations');
  console.log('');
  console.log('  Docs: https://relayplane.com/docs');
  console.log('');
}

main();
