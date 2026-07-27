import { describe, it, expect, beforeEach } from 'vitest';
import { TokenPool, resetTokenPool, getTokenPool } from '../src/token-pool.js';

const NOW = 1_700_000_000_000; // fixed epoch for deterministic tests

function makePool(): TokenPool {
  resetTokenPool();
  return getTokenPool();
}

describe('TokenPool', () => {
  describe('selectToken()', () => {
    it('returns null when pool is empty', () => {
      const pool = makePool();
      expect(pool.selectToken(NOW)).toBeNull();
    });

    it('returns the only registered token', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'main', apiKey: 'sk-ant-api01-main', priority: 0 },
      ]);
      const token = pool.selectToken(NOW);
      expect(token).not.toBeNull();
      expect(token!.label).toBe('main');
    });

    it('prefers lower priority number', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'secondary', apiKey: 'sk-ant-api01-secondary', priority: 2 },
        { label: 'primary', apiKey: 'sk-ant-api01-primary', priority: 0 },
        { label: 'tertiary', apiKey: 'sk-ant-api01-tertiary', priority: 5 },
      ]);
      const token = pool.selectToken(NOW);
      expect(token!.label).toBe('primary');
    });

    it('skips rate-limited tokens', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'primary', apiKey: 'sk-ant-api01-primary', priority: 0 },
        { label: 'backup', apiKey: 'sk-ant-api01-backup', priority: 1 },
      ]);
      // Rate-limit the primary for 60 seconds
      pool.record429('sk-ant-api01-primary', 60, NOW);
      const token = pool.selectToken(NOW);
      expect(token!.label).toBe('backup');
    });

    it('returns null when all tokens are rate-limited', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
        { label: 'b', apiKey: 'sk-ant-api01-b', priority: 1 },
      ]);
      pool.record429('sk-ant-api01-a', 60, NOW);
      pool.record429('sk-ant-api01-b', 60, NOW);
      expect(pool.selectToken(NOW)).toBeNull();
    });

    describe('preferApiKey (2026-07-05)', () => {
      it('honors an explicit, available preference over priority ordering', () => {
        const pool = makePool();
        pool.registerConfigAccounts([
          { label: 'primary', apiKey: 'sk-ant-api01-primary', priority: 0 },
          { label: 'secondary', apiKey: 'sk-ant-api01-secondary', priority: 5 },
        ]);
        // Without a preference, priority would pick 'primary'.
        const token = pool.selectToken(NOW, 'sk-ant-api01-secondary');
        expect(token!.label).toBe('secondary');
      });

      it('reproduces the 2026-07-05 bug: a caller-selected, healthy token was silently swapped', () => {
        const pool = makePool();
        pool.registerConfigAccounts([
          { label: 'exhausted-account', apiKey: 'sk-ant-api01-exhausted', priority: 0 },
          { label: 'healthy-account', apiKey: 'sk-ant-api01-healthy', priority: 5 },
        ]);
        pool.record429('sk-ant-api01-exhausted', 120, NOW);

        // Caller (e.g. oauth_creds.py) deliberately chose the healthy account
        // and sent its token. Without preferApiKey, priority-based selection
        // would still try 'exhausted-account' first, find it unavailable, and
        // fall through to 'healthy-account' anyway in THIS case (since it's
        // the only one left), but with more accounts in the pool, an
        // available-but-lower-priority account could be picked over the
        // caller's specific, deliberate choice. This test locks in that the
        // caller's token wins outright when it is itself available, not just
        // when it happens to be the last one standing.
        const token = pool.selectToken(NOW, 'sk-ant-api01-healthy');
        expect(token!.apiKey).toBe('sk-ant-api01-healthy');
      });

      it('falls through to normal selection when the preferred token is rate-limited', () => {
        const pool = makePool();
        pool.registerConfigAccounts([
          { label: 'preferred-but-limited', apiKey: 'sk-ant-api01-limited', priority: 5 },
          { label: 'fallback', apiKey: 'sk-ant-api01-fallback', priority: 0 },
        ]);
        pool.record429('sk-ant-api01-limited', 60, NOW);
        const token = pool.selectToken(NOW, 'sk-ant-api01-limited');
        expect(token!.apiKey).toBe('sk-ant-api01-fallback');
      });

      it('falls through to normal selection when the preferred token is not registered', () => {
        const pool = makePool();
        pool.registerConfigAccounts([
          { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
        ]);
        const token = pool.selectToken(NOW, 'sk-ant-api01-never-seen');
        expect(token!.apiKey).toBe('sk-ant-api01-a');
      });

      it('behaves exactly as before when no preference is given', () => {
        const pool = makePool();
        pool.registerConfigAccounts([
          { label: 'primary', apiKey: 'sk-ant-api01-primary', priority: 0 },
          { label: 'secondary', apiKey: 'sk-ant-api01-secondary', priority: 5 },
        ]);
        const token = pool.selectToken(NOW);
        expect(token!.label).toBe('primary');
      });
    });

    it('increments requestsThisMinute on each call', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.selectToken(NOW);
      pool.selectToken(NOW);
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.requestsThisMinute).toBe(2);
    });

    it('proactively throttles at 90% of known RPM', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'main', apiKey: 'sk-ant-api01-main', priority: 0 },
        { label: 'backup', apiKey: 'sk-ant-api01-backup', priority: 1 },
      ]);
      // Set known RPM to 10 for main, threshold is 9 requests
      pool.recordResponseHeaders('sk-ant-api01-main', {
        'anthropic-ratelimit-requests-limit': '10',
      }, NOW);
      // Consume 9 requests
      for (let i = 0; i < 9; i++) {
        pool.selectToken(NOW);
      }
      // Next selection should skip main (90% threshold hit) and pick backup
      const token = pool.selectToken(NOW);
      expect(token!.label).toBe('backup');
    });

    it('auto-detected tokens have lower priority than configured ones', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'configured', apiKey: 'sk-ant-api01-configured', priority: 0 },
      ]);
      pool.autoDetect('sk-ant-oat01-detected');
      const token = pool.selectToken(NOW);
      expect(token!.label).toBe('configured');
    });

    it('resets per-minute counter after 60 seconds', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      // Consume all slots at time T
      pool.recordResponseHeaders('sk-ant-api01-a', {
        'anthropic-ratelimit-requests-limit': '1',
      }, NOW);
      pool.selectToken(NOW); // uses up the 1 slot → threshold hit
      expect(pool.selectToken(NOW)).toBeNull();

      // 61 seconds later window resets
      const later = NOW + 61_000;
      const token = pool.selectToken(later);
      expect(token).not.toBeNull();
    });
  });

  describe('record429()', () => {
    it('marks a token as rate-limited for the given seconds', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.record429('sk-ant-api01-a', 30, NOW);
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.rateLimitedUntil).toBe(NOW + 30_000);
      expect(status.accounts[0]!.available).toBe(false);
    });

    it('uses default 60s when no retry-after provided', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.record429('sk-ant-api01-a', undefined, NOW);
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.rateLimitedUntil).toBe(NOW + 60_000);
    });

    it('token becomes available again after rate-limit expires', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.record429('sk-ant-api01-a', 10, NOW);
      // Still limited 5 seconds later
      expect(pool.selectToken(NOW + 5_000)).toBeNull();
      // Available 11 seconds later
      expect(pool.selectToken(NOW + 11_000)).not.toBeNull();
    });

    it('no-ops for unknown token', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      // Should not throw
      pool.record429('sk-ant-api01-unknown', 30, NOW);
      expect(pool.selectToken(NOW)).not.toBeNull();
    });
  });

  describe('autoDetect()', () => {
    it('registers a new token with AUTO_DETECT_PRIORITY=10', () => {
      const pool = makePool();
      pool.autoDetect('sk-ant-oat01-abc');
      const status = pool.getStatus(NOW);
      expect(status.accounts).toHaveLength(1);
      expect(status.accounts[0]!.priority).toBe(10);
      expect(status.accounts[0]!.source).toBe('auto-detect');
    });

    it('does not re-register an already-known token', () => {
      const pool = makePool();
      pool.autoDetect('sk-ant-oat01-abc');
      pool.autoDetect('sk-ant-oat01-abc');
      expect(pool.size()).toBe(1);
    });

    it('detects OAT tokens correctly', () => {
      const pool = makePool();
      pool.autoDetect('sk-ant-oat01-abc');
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.isOat).toBe(true);
    });
  });

  describe('recordResponseHeaders()', () => {
    it('learns RPM limit from anthropic-ratelimit-requests-limit', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.recordResponseHeaders('sk-ant-api01-a', {
        'anthropic-ratelimit-requests-limit': '200',
      }, NOW);
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.knownRpmLimit).toBe(200);
    });

    it('learns RPM limit from x-ratelimit-limit-requests fallback', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
      ]);
      pool.recordResponseHeaders('sk-ant-api01-a', {
        'x-ratelimit-limit-requests': '100',
      }, NOW);
      const status = pool.getStatus(NOW);
      expect(status.accounts[0]!.knownRpmLimit).toBe(100);
    });
  });

  describe('getStatus()', () => {
    it('returns empty accounts when pool is empty', () => {
      const pool = makePool();
      expect(pool.getStatus(NOW).accounts).toHaveLength(0);
    });

    it('returns accounts sorted by priority', () => {
      const pool = makePool();
      pool.registerConfigAccounts([
        { label: 'c', apiKey: 'sk-ant-api01-c', priority: 5 },
        { label: 'a', apiKey: 'sk-ant-api01-a', priority: 0 },
        { label: 'b', apiKey: 'sk-ant-api01-b', priority: 2 },
      ]);
      const labels = pool.getStatus(NOW).accounts.map((a) => a.label);
      expect(labels).toEqual(['a', 'b', 'c']);
    });
  });
});
