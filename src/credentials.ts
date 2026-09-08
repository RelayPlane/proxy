/**
 * RelayPlane Agent Credentials
 *
 * Read/write ~/.relayplane/credentials.json for agent-native auth.
 * Shared by CLI and proxy for authenticated cloud/mesh API calls.
 *
 * credentials.json schema:
 *   { api_key, account_id, tier, ...legacy login fields }
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Credentials stored for agent accounts (signup via relayplane signup).
 * Also contains legacy fields from device OAuth login (relayplane login).
 */
export interface AgentCredentials {
  /** API key returned from POST /v1/auth/signup */
  api_key?: string;
  /** Account UUID returned from POST /v1/auth/signup */
  account_id?: string;
  /** Account tier: "free" or "pro" */
  tier?: string;

  // Legacy device OAuth login fields (relayplane login command)
  /** API key from device OAuth login (camelCase for legacy compat) */
  apiKey?: string;
  /** Plan from device OAuth login */
  plan?: string;
  /** Email from device OAuth login */
  email?: string;
  /** Team ID from device OAuth login */
  teamId?: string;
  /** Team name from device OAuth login */
  teamName?: string;
  /** ISO timestamp of last login */
  loggedInAt?: string;
}

/**
 * Resolve the credentials file path.
 * Respects RELAYPLANE_HOME_OVERRIDE for dev/test isolation.
 */
export function getCredentialsFilePath(): string {
  const homeOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  const base = homeOverride ?? os.homedir();
  return path.join(base, '.relayplane', 'credentials.json');
}

/**
 * Load credentials from disk.
 * Returns empty object if file is missing or unreadable.
 */
export function loadAgentCredentials(): AgentCredentials {
  const credPath = getCredentialsFilePath();
  try {
    if (fs.existsSync(credPath)) {
      const raw = fs.readFileSync(credPath, 'utf-8');
      return JSON.parse(raw) as AgentCredentials;
    }
  } catch {
    // Missing or corrupt — return empty
  }
  return {};
}

/**
 * Save (merge) credentials to disk.
 * Merges with any existing credentials so legacy login fields are preserved.
 */
export function saveAgentCredentials(creds: Partial<AgentCredentials>): void {
  const credPath = getCredentialsFilePath();
  const dir = path.dirname(credPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const existing = loadAgentCredentials();
  const merged: AgentCredentials = { ...existing, ...creds };
  fs.writeFileSync(credPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Get the effective API key for authenticated API calls.
 * Prefers agent signup key (api_key) over legacy login key (apiKey).
 */
export function getAgentApiKey(): string | undefined {
  const creds = loadAgentCredentials();
  return creds.api_key ?? creds.apiKey;
}

/**
 * Get the current account tier.
 * Falls back to plan for legacy login sessions.
 */
export function getAccountTier(): string {
  const creds = loadAgentCredentials();
  return creds.tier ?? creds.plan ?? 'free';
}
