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
import { fileURLToPath } from 'url';
import { homedir } from 'os';

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

    const { deviceCode, userCode, verificationUrl, pollIntervalSec, expiresIn } = await startRes.json() as any;

    console.log(`  Open this URL in your browser:`);
    console.log('');
    console.log(`    ${verificationUrl}`);
    console.log('');
    console.log(`  And enter this code:`);
    console.log('');
    console.log(`    📋 ${userCode}`);
    console.log('');
    console.log(`  Waiting for approval (expires in ${Math.floor(expiresIn / 60)} minutes)...`);

    // Try to open browser automatically
    try {
      const { exec: execCmd } = await import('child_process');
      const openCmd = process.platform === 'darwin' ? 'open' 
        : process.platform === 'win32' ? 'start' 
        : 'xdg-open';
      execCmd(`${openCmd} "${verificationUrl}"`);
    } catch {}

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
        console.log('  ☁️  Cloud sync will activate on next proxy start.');
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
  login                  Log in to RelayPlane (opens browser)
  logout                 Clear stored credentials
  status                 Show proxy status, plan, and cloud sync
  upgrade                Open pricing page in browser
  enable                 Enable RelayPlane proxy routing
  disable                Disable RelayPlane proxy routing (passthrough mode)
  telemetry [on|off|status]  Manage telemetry settings
  stats                  Show usage statistics
  config                 Show configuration
  mesh [status|sync|tips|contribute]  Mesh learning layer management

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
  # ANTHROPIC_BASE_URL=http://localhost:4801 your-agent
  # OPENAI_BASE_URL=http://localhost:4801/v1 your-agent

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

async function handleMeshCommand(args: string[]): Promise<void> {
  const { resolveMeshConfig } = await import('./relay-config.js');
  const config = resolveMeshConfig();

  const sub = args[0] ?? 'status';

  if (sub === 'status') {
    // Try hitting the running proxy's mesh status endpoint
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:4100/v1/mesh/status', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as { mesh: { available: boolean; enabled: boolean; atomCount: number; contributing: boolean; meshUrl: string; dataDir: string } };
        const m = data.mesh;
        console.log('');
        console.log('🧠 Mesh Learning Layer');
        console.log('══════════════════════');
        console.log(`  Available:     ${m.available ? '✅' : '❌'}`);
        console.log(`  Enabled:       ${m.enabled ? '✅' : '❌'}`);
        console.log(`  Atoms:         ${m.atomCount}`);
        console.log(`  Contributing:  ${m.contributing ? '✅ Yes (sharing with mesh)' : '❌ No (local only)'}`);
        console.log(`  Mesh URL:      ${m.meshUrl}`);
        console.log(`  Data dir:      ${m.dataDir}`);
        console.log('');
        return;
      }
    } catch {
      // Proxy not running, show config
    }

    console.log('');
    console.log('🧠 Mesh Learning Layer (proxy not running)');
    console.log('══════════════════════════════════════════');
    console.log(`  Enabled:      ${config.enabled ? '✅' : '❌'}`);
    console.log(`  Contribute:   ${config.contribute ? '✅' : '❌'}`);
    console.log(`  Mesh URL:     ${config.meshUrl}`);
    console.log(`  Data dir:     ${config.dataDir}`);
    console.log(`  Sync interval: ${config.syncIntervalMs / 1000}s`);
    console.log(`  Inject interval: ${config.injectIntervalMs / 1000}s`);
    console.log('');
    console.log('  Start the proxy to see live status.');
    console.log('');
    return;
  }

  if (sub === 'sync') {
    try {
      const res = await fetch('http://127.0.0.1:4100/v1/mesh/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { sync: { pushed?: number; pulled?: number; error?: string } };
        if (data.sync.error) {
          console.log(`⚠️  ${data.sync.error}`);
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

  if (sub === 'tips') {
    try {
      const res = await fetch('http://127.0.0.1:4100/v1/mesh/tips');
      if (res.ok) {
        const data = await res.json() as { tips: Array<{ observation: string; fitness: number; type: string }> };
        if (data.tips.length === 0) {
          console.log('No tips yet. Use the proxy to build knowledge.');
          return;
        }
        console.log('');
        console.log('🧠 Current Tips');
        console.log('═══════════════');
        for (const tip of data.tips) {
          const icon = tip.type === 'tool' ? '🔧' : tip.type === 'negative' ? '🚫' : '💡';
          console.log(`  ${icon} [${tip.fitness.toFixed(2)}] ${tip.observation}`);
        }
        console.log('');
      } else {
        console.log('❌ Cannot fetch tips — is the proxy running?');
      }
    } catch {
      console.log('❌ Cannot connect to proxy. Start it first.');
    }
    return;
  }

  if (sub === 'contribute') {
    const value = args[1]?.toLowerCase();
    const configPath = join(homedir(), '.relayplane', 'config.json');
    const configDir = join(homedir(), '.relayplane');
    
    // Load or create config
    let config: Record<string, any> = {};
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf8'));
      }
    } catch { /* fresh config */ }

    if (!value || value === 'status') {
      const enabled = config.mesh?.contribute === true;
      console.log(`\n  Mesh contribution: ${enabled ? '✅ Enabled' : '❌ Disabled'}`);
      console.log('');
      if (enabled) {
        console.log('  You are sharing anonymized routing data with the collective mesh.');
        console.log('  This improves routing for everyone on the network.');
        console.log('  To disable: relayplane mesh contribute off');
      } else {
        console.log('  You are NOT sharing data with the mesh.');
        console.log('  Your routing is local-only.');
        console.log('  To enable:  relayplane mesh contribute on');
      }
      console.log('');
      console.log('  What gets shared (anonymized):');
      console.log('    • Task type (code_review, file_read, etc.)');
      console.log('    • Model used and whether it succeeded');
      console.log('    • Token count and latency');
      console.log('    • Cost estimate');
      console.log('');
      console.log('  Never shared: prompts, responses, file paths, API keys');
      console.log('');
      return;
    }

    if (value === 'on') {
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      config.mesh = { ...(config.mesh || {}), contribute: true };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('\n  ✅ Mesh contribution enabled');
      console.log('  Anonymized routing data will be shared with the collective mesh.');
      console.log('  Restart the proxy for changes to take effect.\n');
      return;
    }

    if (value === 'off') {
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      config.mesh = { ...(config.mesh || {}), contribute: false };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('\n  ❌ Mesh contribution disabled');
      console.log('  Your data stays local. Restart the proxy for changes to take effect.\n');
      return;
    }

    console.log('Usage: relayplane mesh contribute [on|off|status]');
    return;
  }

  console.log('Unknown mesh subcommand. Available: status, sync, tips, contribute');
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

  if (command === 'mesh') {
    await handleMeshCommand(args.slice(1));
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

  // Parse server options (env vars provide defaults, CLI flags override)
  let port = parseInt(process.env.RELAYPLANE_PROXY_PORT ?? '4100', 10);
  let host = process.env.RELAYPLANE_PROXY_HOST ?? '127.0.0.1';
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

main();
