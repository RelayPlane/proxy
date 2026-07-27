import * as fs from 'fs';

export type CredentialSource = 'oauth-file' | 'api-key' | 'request-header';

export interface CredentialPoolEntry {
  id: string;
  tenantId: string;
  source: CredentialSource;
  /** For oauth-file: path to a Claude-Code-style credentials JSON. */
  path?: string;
  envVar?: string;
  weight: number;
  maxConcurrent: number;
  /**
   * oauth-file only. When true, this account's token is refreshed by the pool's
   * refresh manager (a SECOND account, not logged into Claude Code here). When
   * false/absent, the file is treated as live and read-only (Claude Code owns
   * its refresh loop) - never write it, to avoid two refreshers racing the same
   * account's rotating refresh token.
   */
  refresh?: boolean;
}

export interface CredentialPoolConfig {
  credentialPool: CredentialPoolEntry[];
}

/** Per-account headroom as used-fractions (0..1). Undefined field = unknown. */
export interface CredentialHeadroom {
  sessionUsed?: number;
  weeklyUsed?: number;
  fableUsed?: number;
}

export interface CredentialHealth {
  id: string;
  success_count: number;
  request_count: number;
  fable_request_count: number;
  last_401_at: number | null;
  last_429_at: number | null;
  current_concurrent: number;
  in_cooldown: boolean;
}

interface CredentialState {
  entry: CredentialPoolEntry;
  success_count: number;
  request_count: number;
  fable_request_count: number;
  last_401_at: number | null;
  last_429_at: number | null;
  current_concurrent: number;
}

const COOLDOWN_MS = 30_000;
/** Prefer failing over once an account crosses this fraction of a limit. */
const HEADROOM_LIMIT = 0.8;

export interface SelectOptions {
  /** true when the request is elite-tier (Fable) - reserve Fable headroom. */
  elite?: boolean;
}

export interface CredentialPool {
  selectCredential(tenantId: string, opts?: SelectOptions): CredentialPoolEntry | null;
  recordFailure(credId: string, statusCode: 401 | 429): void;
  recordSuccess(credId: string): void;
  recordUsage(credId: string, opts?: { elite?: boolean }): void;
  resolveToken(cred: CredentialPoolEntry): string | undefined;
  getHealth(): CredentialHealth[];
  entries(): CredentialPoolEntry[];
}

export interface CredentialPoolOptions {
  /**
   * Returns real-usage headroom for an account (e.g. from ~/.claude/usage-data
   * for the live account). Undefined for accounts with no ground-truth data;
   * selection then falls back to cooldown + priority order.
   */
  getHeadroom?: (credId: string) => CredentialHeadroom | undefined;
  /** Read the oauth access token for a file path (injectable for tests). */
  readOAuthAccessToken?: (path: string) => string | undefined;
}

/** Read a Claude-Code-style credentials file and return the access token. */
export function readOAuthAccessToken(path: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    const oauth = raw.claudeAiOauth ?? raw;
    const token = oauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function createCredentialPool(
  config: CredentialPoolConfig,
  options: CredentialPoolOptions = {},
): CredentialPool {
  const states = new Map<string, CredentialState>();
  const order: string[] = [];
  const readToken = options.readOAuthAccessToken ?? readOAuthAccessToken;

  for (const entry of config.credentialPool) {
    states.set(entry.id, {
      entry,
      success_count: 0,
      request_count: 0,
      fable_request_count: 0,
      last_401_at: null,
      last_429_at: null,
      current_concurrent: 0,
    });
    order.push(entry.id);
  }

  function isInCooldown(state: CredentialState): boolean {
    const now = Date.now();
    if (state.last_401_at !== null && now - state.last_401_at < COOLDOWN_MS) return true;
    if (state.last_429_at !== null && now - state.last_429_at < COOLDOWN_MS) return true;
    return false;
  }

  /** true when the account is at/over the headroom limit for the given request. */
  function overCapacity(credId: string, elite: boolean): boolean {
    const h = options.getHeadroom?.(credId);
    if (!h) return false;
    if ((h.sessionUsed ?? 0) >= HEADROOM_LIMIT) return true;
    if ((h.weeklyUsed ?? 0) >= HEADROOM_LIMIT) return true;
    // Reserve Fable: an elite request avoids an account low on Fable weekly.
    if (elite && (h.fableUsed ?? 0) >= HEADROOM_LIMIT) return true;
    return false;
  }

  function pick(tenantId: string, elite: boolean, respectCapacity: boolean): CredentialPoolEntry | null {
    for (const id of order) {
      const state = states.get(id)!;
      if (state.entry.tenantId !== tenantId) continue;
      if (isInCooldown(state)) continue;
      if (respectCapacity && overCapacity(id, elite)) continue;
      return state.entry;
    }
    return null;
  }

  return {
    selectCredential(tenantId: string, opts: SelectOptions = {}): CredentialPoolEntry | null {
      const elite = opts.elite === true;
      // First choice: priority order, skipping cooldown AND near-cap accounts.
      const withCapacity = pick(tenantId, elite, true);
      if (withCapacity) return withCapacity;
      // Everyone near-cap or unknown: fall back to priority order ignoring the
      // soft capacity limit (still skip hard cooldowns) so a request is never
      // stranded with no account.
      return pick(tenantId, elite, false);
    },

    recordFailure(credId: string, statusCode: 401 | 429): void {
      const state = states.get(credId);
      if (!state) return;
      const now = Date.now();
      if (statusCode === 401) state.last_401_at = now;
      else state.last_429_at = now;
    },

    recordSuccess(credId: string): void {
      const state = states.get(credId);
      if (state) state.success_count++;
    },

    recordUsage(credId: string, opts: { elite?: boolean } = {}): void {
      const state = states.get(credId);
      if (!state) return;
      state.request_count++;
      if (opts.elite) state.fable_request_count++;
    },

    resolveToken(cred: CredentialPoolEntry): string | undefined {
      if (cred.source === 'request-header') return undefined;
      if (cred.source === 'api-key' && cred.envVar) return process.env[cred.envVar];
      if (cred.source === 'oauth-file' && cred.path) return readToken(cred.path);
      return undefined;
    },

    getHealth(): CredentialHealth[] {
      return order.map((id) => {
        const s = states.get(id)!;
        return {
          id: s.entry.id,
          success_count: s.success_count,
          request_count: s.request_count,
          fable_request_count: s.fable_request_count,
          last_401_at: s.last_401_at,
          last_429_at: s.last_429_at,
          current_concurrent: s.current_concurrent,
          in_cooldown: isInCooldown(s),
        };
      });
    },

    entries(): CredentialPoolEntry[] {
      return order.map((id) => states.get(id)!.entry);
    },
  };
}

export function migrateFromLegacy(legacy: { apiKey: string; tenantId: string }): CredentialPoolConfig {
  return {
    credentialPool: [
      { id: 'legacy-migrated', tenantId: legacy.tenantId, source: 'api-key', weight: 1, maxConcurrent: 5 },
    ],
  };
}
