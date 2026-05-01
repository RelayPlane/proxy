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

export interface RateLimitModelConfig {
  /** Requests per minute for this model */
  rpm: number;
}

export interface ProviderRateLimitConfig {
  /**
   * Requests per minute for ALL models from this provider.
   * Applies when no model-specific override exists.
   * Example: providers.anthropic.rateLimit.rpm = 100
   */
  rpm: number;
}

/**
 * A single named account (API key or OAT token) for a provider.
 * Used to build the multi-account token pool.
 *
 * Example ~/.relayplane/config.json:
 * ```json
 * {
 *   "providers": {
 *     "anthropic": {
 *       "accounts": [
 *         { "label": "newmax", "apiKey": "sk-ant-oat01-...", "priority": 0 },
 *         { "label": "default", "apiKey": "sk-ant-oat01-...", "priority": 1 }
 *       ]
 *     }
 *   }
 * }
 * ```
 */
export interface ProviderAccountConfig {
  /** Human-readable label shown in the dashboard */
  label: string;
  /** API key or OAT token */
  apiKey: string;
  /**
   * Selection priority — lower number = tried first.
   * Default: 0.
   */
  priority?: number;
}

export interface ProviderConfig {
  /** Provider-level rate limit. Applies to all models for this provider unless overridden per-model. */
  rateLimit?: ProviderRateLimitConfig;
  /**
   * Multi-account token pool.  When present, the proxy will pool these
   * tokens and select the best available one per request.  Tokens with
   * lower priority numbers are preferred.  Rate-limited tokens are skipped.
   *
   * Backward compatible: if absent, the proxy falls back to the single-token
   * flow (ANTHROPIC_API_KEY env var or incoming Authorization header).
   */
  accounts?: ProviderAccountConfig[];
}

/**
 * Cross-provider cascade configuration (GH #38).
 *
 * Example ~/.relayplane/config.json:
 * ```json
 * {
 *   "crossProviderCascade": {
 *     "enabled": true,
 *     "providers": ["anthropic", "openrouter", "google"],
 *     "triggerStatuses": [429, 529, 503]
 *   }
 * }
 * ```
 */
export interface CrossProviderCascadeConfigSection {
  /** Enable cross-provider fallback (default: false). */
  enabled?: boolean;
  /**
   * Ordered list of provider names to attempt.
   * First entry is the primary; the rest are fallbacks in order.
   */
  providers?: string[];
  /**
   * HTTP status codes that trigger a cascade. Defaults to [429, 529, 503].
   */
  triggerStatuses?: number[];
  /**
   * Custom model name overrides: { fromProvider: { toProvider: { model: mappedModel } } }
   */
  modelMapping?: Record<string, Record<string, Record<string, string>>>;
}

export interface RateLimitConfigSection {
  /** Per-model RPM overrides. Keys are model names (e.g. "claude-sonnet-4-6"). */
  models?: Record<string, RateLimitModelConfig>;
  /** Max requests to queue when limit is hit (default: 50) */
  maxQueueDepth?: number;
  /** Max ms a queued request waits before getting a 429 (default: 30000) */
  queueTimeoutMs?: number;
}

export interface ProxyConfig {
  /** Anonymous device ID (generated on first run) */
  device_id: string;
  
  /** Full per-request telemetry (model, tokens, cost). Off by default. */
  telemetry_enabled: boolean;

  /**
   * Lifecycle telemetry — anonymous install/session/dashboard_linked pings.
   * No request content, no model names, no tokens. On by default per the
   * 2026-04-04 privacy spec. Opt out with `relayplane lifecycle off`.
   */
  lifecycle_enabled?: boolean;

  /** True if the user explicitly ran `relayplane lifecycle on/off` */
  lifecycle_explicitly_set?: boolean;

  /** Exclude this device from telemetry (for devbox) */
  telemetry_exclude?: boolean;

  /** ISO timestamp of the last daily startup ping */
  last_ping_date?: string;

  /** ISO timestamp of the last hourly dashboard ping */
  last_dashboard_ping?: string;


  /** Whether first run disclosure has been shown */
  first_run_complete: boolean;
  
  /** RelayPlane API key (for Pro features) */
  api_key?: string;
  
  /** Schema version for migrations */
  config_version: number;

  /** True if the user explicitly ran `relayplane telemetry on/off` — migrations must not override this */
  telemetry_explicitly_set?: boolean;

  /** True if the v1→v2 telemetry-off migration was applied to this config */
  telemetry_migration_applied?: boolean;

  /** Timestamp of config creation */
  created_at: string;
  
  /** Timestamp of last update */
  updated_at: string;

  /** Mesh (Osmosis) learning layer config */
  mesh?: MeshConfigSection;

  /** Rate limiter configuration */
  rateLimit?: RateLimitConfigSection;

  /**
   * Per-provider configuration.
   * Supported providers: anthropic, openai, google, xai, groq, perplexity.
   *
   * Example ~/.relayplane/config.json:
   * ```json
   * {
   *   "providers": {
   *     "anthropic": { "rateLimit": { "rpm": 100 } },
   *     "openai":    { "rateLimit": { "rpm": 60  } }
   *   }
   * }
   * ```
   */
  providers?: Record<string, ProviderConfig>;

  /**
   * Cross-provider cascade fallback (GH #38).
   * When enabled and a provider returns 429/529/503, the proxy will automatically
   * retry with the next provider in the `providers` cascade list.
   */
  crossProviderCascade?: CrossProviderCascadeConfigSection;

  /**
   * Deterministic trace files (CAP 3).
   * Writes per-request JSONL trace files to ~/.relayplane/traces/ and maintains
   * a SQLite index for querying. Enabled by default; privacy-safe (hashes only).
   */
  traces?: TracesConfig;
}

export interface TracesConfig {
  /** Enable trace file writing (default: true) */
  enabled: boolean;
  /**
   * Store full request/response bodies for replay (default: false — hashes only).
   * Set true only for debugging; bodies may contain sensitive data.
   */
  storeFullRequests: boolean;
  /** Delete trace files older than this many days (default: 30) */
  retentionDays: number;
  /** Directory for trace files (default: ~/.relayplane/traces/) */
  directory: string;
  /** Prune oldest files when total traces dir exceeds this size in MB (default: 500) */
  maxDiskMb: number;
}

const CONFIG_VERSION = 4;

/**
 * Resolve the base RelayPlane config directory.
 * Supports RELAYPLANE_HOME_OVERRIDE env var for dev/test isolation
 * (e.g. RELAYPLANE_HOME_OVERRIDE=/root → uses /root/.relayplane/).
 * Also supports RELAYPLANE_CONFIG_PATH for a fully custom config file path.
 */
function resolveConfigDir(): string {
  const homeOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  const base = homeOverride ?? os.homedir();
  return path.join(base, '.relayplane');
}

function resolveConfigFilePath(): string {
  const customPath = process.env['RELAYPLANE_CONFIG_PATH'];
  if (customPath && customPath.trim()) return customPath;
  return path.join(resolveConfigDir(), 'config.json');
}

const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = resolveConfigFilePath();
const CONFIG_BACKUP = CONFIG_FILE + '.bak';
const CONFIG_TMP = CONFIG_FILE + '.tmp';
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
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
    telemetry_enabled: false, // Off by default. Enable with `relayplane telemetry on`
    lifecycle_enabled: true, // Anonymous install/session pings. Opt-out via `relayplane lifecycle off`
    first_run_complete: false,
    config_version: CONFIG_VERSION,
    created_at: now,
    updated_at: now,
    mesh: {
      enabled: false, // Off by default. Enable: `relayplane mesh on`
      endpoint: 'https://osmosis-mesh-dev.fly.dev',
      sync_interval_ms: 60000,
      contribute: false,
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

      // v1 → v2 migration: flip telemetry off for users who never explicitly opted in.
      // Skipped when telemetry_explicitly_set is true (user ran `relayplane telemetry on/off`).
      if (config.config_version === 1 && config.telemetry_enabled === true && !config.telemetry_explicitly_set) {
        config.telemetry_enabled = false;
        config.config_version = 2;
        config.telemetry_migration_applied = true;
        saveConfig(config);
        console.log('[RelayPlane] Telemetry has been turned off by default as of v1.9.2. Run `relayplane telemetry on` to re-enable.');
        return config;
      }

      // Bump config_version for any remaining v1 config (telemetry already false or explicitly set)
      if (config.config_version === 1) {
        config.config_version = 2;
        saveConfig(config);
      }

      // v2 → v3 migration: disable mesh for existing configs that have it enabled.
      // Mesh defaulted to enabled in early v1.9 builds; it was never intentionally opted in by most users.
      // Run `relayplane mesh on` to re-enable after upgrading.
      if (config.config_version === 2 && config.mesh?.enabled === true) {
        config.mesh = { ...config.mesh, enabled: false };
        config.config_version = 3;
        saveConfig(config);
        console.log('[RelayPlane] Mesh sync has been disabled by default as of v1.9.5. Run `relayplane mesh on` to re-enable.');
      }

      // Bump config_version for any remaining v2 config (mesh already off or not set)
      if (config.config_version === 2) {
        config.config_version = 3;
        saveConfig(config);
      }

      // v3 → v4 migration: introduce lifecycle_enabled (default on). Only set
      // the field if it's missing — respects explicit user choice if they
      // already ran `relayplane lifecycle off`.
      if (config.config_version === 3) {
        if (config.lifecycle_enabled === undefined) {
          config.lifecycle_enabled = true;
        }
        config.config_version = 4;
        saveConfig(config);
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
  
  // Task 3: Keep telemetry off for authenticated users
  if (hasValidCredentials()) {
    config.telemetry_enabled = false;
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
  
  // Atomic write: write to tmp with restricted permissions, then rename
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_TMP, data, { mode: 0o600 });
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
  updateConfig({ telemetry_enabled: true, telemetry_explicitly_set: true });
}

/**
 * Disable telemetry
 */
export function disableTelemetry(): void {
  updateConfig({ telemetry_enabled: false, telemetry_explicitly_set: true });
}

/**
 * Check if lifecycle telemetry is enabled. Defaults to true when the field is
 * missing (new install, or pre-v4 config that hasn't been migrated yet).
 */
export function isLifecycleEnabled(): boolean {
  const config = loadConfig();
  return config.lifecycle_enabled !== false;
}

export function enableLifecycle(): void {
  updateConfig({ lifecycle_enabled: true, lifecycle_explicitly_set: true });
}

export function disableLifecycle(): void {
  updateConfig({ lifecycle_enabled: false, lifecycle_explicitly_set: true });
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
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
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
    contribute: false,
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

/**
 * Get rate limit config section (with defaults)
 */
export function getRateLimitConfig(): RateLimitConfigSection {
  const config = loadConfig();
  return config.rateLimit ?? {};
}

/**
 * Get per-provider configurations (with defaults).
 * Returns empty object if no providers section exists in config.
 */
export function getProviderConfigs(): Record<string, ProviderConfig> {
  const config = loadConfig();
  return config.providers ?? {};
}

/**
 * Get cross-provider cascade configuration (GH #38).
 * Returns the section as-is; callers are responsible for applying defaults.
 */
export function getCrossProviderCascadeConfig(): CrossProviderCascadeConfigSection {
  const config = loadConfig();
  return config.crossProviderCascade ?? {};
}
