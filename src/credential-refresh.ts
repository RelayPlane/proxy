import * as fs from 'fs';
import type { CredentialPoolEntry } from './credential-pool.js';

/**
 * OAuth token refresh for pooled Max accounts.
 *
 * Only accounts marked `refresh: true` are refreshed here - a SECOND account not
 * logged into Claude Code on this box. The live account (~/.claude, refresh
 * false/absent) is owned by Claude Code's own refresh loop and must never be
 * written here, or the two refreshers would rotate the same refresh token and
 * invalidate each other.
 *
 * The token endpoint rate-limits, so refresh is done only when the access token
 * is within REFRESH_SKEW_MS of expiry, checked on a slow interval.
 */

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh when the access token has this long (or less) until expiry. */
const REFRESH_SKEW_MS = 30 * 60 * 1000; // 30 min
/** Default interval between freshness checks. */
const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min

export interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface RefreshDeps {
  fetch?: FetchLike;
  now?: () => number;
  readFile?: (p: string) => string;
  writeFile?: (p: string, data: string) => void;
  log?: (msg: string) => void;
}

/** Read a Claude-Code-style credentials file into OAuthCreds. */
export function readCreds(path: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): OAuthCreds | null {
  try {
    const raw = JSON.parse(readFile(path));
    const o = raw.claudeAiOauth ?? raw;
    if (typeof o?.accessToken !== 'string' || typeof o?.refreshToken !== 'string') return null;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : 0,
    };
  } catch {
    return null;
  }
}

/** Write OAuthCreds back in the Claude-Code claudeAiOauth shape, preserving other fields. */
export function writeCreds(
  path: string,
  creds: OAuthCreds,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p: string, d: string) => void = (p, d) => fs.writeFileSync(p, d),
): void {
  let root: any = {};
  try { root = JSON.parse(readFile(path)); } catch { /* new file */ }
  const existing = root.claudeAiOauth ?? {};
  root.claudeAiOauth = {
    ...existing,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };
  writeFile(path, JSON.stringify(root, null, 2));
}

/** Exchange a refresh token for a fresh access token (and rotated refresh token). */
export async function refreshOAuthToken(refreshToken: string, deps: RefreshDeps = {}): Promise<OAuthCreds> {
  const doFetch = (deps.fetch ?? (globalThis.fetch as unknown as FetchLike));
  const now = deps.now ?? Date.now;
  const res = await doFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`oauth refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const accessToken = data.access_token;
  const newRefresh = data.refresh_token ?? refreshToken;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  if (typeof accessToken !== 'string') {
    throw new Error('oauth refresh: response missing access_token');
  }
  return { accessToken, refreshToken: newRefresh, expiresAt: now() + expiresIn * 1000 };
}

/** True when a managed account's stored token is missing or within skew of expiry. */
export function needsRefresh(creds: OAuthCreds | null, now: number, skewMs = REFRESH_SKEW_MS): boolean {
  if (!creds) return true;
  return creds.expiresAt - now <= skewMs;
}

/**
 * Refresh one managed entry if its token is near expiry; persist the rotation.
 * Returns true if a refresh was performed. Never touches non-managed entries.
 */
export async function ensureFresh(entry: CredentialPoolEntry, deps: RefreshDeps = {}): Promise<boolean> {
  if (entry.source !== 'oauth-file' || !entry.path || entry.refresh !== true) return false;
  const now = (deps.now ?? Date.now)();
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p, d) => fs.writeFileSync(p, d));
  const creds = readCreds(entry.path, readFile);
  if (!needsRefresh(creds, now)) return false;
  if (!creds?.refreshToken) {
    deps.log?.(`[cred-refresh] ${entry.id}: no refresh token, cannot refresh`);
    return false;
  }
  try {
    const fresh = await refreshOAuthToken(creds.refreshToken, deps);
    writeCreds(entry.path, fresh, readFile, writeFile);
    deps.log?.(`[cred-refresh] ${entry.id}: refreshed, expires in ${Math.round((fresh.expiresAt - now) / 60000)}m`);
    return true;
  } catch (e) {
    deps.log?.(`[cred-refresh] ${entry.id}: refresh error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Start a slow loop that keeps every managed (refresh:true) account's token
 * fresh. Returns a stop() function. Runs one pass immediately.
 */
export function startRefreshManager(
  entries: CredentialPoolEntry[],
  deps: RefreshDeps & { intervalMs?: number } = {},
): { stop: () => void; runOnce: () => Promise<void> } {
  const managed = entries.filter((e) => e.source === 'oauth-file' && e.refresh === true && e.path);
  const interval = deps.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  const runOnce = async () => {
    for (const e of managed) {
      await ensureFresh(e, deps);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (managed.length > 0) {
    void runOnce();
    timer = setInterval(() => { void runOnce(); }, interval);
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
  }

  return {
    stop: () => { if (timer) clearInterval(timer); },
    runOnce,
  };
}
