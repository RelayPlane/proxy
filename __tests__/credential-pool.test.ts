/**
 * Tests for the multi-credential pool (rp-credential-pool-v2).
 *
 * All tests import from the not-yet-implemented credential-pool module —
 * they MUST fail until the implementation exists.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type {
  CredentialPool,
  CredentialPoolEntry,
  CredentialPoolConfig,
  CredentialHealth,
} from '../src/credential-pool.js';

// Dynamic import so a missing module gives a clear test failure rather than
// a module-load error that silently skips the suite.
async function importPool(): Promise<{
  createCredentialPool: (config: CredentialPoolConfig) => CredentialPool;
}> {
  return import('../src/credential-pool.js') as Promise<any>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-aaa-111';
const TENANT_B = 'tenant-bbb-222';

const singleCredConfig: CredentialPoolConfig = {
  credentialPool: [
    {
      id: 'cred-1',
      tenantId: TENANT_A,
      source: 'api-key',
      envVar: 'ANTHROPIC_API_KEY',
      weight: 1,
      maxConcurrent: 5,
    },
  ],
};

const twoCredConfig: CredentialPoolConfig = {
  credentialPool: [
    {
      id: 'cred-a1',
      tenantId: TENANT_A,
      source: 'api-key',
      envVar: 'ANTHROPIC_API_KEY',
      weight: 1,
      maxConcurrent: 5,
    },
    {
      id: 'cred-a2',
      tenantId: TENANT_A,
      source: 'api-key',
      envVar: 'ANTHROPIC_API_KEY_2',
      weight: 1,
      maxConcurrent: 5,
    },
  ],
};

const multiTenantConfig: CredentialPoolConfig = {
  credentialPool: [
    {
      id: 'cred-a1',
      tenantId: TENANT_A,
      source: 'api-key',
      envVar: 'ANTHROPIC_API_KEY',
      weight: 1,
      maxConcurrent: 5,
    },
    {
      id: 'cred-b1',
      tenantId: TENANT_B,
      source: 'api-key',
      envVar: 'ANTHROPIC_API_KEY_B',
      weight: 1,
      maxConcurrent: 5,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialPool — backwards compatibility', () => {
  it('single-credential config returns the sole credential for the matching tenant', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    const selected = pool.selectCredential(TENANT_A);

    expect(selected).not.toBeNull();
    expect(selected!.id).toBe('cred-1');
  });

  it('single-credential config returns null for an unknown tenant', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    const selected = pool.selectCredential('tenant-unknown');
    expect(selected).toBeNull();
  });
});

describe('CredentialPool — 401 / 429 fallback chain', () => {
  it('falls back to cred-a2 after cred-a1 receives a 401', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(twoCredConfig);

    // First pick should be cred-a1 (first in list)
    const first = pool.selectCredential(TENANT_A);
    expect(first!.id).toBe('cred-a1');

    // Simulate a 401 on cred-a1
    pool.recordFailure('cred-a1', 401);

    // Next pick for the same tenant must skip cred-a1 (in cooldown)
    const second = pool.selectCredential(TENANT_A);
    expect(second!.id).toBe('cred-a2');
  });

  it('falls back to cred-a2 after cred-a1 receives a 429', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(twoCredConfig);

    pool.recordFailure('cred-a1', 429);

    const selected = pool.selectCredential(TENANT_A);
    expect(selected!.id).toBe('cred-a2');
  });

  it('returns null (all-fail) when every credential in the tenant pool is in cooldown', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(twoCredConfig);

    pool.recordFailure('cred-a1', 401);
    pool.recordFailure('cred-a2', 429);

    const selected = pool.selectCredential(TENANT_A);
    expect(selected).toBeNull();
  });

  it('cooldown expires after 30 seconds and credential becomes available again', async () => {
    vi.useFakeTimers();
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    pool.recordFailure('cred-1', 401);
    expect(pool.selectCredential(TENANT_A)).toBeNull();

    // Advance past the 30s cooldown window
    vi.advanceTimersByTime(31_000);

    expect(pool.selectCredential(TENANT_A)).not.toBeNull();
    vi.useRealTimers();
  });
});

describe('CredentialPool — tenant isolation', () => {
  it('a failure on tenant A\'s credential does not affect tenant B\'s pool', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(multiTenantConfig);

    pool.recordFailure('cred-a1', 401);

    // Tenant A: all-fail (only one cred)
    expect(pool.selectCredential(TENANT_A)).toBeNull();

    // Tenant B: unaffected
    const bSelected = pool.selectCredential(TENANT_B);
    expect(bSelected).not.toBeNull();
    expect(bSelected!.id).toBe('cred-b1');
  });

  it('concurrent requests on tenant B do not share state with tenant A', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(multiTenantConfig);

    const a = pool.selectCredential(TENANT_A);
    const b = pool.selectCredential(TENANT_B);

    expect(a!.id).toBe('cred-a1');
    expect(b!.id).toBe('cred-b1');
    // Credentials must be distinct objects
    expect(a).not.toBe(b);
  });
});

describe('CredentialPool — request-header passthrough mode', () => {
  it('selects a passthrough credential when source is request-header', async () => {
    const { createCredentialPool } = await importPool();
    const passthroughConfig: CredentialPoolConfig = {
      credentialPool: [
        {
          id: 'cred-passthrough',
          tenantId: TENANT_A,
          source: 'request-header',
          weight: 1,
          maxConcurrent: 10,
        },
      ],
    };

    const pool = createCredentialPool(passthroughConfig);
    const selected = pool.selectCredential(TENANT_A);

    expect(selected).not.toBeNull();
    expect(selected!.source).toBe('request-header');
  });

  it('resolveToken returns undefined for request-header source (caller supplies the token)', async () => {
    const { createCredentialPool } = await importPool();
    const passthroughConfig: CredentialPoolConfig = {
      credentialPool: [
        {
          id: 'cred-passthrough',
          tenantId: TENANT_A,
          source: 'request-header',
          weight: 1,
          maxConcurrent: 10,
        },
      ],
    };

    const pool = createCredentialPool(passthroughConfig);
    const selected = pool.selectCredential(TENANT_A)!;

    // For passthrough, no token is stored in the pool — caller injects it.
    const token = pool.resolveToken(selected);
    expect(token).toBeUndefined();
  });
});

describe('CredentialPool — health metrics', () => {
  it('exposes success_count, last_401_at, last_429_at, current_concurrent per credential', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    const health: CredentialHealth[] = pool.getHealth();
    expect(health).toHaveLength(1);

    const entry = health[0]!;
    expect(entry).toHaveProperty('id', 'cred-1');
    expect(entry).toHaveProperty('success_count');
    expect(typeof entry.success_count).toBe('number');
    expect(entry.success_count).toBeGreaterThanOrEqual(0);
    expect(entry).toHaveProperty('last_401_at');
    expect(entry).toHaveProperty('last_429_at');
    expect(entry).toHaveProperty('current_concurrent');
  });

  it('increments success_count when recordSuccess is called', async () => {
    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    pool.recordSuccess('cred-1');
    pool.recordSuccess('cred-1');

    const [entry] = pool.getHealth();
    expect(entry!.success_count).toBe(2);
  });

  it('updates last_401_at when a 401 failure is recorded', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const { createCredentialPool } = await importPool();
    const pool = createCredentialPool(singleCredConfig);

    pool.recordFailure('cred-1', 401);

    const [entry] = pool.getHealth();
    expect(entry!.last_401_at).toBe(now);
    vi.useRealTimers();
  });
});

describe('CredentialPool — auto-migration from legacy single-credential config', () => {
  it('migrateFromLegacy wraps a bare apiKey string into a one-entry pool', async () => {
    const { migrateFromLegacy } = await importPool();

    const pool = migrateFromLegacy({ apiKey: 'sk-ant-legacy', tenantId: TENANT_A });

    expect(pool.credentialPool).toHaveLength(1);
    expect(pool.credentialPool[0]!.source).toBe('api-key');
    expect(pool.credentialPool[0]!.tenantId).toBe(TENANT_A);
  });
});
