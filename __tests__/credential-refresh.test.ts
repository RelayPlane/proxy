/**
 * Tests for the OAuth refresh manager that keeps a SECOND (non-Claude-Code)
 * Max account's access token fresh, so failover never hands Anthropic a stale
 * token. Includes the stale-token fixture case Matt flagged as the thing most
 * likely to make failover silently not work.
 */
import { describe, it, expect } from 'vitest';
import {
  refreshOAuthToken,
  needsRefresh,
  ensureFresh,
  readCreds,
  writeCreds,
  startRefreshManager,
  OAUTH_TOKEN_URL,
  CLAUDE_CODE_CLIENT_ID,
  type OAuthCreds,
} from '../src/credential-refresh.js';
import type { CredentialPoolEntry } from '../src/credential-pool.js';

/** A fake fetch that returns a scripted OAuth token response. */
function fakeFetch(response: { ok: boolean; status?: number; body: any }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
  return Object.assign(fn, { calls });
}

/** In-memory file backing for read/write injection. */
function memFile(initial?: string) {
  const store: { data: string | undefined } = { data: initial };
  return {
    read: (_p: string) => {
      if (store.data === undefined) throw new Error('ENOENT');
      return store.data;
    },
    write: (_p: string, d: string) => { store.data = d; },
    get: () => store.data,
  };
}

describe('refreshOAuthToken', () => {
  it('POSTs a refresh_token grant to the OAuth endpoint and returns fresh creds', async () => {
    const fetch = fakeFetch({ ok: true, body: { access_token: 'sk-ant-oat01-FRESH', refresh_token: 'sk-ant-ort01-ROTATED', expires_in: 3600 } });
    const fresh = await refreshOAuthToken('sk-ant-ort01-OLD', { fetch, now: () => 1_000_000 });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(OAUTH_TOKEN_URL);
    const sentBody = JSON.parse(fetch.calls[0].init.body);
    expect(sentBody).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'sk-ant-ort01-OLD',
      client_id: CLAUDE_CODE_CLIENT_ID,
    });
    expect(fresh.accessToken).toBe('sk-ant-oat01-FRESH');
    expect(fresh.refreshToken).toBe('sk-ant-ort01-ROTATED');
    expect(fresh.expiresAt).toBe(1_000_000 + 3600 * 1000);
  });

  it('keeps the old refresh token when the response omits a rotated one', async () => {
    const fetch = fakeFetch({ ok: true, body: { access_token: 'sk-ant-oat01-FRESH', expires_in: 3600 } });
    const fresh = await refreshOAuthToken('sk-ant-ort01-OLD', { fetch, now: () => 0 });
    expect(fresh.refreshToken).toBe('sk-ant-ort01-OLD');
  });

  it('throws on a non-ok response (e.g. invalid_grant)', async () => {
    const fetch = fakeFetch({ ok: false, status: 400, body: { error: 'invalid_grant' } });
    await expect(refreshOAuthToken('sk-ant-ort01-DEAD', { fetch })).rejects.toThrow(/oauth refresh failed: HTTP 400/);
  });

  it('throws when the response has no access_token', async () => {
    const fetch = fakeFetch({ ok: true, body: { expires_in: 3600 } });
    await expect(refreshOAuthToken('x', { fetch })).rejects.toThrow(/missing access_token/);
  });
});

describe('needsRefresh', () => {
  it('is true for missing creds', () => {
    expect(needsRefresh(null, 1000)).toBe(true);
  });
  it('is true when the token expires within the skew window', () => {
    const creds: OAuthCreds = { accessToken: 'a', refreshToken: 'r', expiresAt: 1000 + 10 * 60 * 1000 };
    expect(needsRefresh(creds, 1000)).toBe(true); // 10 min left, skew 30 min
  });
  it('is false when the token has plenty of life left', () => {
    const creds: OAuthCreds = { accessToken: 'a', refreshToken: 'r', expiresAt: 1000 + 2 * 60 * 60 * 1000 };
    expect(needsRefresh(creds, 1000)).toBe(false);
  });
});

describe('readCreds / writeCreds', () => {
  it('round-trips through the claudeAiOauth shape and preserves sibling fields', () => {
    const f = memFile(JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 5, subscriptionType: 'max' } }));
    const creds = readCreds('/x', f.read)!;
    expect(creds).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 5 });

    writeCreds('/x', { accessToken: 'a2', refreshToken: 'r2', expiresAt: 99 }, f.read, f.write);
    const after = JSON.parse(f.get()!);
    expect(after.claudeAiOauth.accessToken).toBe('a2');
    expect(after.claudeAiOauth.refreshToken).toBe('r2');
    expect(after.claudeAiOauth.expiresAt).toBe(99);
    // Sibling field preserved.
    expect(after.claudeAiOauth.subscriptionType).toBe('max');
  });

  it('returns null for a malformed creds file', () => {
    const f = memFile('not json');
    expect(readCreds('/x', f.read)).toBeNull();
  });
});

const managedEntry: CredentialPoolEntry = {
  id: 'default', tenantId: 't', source: 'oauth-file', path: '/creds/default.json', refresh: true, weight: 1, maxConcurrent: 5,
};
const liveEntry: CredentialPoolEntry = {
  id: 'newmax', tenantId: 't', source: 'oauth-file', path: '/creds/newmax.json', refresh: false, weight: 1, maxConcurrent: 5,
};

describe('ensureFresh - the stale second-account token case', () => {
  it('refreshes a managed account whose stored token is STALE (already expired) and persists the rotation', async () => {
    // Fixture: account B's token expired an hour ago -> exactly the failover-killing case.
    const now = 10_000_000;
    const staleFile = memFile(JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-STALE', refreshToken: 'sk-ant-ort01-B', expiresAt: now - 60 * 60 * 1000 },
    }));
    const fetch = fakeFetch({ ok: true, body: { access_token: 'sk-ant-oat01-B-FRESH', refresh_token: 'sk-ant-ort01-B2', expires_in: 3600 } });

    const refreshed = await ensureFresh(managedEntry, {
      now: () => now, fetch, readFile: staleFile.read, writeFile: staleFile.write,
    });

    expect(refreshed).toBe(true);
    // The stale access token was replaced on disk before any failover could use it.
    const persisted = readCreds('/creds/default.json', staleFile.read)!;
    expect(persisted.accessToken).toBe('sk-ant-oat01-B-FRESH');
    expect(persisted.refreshToken).toBe('sk-ant-ort01-B2');
    expect(persisted.expiresAt).toBe(now + 3600 * 1000);
  });

  it('does NOT refresh a fresh managed token (no wasted, rate-limited endpoint hit)', async () => {
    const now = 10_000_000;
    const freshFile = memFile(JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-OK', refreshToken: 'sk-ant-ort01-B', expiresAt: now + 2 * 60 * 60 * 1000 },
    }));
    const fetch = fakeFetch({ ok: true, body: { access_token: 'nope', expires_in: 3600 } });
    const refreshed = await ensureFresh(managedEntry, { now: () => now, fetch, readFile: freshFile.read, writeFile: freshFile.write });
    expect(refreshed).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });

  it('NEVER touches the live (refresh:false) account, even if its token is stale', async () => {
    const now = 10_000_000;
    const liveFile = memFile(JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-LIVE', refreshToken: 'sk-ant-ort01-LIVE', expiresAt: now - 60 * 60 * 1000 },
    }));
    const fetch = fakeFetch({ ok: true, body: { access_token: 'should-not-be-written', expires_in: 3600 } });
    const refreshed = await ensureFresh(liveEntry, { now: () => now, fetch, readFile: liveFile.read, writeFile: liveFile.write });
    expect(refreshed).toBe(false);
    expect(fetch.calls).toHaveLength(0);
    // Untouched.
    expect(readCreds('/creds/newmax.json', liveFile.read)!.accessToken).toBe('sk-ant-oat01-LIVE');
  });
});

describe('startRefreshManager', () => {
  it('runs one pass immediately and only refreshes managed entries', async () => {
    const now = 10_000_000;
    const staleFile = memFile(JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-STALE', refreshToken: 'sk-ant-ort01-B', expiresAt: now - 1000 },
    }));
    const fetch = fakeFetch({ ok: true, body: { access_token: 'sk-ant-oat01-FRESH', expires_in: 3600 } });
    const mgr = startRefreshManager([liveEntry, managedEntry], {
      now: () => now, fetch, readFile: staleFile.read, writeFile: staleFile.write, intervalMs: 60_000,
    });
    // Await the immediate pass.
    await mgr.runOnce();
    mgr.stop();
    expect(readCreds('/creds/default.json', staleFile.read)!.accessToken).toBe('sk-ant-oat01-FRESH');
  });

  it('is a no-op with no managed entries (never schedules a timer)', () => {
    const mgr = startRefreshManager([liveEntry], {});
    // stop() must be safe to call even when nothing was scheduled.
    expect(() => mgr.stop()).not.toThrow();
  });
});
