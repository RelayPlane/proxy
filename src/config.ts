/**
 * RelayPlane Proxy Configuration
 * 
 * Handles configuration persistence, telemetry settings, and device identity.
 * 
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * Configuration schema for RelayPlane proxy
 */
export interface ProxyConfig {
  /** Anonymous device ID (generated on first run) */
  device_id: string;
  
  /** Telemetry enabled state */
  telemetry_enabled: boolean;
  
  /** Whether first run disclosure has been shown */
  first_run_complete: boolean;
  
  /** RelayPlane API key (for Pro features) */
  api_key?: string;
  
  /** Schema version for migrations */
  config_version: number;
  
  /** Timestamp of config creation */
  created_at: string;
  
  /** Timestamp of last update */
  updated_at: string;
}

const CONFIG_VERSION = 1;
const CONFIG_DIR = path.join(os.homedir(), '.relayplane');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Generate an anonymous device ID
 * Uses a random hash that cannot be traced back to the device
 */
function generateDeviceId(): string {
  const randomBytes = crypto.randomBytes(16);
  const hash = crypto.createHash('sha256').update(randomBytes).digest('hex');
  return `anon_${hash.slice(0, 16)}`;
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Create default configuration
 */
function createDefaultConfig(): ProxyConfig {
  const now = new Date().toISOString();
  return {
    device_id: generateDeviceId(),
    telemetry_enabled: false, // Off by default, opt-in with `relayplane telemetry on`
    first_run_complete: false,
    config_version: CONFIG_VERSION,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Load configuration from disk
 * Creates default config if none exists
 */
export function loadConfig(): ProxyConfig {
  ensureConfigDir();
  
  if (!fs.existsSync(CONFIG_FILE)) {
    const config = createDefaultConfig();
    saveConfig(config);
    return config;
  }
  
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data) as ProxyConfig;
    
    // Ensure required fields exist (for migrations)
    if (!config.device_id) {
      config.device_id = generateDeviceId();
    }
    if (config.telemetry_enabled === undefined) {
      config.telemetry_enabled = false;
    }
    if (!config.config_version) {
      config.config_version = CONFIG_VERSION;
    }
    
    return config;
  } catch (err) {
    // If config is corrupted, create new one
    const config = createDefaultConfig();
    saveConfig(config);
    return config;
  }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config: ProxyConfig): void {
  ensureConfigDir();
  config.updated_at = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Update specific config fields
 */
export function updateConfig(updates: Partial<ProxyConfig>): ProxyConfig {
  const config = loadConfig();
  Object.assign(config, updates);
  saveConfig(config);
  return config;
}

/**
 * Check if this is the first run (disclosure not shown yet)
 */
export function isFirstRun(): boolean {
  const config = loadConfig();
  return !config.first_run_complete;
}

/**
 * Mark first run as complete
 */
export function markFirstRunComplete(): void {
  updateConfig({ first_run_complete: true });
}

/**
 * Check if telemetry is enabled
 */
export function isTelemetryEnabled(): boolean {
  const config = loadConfig();
  return config.telemetry_enabled;
}

/**
 * Enable telemetry
 */
export function enableTelemetry(): void {
  updateConfig({ telemetry_enabled: true });
}

/**
 * Disable telemetry
 */
export function disableTelemetry(): void {
  updateConfig({ telemetry_enabled: false });
}

/**
 * Get device ID for telemetry
 */
export function getDeviceId(): string {
  const config = loadConfig();
  return config.device_id;
}

/**
 * Set API key for Pro features
 */
export function setApiKey(key: string): void {
  updateConfig({ api_key: key });
  
  // Also update credentials.json so the proxy uses the same key everywhere
  const credPath = path.join(CONFIG_DIR, 'credentials.json');
  try {
    let creds: Record<string, any> = {};
    if (fs.existsSync(credPath)) {
      creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    }
    creds.apiKey = key;
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));
  } catch {}
}

/**
 * Get API key
 */
export function getApiKey(): string | undefined {
  const config = loadConfig();
  return config.api_key;
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
