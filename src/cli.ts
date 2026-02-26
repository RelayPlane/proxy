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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { getResponseCache } from './response-cache.js';
import { getBudgetManager } from './budget.js';
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
 * Check npm registry for newer version (non-blocking, best-effort).
 * Returns update message string or null.
 */
async function checkForUpdate(): Promise<string | null> {
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
    // Simple semver compare: split and compare numerically
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

function printHelp(): void {
  console.log(`
RelayPlane Proxy - Intelligent AI Model Routing

Usage:
  npx @relayplane/proxy [command] [options]
  relayplane-proxy [command] [options]

Commands:
  (default)              Start the proxy server
  init                   Initialize config files
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
      binPath = process.argv[0] ?? 'relayplane';
    }

    // Capture API keys from current environment for systemd
    const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY'];
    const envLines = envKeys
      .filter(k => process.env[k])
      .map(k => `Environment=${k}=${process.env[k]}`)
      .join('\n');

    const serviceContent = `[Unit]
Description=RelayPlane Proxy - Intelligent AI Model Routing
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=root
ExecStart=${binPath}
Restart=always
RestartSec=3
Environment=HOME=/root
${envLines}

[Install]
WantedBy=multi-user.target
`;

    writeFileSync(SERVICE_PATH, serviceContent);
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

      // Read the shipped service template and patch ExecStart
      const assetPath = getServiceAssetPath();
      let serviceContent: string;
      if (existsSync(assetPath)) {
        serviceContent = readFileSync(assetPath, 'utf8');
        serviceContent = serviceContent.replace(/^ExecStart=.*$/m, `ExecStart=${binPath}`);
      } else {
        // Fallback: generate inline
        const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
        const envLines = envKeys
          .filter(k => process.env[k])
          .map(k => `Environment=${k}=${process.env[k]}`)
          .join('\n');
        serviceContent = `[Unit]
Description=RelayPlane Proxy - Intelligent AI Model Routing
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
User=root
ExecStart=${binPath}
Restart=always
RestartSec=5
WatchdogSec=30
StandardOutput=journal
StandardError=journal
Environment=HOME=/root
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
    // Ensure config exists (loadConfig creates default if missing)
    const config = loadConfig();
    const configPath = getConfigPath();
    console.log('');
    console.log('✅ RelayPlane initialized');
    console.log(`   Config: ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Start the proxy:');
    console.log('     relayplane start');
    console.log('');
    console.log('  2. Point your agent at the proxy:');
    console.log('     export ANTHROPIC_BASE_URL=http://localhost:4100');
    console.log('     export OPENAI_BASE_URL=http://localhost:4100');
    console.log('');
    console.log('  3. Check your costs:');
    console.log('     relayplane stats');
    console.log('');
    process.exit(0);
  }

  if (command === 'start') {
    // "relayplane start" just falls through to start the server
    args.shift();
  }

  const knownCommands = new Set([
    'init', 'start', 'telemetry', 'stats', 'config', 'login', 'logout', 'upgrade',
    'status', 'autostart', 'service', 'mesh', 'cache', 'budget', 'alerts', 'enable', 'disable',
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

  // Check for at least one API key
  const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];
  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  const hasGeminiKey = !!process.env['GEMINI_API_KEY'];
  const hasXAIKey = !!process.env['XAI_API_KEY'];
  const hasOpenRouterKey = !!process.env['OPENROUTER_API_KEY'];
  const hasDeepSeekKey = !!process.env['DEEPSEEK_API_KEY'];
  const hasGroqKey = !!process.env['GROQ_API_KEY'];

  if (!hasAnthropicKey && !hasOpenAIKey && !hasGeminiKey && !hasXAIKey && !hasOpenRouterKey && !hasDeepSeekKey && !hasGroqKey) {
    console.error('Error: No API keys found. Set at least one of:');
    console.error('  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, MOONSHOT_API_KEY');
    process.exit(1);
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
  if (hasAnthropicKey) console.log('    ✓ Anthropic');
  if (hasOpenAIKey) console.log('    ✓ OpenAI');
  if (hasGeminiKey) console.log('    ✓ Google Gemini');
  if (hasXAIKey) console.log('    ✓ xAI (Grok)');
  if (hasOpenRouterKey) console.log('    ✓ OpenRouter');
  if (hasDeepSeekKey) console.log('    ✓ DeepSeek');
  if (hasGroqKey) console.log('    ✓ Groq');
  console.log('');

  try {
    await startProxy({ port, host, verbose });
    
    console.log('');
    console.log('  To use, point your agent at the proxy:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${port} your-agent`);
    console.log(`    OPENAI_BASE_URL=http://localhost:${port} your-agent`);
    console.log('');

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

function handleBudgetCommand(args: string[]): void {
  const sub = args[0] ?? 'status';
  const budget = getBudgetManager();

  if (sub === 'status') {
    try { budget.init(); } catch { /* ok */ }
    const status = budget.getStatus();
    const config = budget.getConfig();
    console.log('');
    console.log('💰 Budget Status');
    console.log(`   Enabled:     ${config.enabled ? '✅' : '❌'}`);
    console.log(`   Daily:       $${status.dailySpend.toFixed(4)} / $${status.dailyLimit} (${status.dailyPercent.toFixed(1)}%)`);
    console.log(`   Hourly:      $${status.hourlySpend.toFixed(4)} / $${status.hourlyLimit} (${status.hourlyPercent.toFixed(1)}%)`);
    console.log(`   Per-request: max $${config.perRequestUsd}`);
    console.log(`   On breach:   ${config.onBreach}`);
    if (status.breached) {
      console.log(`   ⚠️  BREACHED: ${status.breachType}`);
    }
    console.log('');
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

  console.log('Usage: relayplane budget [status|set|reset]');
  console.log('  set --daily <usd> --hourly <usd> --per-request <usd>');
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

main();
