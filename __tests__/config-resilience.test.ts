/**
 * Tests for config resilience (v1.6 P0)
 * - Backup/restore
 * - Credential separation
 * - Telemetry auto-enable
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to mock the config dir to avoid touching real config
const TEST_CONFIG_DIR = path.join(os.tmpdir(), `relayplane-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Mock os.homedir to redirect config dir
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => path.dirname(TEST_CONFIG_DIR), // so CONFIG_DIR = homedir()/.relayplane
  };
});

// We need the dir name to be .relayplane
const MOCK_HOME = path.dirname(TEST_CONFIG_DIR);

describe('Config Resilience', () => {
  const configDir = path.join(MOCK_HOME, '.relayplane');
  const configFile = path.join(configDir, 'config.json');
  const backupFile = path.join(configDir, 'config.json.bak');
  const tmpFile = path.join(configDir, 'config.json.tmp');
  const credFile = path.join(configDir, 'credentials.json');

  beforeEach(() => {
    // Clean slate
    fs.mkdirSync(configDir, { recursive: true });
    // Remove any existing files
    for (const f of [configFile, backupFile, tmpFile, credFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
    // Reset module cache so loadConfig starts fresh
    vi.resetModules();
  });

  afterEach(() => {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  async function getConfig() {
    // Dynamic import to get fresh module after resetModules
    const mod = await import('../src/config.js');
    return mod;
  }

  it('should create config on first load', async () => {
    const { loadConfig } = await getConfig();
    const config = loadConfig();
    expect(config.device_id).toMatch(/^anon_/);
    expect(config.telemetry_enabled).toBe(false);
    expect(config.config_version).toBe(1);
    expect(fs.existsSync(configFile)).toBe(true);
  });

  it('should restore from backup when config.json is missing', async () => {
    const { loadConfig, saveConfig } = await getConfig();
    
    // Create initial config
    const config = loadConfig();
    const originalDeviceId = config.device_id;
    
    // Save again to ensure backup exists (first save has no existing file to back up)
    saveConfig(config);
    expect(fs.existsSync(backupFile)).toBe(true);
    
    // Now delete the primary
    fs.unlinkSync(configFile);
    expect(fs.existsSync(configFile)).toBe(false);
    
    // Reload — should restore from backup
    vi.resetModules();
    const { loadConfig: loadConfig2 } = await getConfig();
    const restored = loadConfig2();
    expect(restored.device_id).toBe(originalDeviceId);
  });

  it('should restore from backup when config.json is corrupt', async () => {
    const { loadConfig, saveConfig } = await getConfig();
    const config = loadConfig();
    const originalDeviceId = config.device_id;
    
    // Save again to ensure backup exists
    saveConfig(config);
    
    // Corrupt the primary
    fs.writeFileSync(configFile, '{invalid json!!!');
    
    vi.resetModules();
    const { loadConfig: loadConfig2 } = await getConfig();
    const restored = loadConfig2();
    expect(restored.device_id).toBe(originalDeviceId);
  });

  it('should create fresh config when both config.json and .bak are missing', async () => {
    // Ensure neither file exists
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(backupFile)).toBe(false);
    
    const { loadConfig } = await getConfig();
    const config = loadConfig();
    expect(config.device_id).toMatch(/^anon_/);
    expect(config.config_version).toBe(1);
  });

  it('should auto-enable telemetry when credentials.json exists with valid apiKey', async () => {
    // Create credentials.json before loading config
    fs.writeFileSync(credFile, JSON.stringify({ apiKey: 'sk-test-key-123' }));
    
    const { loadConfig } = await getConfig();
    const config = loadConfig();
    expect(config.telemetry_enabled).toBe(true);
  });

  it('should NOT auto-enable telemetry for anonymous users', async () => {
    // No credentials.json
    const { loadConfig } = await getConfig();
    const config = loadConfig();
    expect(config.telemetry_enabled).toBe(false);
  });

  it('should use atomic writes (write to .tmp then rename)', async () => {
    const { loadConfig, saveConfig } = await getConfig();
    const config = loadConfig();
    
    // After save, tmp should not exist (renamed to config.json)
    config.telemetry_enabled = true;
    saveConfig(config);
    
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(configFile)).toBe(true);
    
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(saved.telemetry_enabled).toBe(true);
  });

  it('should create backup before overwriting config', async () => {
    const { loadConfig, saveConfig } = await getConfig();
    const config = loadConfig();
    const firstDeviceId = config.device_id;
    
    // Save again — should create backup of original
    config.telemetry_enabled = true;
    saveConfig(config);
    
    expect(fs.existsSync(backupFile)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
    expect(backup.device_id).toBe(firstDeviceId);
  });

  it('should not touch credentials.json when creating default config', async () => {
    // Create credentials before config
    const creds = { apiKey: 'sk-preserve-me' };
    fs.writeFileSync(credFile, JSON.stringify(creds));
    
    const { loadConfig } = await getConfig();
    loadConfig(); // creates default config
    
    // Verify credentials are untouched
    const savedCreds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
    expect(savedCreds.apiKey).toBe('sk-preserve-me');
  });

  it('hasValidCredentials should return true when credentials.json has apiKey', async () => {
    fs.writeFileSync(credFile, JSON.stringify({ apiKey: 'sk-test' }));
    const { hasValidCredentials } = await getConfig();
    expect(hasValidCredentials()).toBe(true);
  });

  it('hasValidCredentials should return false when credentials.json is missing', async () => {
    const { hasValidCredentials } = await getConfig();
    expect(hasValidCredentials()).toBe(false);
  });

  it('hasValidCredentials should return false when apiKey is empty', async () => {
    fs.writeFileSync(credFile, JSON.stringify({ apiKey: '' }));
    const { hasValidCredentials } = await getConfig();
    expect(hasValidCredentials()).toBe(false);
  });
});
