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
export interface MeshConfigSection {
  enabled: boolean;
  endpoint: string;
  sync_interval_ms: number;
  contribute: boolean;
}

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

  /** Mesh (Osmosis) learning layer config */
  mesh?: MeshConfigSection;
}

const CONFIG_VERSION = 1;
const CONFIG_DIR = path.join(os.homedir(), '.relayplane');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CONFIG_BACKUP = path.join(CONFIG_DIR, 'config.json.bak');
const CONFIG_TMP = path.join(CONFIG_DIR, 'config.json.tmp');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

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
 * NOTE: This never touches credentials.json — credentials are managed separately.
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
    mesh: {
      enabled: false, // Enabled by default for authenticated users (see loadConfig)
      endpoint: 'https://osmosis-mesh-dev.fly.dev',
      sync_interval_ms: 60000,
      contribute: true,
    },
  };
}

/**
 * Check if credentials.json exists and has a valid apiKey
 */
export function hasValidCredentials(): boolean {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
      return !!(creds.apiKey && typeof creds.apiKey === 'string' && creds.apiKey.length > 0);
    }
  } catch {}
  return false;
}

/**
 * Load configuration from disk
 * Falls back to backup if primary config is missing/corrupt,
 * then creates defaults as last resort.
 */
export function loadConfig(): ProxyConfig {
  ensureConfigDir();
  
  // Try primary config
  if (fs.existsSync(CONFIG_FILE)) {
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
      // Config is corrupted, try backup
      console.warn('[RelayPlane] config.json is corrupt, trying backup...');
    }
  }
  
  // Try backup config
  if (fs.existsSync(CONFIG_BACKUP)) {
    try {
      const data = fs.readFileSync(CONFIG_BACKUP, 'utf-8');
      const config = JSON.parse(data) as ProxyConfig;
      console.warn('[RelayPlane] WARNING: config.json missing or corrupt — restored from config.json.bak');
      
      // Check for credential separation: credentials exist but config was missing
      if (hasValidCredentials()) {
        console.warn('[RelayPlane] Config reset detected — credentials preserved');
      }
      
      // Restore the backup as primary
      saveConfig(config);
      return config;
    } catch (err) {
      console.warn('[RelayPlane] WARNING: config.json.bak is also corrupt — creating fresh config');
    }
  }
  
  // Check for credential separation when creating fresh config
  if (hasValidCredentials()) {
    console.warn('[RelayPlane] Config reset detected — credentials preserved');
  }
  
  // Last resort: create default config
  const config = createDefaultConfig();
  
  // Task 3: Auto-enable telemetry for authenticated users
  if (hasValidCredentials()) {
    config.telemetry_enabled = true;
    console.log('[RelayPlane] Telemetry enabled (authenticated user)');
    // Auto-enable mesh for authenticated users
    if (config.mesh) {
      config.mesh.enabled = true;
    }
  }
  
  saveConfig(config);
  return config;
}

/**
 * Save configuration to disk using atomic write (write to .tmp then rename).
 * Before overwriting, backs up the current config to config.json.bak.
 */
export function saveConfig(config: ProxyConfig): void {
  ensureConfigDir();
  config.updated_at = new Date().toISOString();
  
  // Backup current config before overwriting
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
    } catch {
      // Best effort backup
    }
  }
  
  // Atomic write: write to tmp, then rename
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_TMP, data);
  fs.renameSync(CONFIG_TMP, CONFIG_FILE);
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

/**
 * Get credentials file path
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * Get mesh config section (with defaults)
 */
export function getMeshConfig(): MeshConfigSection {
  const config = loadConfig();
  return config.mesh ?? {
    enabled: false,
    endpoint: 'https://osmosis-mesh-dev.fly.dev',
    sync_interval_ms: 60000,
    contribute: true,
  };
}

/**
 * Update mesh config section
 */
export function updateMeshConfig(updates: Partial<MeshConfigSection>): void {
  const config = loadConfig();
  config.mesh = { ...getMeshConfig(), ...updates };
  saveConfig(config);
}
