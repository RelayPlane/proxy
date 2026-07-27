/**
 * 4101 end-to-end fixture test for the credential pool.
 *
 * Simulates the dual-account 4101 setup with REAL on-disk creds files:
 *   - account A (newmax, priority 1): fresh live token
 *   - account B (default, priority 2): a DELIBERATELY STALE (expired) token
 *
 * This is the failover-killing case Matt flagged: without the refresh loop,
 * a 401/429 on A fails over to B and hands Anthropic B's dead token. The test
 * proves the refresh manager rotates B's token fresh BEFORE any failover uses
 * it, and that selection + failover resolve the fresh token off disk.
 *
 * Fully offline: temp fixture files + a mocked OAuth endpoint. No network, no
 * real tokens. When Matt confirms account B, only live dual-account
 * verification and the deliberate config flip remain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCredentialPool, readOAuthAccessToken, type CredentialPoolEntry } from '../src/credential-pool.js';
import { ensureFresh } from '../src/credential-refresh.js';

const TENANT = 'local';
let dir: string;
let pathA: string;
let pathB: string;

function writeCredsFile(p: string, accessToken: string, refreshToken: string, expiresAt: number) {
  fs.writeFileSync(p, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType: 'max' },
  }, null, 2));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cred-e2e-'));
  pathA = path.join(dir, 'accountA.json');
  pathB = path.join(dir, 'accountB.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function entries(): CredentialPoolEntry[] {
  return [
    // A = live account owned by Claude Code (refresh:false, never written by us).
    { id: 'newmax', tenantId: TENANT, source: 'oauth-file', path: pathA, refresh: false, weight: 1, maxConcurrent: 5 },
    // B = second Max account we manage (refresh:true).
    { id: 'default', tenantId: TENANT, source: 'oauth-file', path: pathB, refresh: true, weight: 1, maxConcurrent: 5 },
  ];
}

/** Scripted OAuth token endpoint that always returns a fresh token for B. */
function fakeOAuth() {
  const calls: string[] = [];
  const fetch = async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body).refresh_token);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'sk-ant-oat01-B-REFRESHED', refresh_token: 'sk-ant-ort01-B-NEXT', expires_in: 3600 }),
      text: async () => '',
    };
  };
  return Object.assign(fetch, { calls });
}

describe('credential pool 4101 e2e - stale second-account token', () => {
  it('refresh loop rotates B fresh, then a 401 on A fails over to B with the FRESH token', async () => {
    const now = 20_000_000;
    // A: fresh. B: expired an hour ago (the stale fixture).
    writeCredsFile(pathA, 'sk-ant-oat01-A-LIVE', 'sk-ant-ort01-A', now + 60 * 60 * 1000);
    writeCredsFile(pathB, 'sk-ant-oat01-B-STALE', 'sk-ant-ort01-B', now - 60 * 60 * 1000);

    const pool = createCredentialPool({ credentialPool: entries() });
    const oauth = fakeOAuth();
    const [entryA, entryB] = entries();

    // 1) Refresh loop pass: B is expired -> refreshed on disk. A (refresh:false)
    //    is a no-op (Claude Code owns it), even though it is not near expiry.
    expect(await ensureFresh(entryB!, { now: () => now, fetch: oauth })).toBe(true);
    expect(await ensureFresh(entryA!, { now: () => now, fetch: oauth })).toBe(false);
    expect(oauth.calls).toEqual(['sk-ant-ort01-B']);           // only B refreshed, using its refresh token
    expect(readOAuthAccessToken(pathB)).toBe('sk-ant-oat01-B-REFRESHED');
    // A was never touched (Claude Code owns it).
    expect(readOAuthAccessToken(pathA)).toBe('sk-ant-oat01-A-LIVE');

    // 2) Normal selection picks A (priority 1) and resolves its live token.
    const first = pool.selectCredential(TENANT)!;
    expect(first.id).toBe('newmax');
    expect(pool.resolveToken(first)).toBe('sk-ant-oat01-A-LIVE');

    // 3) A returns 401 -> cool it, fail over to B and resolve B's FRESH token
    //    (not the stale one that would have failed silently).
    pool.recordFailure('newmax', 401);
    const second = pool.selectCredential(TENANT)!;
    expect(second.id).toBe('default');
    expect(pool.resolveToken(second)).toBe('sk-ant-oat01-B-REFRESHED');
  });

  it('without the refresh loop, failover to B would hand over the STALE token (control)', () => {
    const now = 20_000_000;
    writeCredsFile(pathA, 'sk-ant-oat01-A-LIVE', 'sk-ant-ort01-A', now + 60 * 60 * 1000);
    writeCredsFile(pathB, 'sk-ant-oat01-B-STALE', 'sk-ant-ort01-B', now - 60 * 60 * 1000);

    const pool = createCredentialPool({ credentialPool: entries() });
    pool.recordFailure('newmax', 429);
    const second = pool.selectCredential(TENANT)!;
    // Demonstrates the failure the refresh loop prevents: B's on-disk token is stale.
    expect(second.id).toBe('default');
    expect(pool.resolveToken(second)).toBe('sk-ant-oat01-B-STALE');
  });

  it('reserve-Fable: an elite request skips A when A is low on Fable weekly, using headroom fixture', () => {
    writeCredsFile(pathA, 'sk-ant-oat01-A-LIVE', 'sk-ant-ort01-A', Number.MAX_SAFE_INTEGER);
    writeCredsFile(pathB, 'sk-ant-oat01-B-LIVE', 'sk-ant-ort01-B', Number.MAX_SAFE_INTEGER);
    const headroom: Record<string, { sessionUsed: number; weeklyUsed: number; fableUsed: number }> = {
      newmax: { sessionUsed: 0.2, weeklyUsed: 0.2, fableUsed: 0.9 },
      default: { sessionUsed: 0.2, weeklyUsed: 0.2, fableUsed: 0.1 },
    };
    const pool = createCredentialPool({ credentialPool: entries() }, { getHeadroom: (id) => headroom[id] });
    // Non-elite still uses A.
    expect(pool.selectCredential(TENANT)!.id).toBe('newmax');
    // Elite reserves A's Fable -> B.
    expect(pool.selectCredential(TENANT, { elite: true })!.id).toBe('default');
    expect(pool.resolveToken(pool.selectCredential(TENANT, { elite: true })!)).toBe('sk-ant-oat01-B-LIVE');
  });
});
