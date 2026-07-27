/**
 * Tests for the usage-aware / priority-failover behavior added on top of the
 * base credential pool: priority order (newmax first), headroom-driven failover
 * at >=80%, reserve-Fable for elite requests, never-strand fallback, oauth-file
 * token resolution, and request accounting.
 */
import { describe, it, expect } from 'vitest';
import {
  createCredentialPool,
  readOAuthAccessToken,
  type CredentialPoolConfig,
  type CredentialHeadroom,
} from '../src/credential-pool.js';

const TENANT = 'tenant-max';

// Two accounts on one tenant: newmax (priority 1, first in list), default (priority 2).
const twoAccounts: CredentialPoolConfig = {
  credentialPool: [
    { id: 'newmax', tenantId: TENANT, source: 'oauth-file', path: '/tmp/newmax.json', refresh: true, weight: 1, maxConcurrent: 5 },
    { id: 'default', tenantId: TENANT, source: 'oauth-file', path: '/tmp/default.json', refresh: false, weight: 1, maxConcurrent: 5 },
  ],
};

describe('CredentialPool - priority order', () => {
  it('picks the first-listed account (newmax) when both are healthy', () => {
    const pool = createCredentialPool(twoAccounts);
    expect(pool.selectCredential(TENANT)!.id).toBe('newmax');
  });
});

describe('CredentialPool - headroom-driven failover', () => {
  it('fails over to default when newmax session usage is at/over 80%', () => {
    const headroom: Record<string, CredentialHeadroom> = {
      newmax: { sessionUsed: 0.87, weeklyUsed: 0.4, fableUsed: 0.46 },
      default: { sessionUsed: 0.24, weeklyUsed: 0.3, fableUsed: 0.36 },
    };
    const pool = createCredentialPool(twoAccounts, { getHeadroom: (id) => headroom[id] });
    expect(pool.selectCredential(TENANT)!.id).toBe('default');
  });

  it('fails over when newmax weekly usage is at/over 80% even if session is low', () => {
    const headroom: Record<string, CredentialHeadroom> = {
      newmax: { sessionUsed: 0.1, weeklyUsed: 0.82 },
      default: { sessionUsed: 0.2, weeklyUsed: 0.2 },
    };
    const pool = createCredentialPool(twoAccounts, { getHeadroom: (id) => headroom[id] });
    expect(pool.selectCredential(TENANT)!.id).toBe('default');
  });

  it('stays on newmax when it is under the 80% threshold', () => {
    const headroom: Record<string, CredentialHeadroom> = {
      newmax: { sessionUsed: 0.79, weeklyUsed: 0.5 },
      default: { sessionUsed: 0.1, weeklyUsed: 0.1 },
    };
    const pool = createCredentialPool(twoAccounts, { getHeadroom: (id) => headroom[id] });
    expect(pool.selectCredential(TENANT)!.id).toBe('newmax');
  });
});

describe('CredentialPool - reserve Fable for elite', () => {
  it('an elite request avoids an account whose Fable weekly is >=80%, even if session/weekly are fine', () => {
    const headroom: Record<string, CredentialHeadroom> = {
      newmax: { sessionUsed: 0.3, weeklyUsed: 0.3, fableUsed: 0.85 },
      default: { sessionUsed: 0.3, weeklyUsed: 0.3, fableUsed: 0.2 },
    };
    const pool = createCredentialPool(twoAccounts, { getHeadroom: (id) => headroom[id] });
    // Non-elite request is happy on newmax (Fable headroom irrelevant).
    expect(pool.selectCredential(TENANT)!.id).toBe('newmax');
    // Elite request reserves Fable: skip newmax, use default.
    expect(pool.selectCredential(TENANT, { elite: true })!.id).toBe('default');
  });
});

describe('CredentialPool - never strand a request', () => {
  it('falls back to priority order (ignoring soft capacity) when every account is over 80%', () => {
    const headroom: Record<string, CredentialHeadroom> = {
      newmax: { sessionUsed: 0.9, weeklyUsed: 0.9 },
      default: { sessionUsed: 0.95, weeklyUsed: 0.95 },
    };
    const pool = createCredentialPool(twoAccounts, { getHeadroom: (id) => headroom[id] });
    // Both over cap -> soft-capacity fallback still returns the highest-priority one.
    expect(pool.selectCredential(TENANT)!.id).toBe('newmax');
  });

  it('returns null only when every account is in hard cooldown', () => {
    const pool = createCredentialPool(twoAccounts);
    pool.recordFailure('newmax', 429);
    pool.recordFailure('default', 401);
    expect(pool.selectCredential(TENANT)).toBeNull();
  });
});

describe('CredentialPool - oauth-file token resolution', () => {
  it('resolveToken reads the access token from a Claude-Code creds file (injected reader)', () => {
    const tokens: Record<string, string> = {
      '/tmp/newmax.json': 'sk-ant-oat01-NEWMAX',
      '/tmp/default.json': 'sk-ant-oat01-DEFAULT',
    };
    const pool = createCredentialPool(twoAccounts, {
      readOAuthAccessToken: (p) => tokens[p],
    });
    const cred = pool.selectCredential(TENANT)!;
    expect(pool.resolveToken(cred)).toBe('sk-ant-oat01-NEWMAX');
  });

  it('readOAuthAccessToken parses the claudeAiOauth shape and the flat shape', () => {
    const nested = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-A' } });
    const flat = JSON.stringify({ accessToken: 'sk-ant-oat01-B' });
    // Round-trip through a temp file to exercise the real reader.
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const n = path.join(os.tmpdir(), `rp-oauth-nested-${process.pid}.json`);
    const f = path.join(os.tmpdir(), `rp-oauth-flat-${process.pid}.json`);
    fs.writeFileSync(n, nested);
    fs.writeFileSync(f, flat);
    try {
      expect(readOAuthAccessToken(n)).toBe('sk-ant-oat01-A');
      expect(readOAuthAccessToken(f)).toBe('sk-ant-oat01-B');
      expect(readOAuthAccessToken('/no/such/file.json')).toBeUndefined();
    } finally {
      fs.unlinkSync(n);
      fs.unlinkSync(f);
    }
  });
});

describe('CredentialPool - request accounting', () => {
  it('recordUsage counts total and Fable requests, surfaced in getHealth', () => {
    const pool = createCredentialPool(twoAccounts);
    pool.recordUsage('newmax');
    pool.recordUsage('newmax', { elite: true });
    pool.recordUsage('default');
    const health = Object.fromEntries(pool.getHealth().map((h) => [h.id, h]));
    expect(health.newmax.request_count).toBe(2);
    expect(health.newmax.fable_request_count).toBe(1);
    expect(health.default.request_count).toBe(1);
    expect(health.default.fable_request_count).toBe(0);
  });

  it('getHealth reports in_cooldown true while an account is cooling down', () => {
    const pool = createCredentialPool(twoAccounts);
    pool.recordFailure('newmax', 429);
    const health = Object.fromEntries(pool.getHealth().map((h) => [h.id, h]));
    expect(health.newmax.in_cooldown).toBe(true);
    expect(health.default.in_cooldown).toBe(false);
  });
});
