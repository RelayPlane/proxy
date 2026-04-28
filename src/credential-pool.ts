export type CredentialSource = 'oauth-file' | 'api-key' | 'request-header';

export interface CredentialPoolEntry {
  id: string;
  tenantId: string;
  source: CredentialSource;
  path?: string;
  envVar?: string;
  weight: number;
  maxConcurrent: number;
}

export interface CredentialPoolConfig {
  credentialPool: CredentialPoolEntry[];
}

export interface CredentialHealth {
  id: string;
  success_count: number;
  last_401_at: number | null;
  last_429_at: number | null;
  current_concurrent: number;
}

interface CredentialState {
  entry: CredentialPoolEntry;
  success_count: number;
  last_401_at: number | null;
  last_429_at: number | null;
  current_concurrent: number;
}

const COOLDOWN_MS = 30_000;

export interface CredentialPool {
  selectCredential(tenantId: string): CredentialPoolEntry | null;
  recordFailure(credId: string, statusCode: 401 | 429): void;
  recordSuccess(credId: string): void;
  resolveToken(cred: CredentialPoolEntry): string | undefined;
  getHealth(): CredentialHealth[];
}

export function createCredentialPool(config: CredentialPoolConfig): CredentialPool {
  const states = new Map<string, CredentialState>();

  for (const entry of config.credentialPool) {
    states.set(entry.id, {
      entry,
      success_count: 0,
      last_401_at: null,
      last_429_at: null,
      current_concurrent: 0,
    });
  }

  function isInCooldown(state: CredentialState): boolean {
    const now = Date.now();
    if (state.last_401_at !== null && now - state.last_401_at < COOLDOWN_MS) return true;
    if (state.last_429_at !== null && now - state.last_429_at < COOLDOWN_MS) return true;
    return false;
  }

  return {
    selectCredential(tenantId: string): CredentialPoolEntry | null {
      for (const state of states.values()) {
        if (state.entry.tenantId === tenantId && !isInCooldown(state)) {
          return state.entry;
        }
      }
      return null;
    },

    recordFailure(credId: string, statusCode: 401 | 429): void {
      const state = states.get(credId);
      if (!state) return;
      const now = Date.now();
      if (statusCode === 401) {
        state.last_401_at = now;
      } else {
        state.last_429_at = now;
      }
    },

    recordSuccess(credId: string): void {
      const state = states.get(credId);
      if (!state) return;
      state.success_count++;
    },

    resolveToken(cred: CredentialPoolEntry): string | undefined {
      if (cred.source === 'request-header') return undefined;
      if (cred.source === 'api-key' && cred.envVar) {
        return process.env[cred.envVar];
      }
      return undefined;
    },

    getHealth(): CredentialHealth[] {
      return Array.from(states.values()).map((s) => ({
        id: s.entry.id,
        success_count: s.success_count,
        last_401_at: s.last_401_at,
        last_429_at: s.last_429_at,
        current_concurrent: s.current_concurrent,
      }));
    },
  };
}

export function migrateFromLegacy(legacy: {
  apiKey: string;
  tenantId: string;
}): CredentialPoolConfig {
  return {
    credentialPool: [
      {
        id: 'legacy-migrated',
        tenantId: legacy.tenantId,
        source: 'api-key',
        weight: 1,
        maxConcurrent: 5,
      },
    ],
  };
}
