import { describe, it, expect } from 'vitest';
import { cooldownKey, CooldownManager } from '../src/standalone-proxy';
import { RateLimiter } from '../src/rate-limiter';

describe('cooldownKey: per-account isolation', () => {
  it('returns the bare provider name when there is no auth header', () => {
    expect(cooldownKey('anthropic')).toBe('anthropic');
    expect(cooldownKey('anthropic', undefined)).toBe('anthropic');
  });

  it('returns the bare provider name when the auth header has no token', () => {
    expect(cooldownKey('anthropic', 'Bearer ')).toBe('anthropic');
  });

  it('returns a distinct key per token, same provider', () => {
    const keyA = cooldownKey('anthropic', 'Bearer sk-ant-oat01-account-a-token');
    const keyB = cooldownKey('anthropic', 'Bearer sk-ant-oat01-account-b-token');
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith('anthropic:')).toBe(true);
    expect(keyB.startsWith('anthropic:')).toBe(true);
  });

  it('is stable: the same token always produces the same key', () => {
    const header = 'Bearer sk-ant-oat01-same-token-twice';
    expect(cooldownKey('anthropic', header)).toBe(cooldownKey('anthropic', header));
  });
});

describe('CooldownManager: a cooled-down account does not block a different account', () => {
  it('reproduces the 2026-07-05 bug and confirms the fix', () => {
    const mgr = new CooldownManager({
      enabled: true,
      allowedFails: 3,
      windowSeconds: 60,
      cooldownSeconds: 120,
    });

    const accountA = cooldownKey('anthropic', 'Bearer sk-ant-oat01-near-capped-account');
    const accountB = cooldownKey('anthropic', 'Bearer sk-ant-oat01-fresh-account');

    // Account A fails 3 times in a row (its real 7-day-cap rejections).
    mgr.recordFailure(accountA, 'rate_limit_error');
    mgr.recordFailure(accountA, 'rate_limit_error');
    mgr.recordFailure(accountA, 'rate_limit_error');

    expect(mgr.isAvailable(accountA)).toBe(false); // correctly cooled down
    expect(mgr.isAvailable(accountB)).toBe(true);  // NOT blocked by A's failures

    // Before the fix, both call sites used the bare provider string
    // ("anthropic"), so accountB's key would collapse to the same value as
    // accountA and this second assertion would fail.
  });

  it('old provider-only keying would have caused the exact blackout this fixes', () => {
    const mgr = new CooldownManager({
      enabled: true,
      allowedFails: 3,
      windowSeconds: 60,
      cooldownSeconds: 120,
    });

    const bareProviderKey = 'anthropic'; // pre-fix behavior, ignoring the account entirely
    mgr.recordFailure(bareProviderKey, 'rate_limit_error');
    mgr.recordFailure(bareProviderKey, 'rate_limit_error');
    mgr.recordFailure(bareProviderKey, 'rate_limit_error');

    // With the old keying, every account's requests share this one key, so a
    // completely different (fresh) account also reads as unavailable.
    expect(mgr.isAvailable(bareProviderKey)).toBe(false);
  });
});

describe('RateLimiter: heavy usage on one account does not exhaust another account\'s bucket', () => {
  it('reproduces the second 2026-07-05 bug and confirms the fix', () => {
    const limiter = new RateLimiter();

    const workspaceA = cooldownKey('local', 'Bearer sk-ant-oat01-heavily-used-account');
    const workspaceB = cooldownKey('local', 'Bearer sk-ant-oat01-fresh-account');

    // Exhaust account A's haiku bucket (rpm: 60, per DEFAULT_LIMITS).
    for (let i = 0; i < 60; i++) {
      const check = limiter.checkLimit(workspaceA, 'claude-haiku-4-5', 'anthropic');
      expect(check.allowed).toBe(true);
    }
    const exhausted = limiter.checkLimit(workspaceA, 'claude-haiku-4-5', 'anthropic');
    expect(exhausted.allowed).toBe(false); // account A is correctly rate-limited now

    // Account B's bucket is untouched.
    const stillAvailable = limiter.checkLimit(workspaceB, 'claude-haiku-4-5', 'anthropic');
    expect(stillAvailable.allowed).toBe(true);

    // Before the fix, both call sites passed the bare 'local' workspaceId, so
    // account B would collapse onto account A's exhausted bucket and this
    // assertion would fail.
  });

  it('old workspaceId="local" keying would have caused the exact exhaustion this fixes', () => {
    const limiter = new RateLimiter();
    const bareWorkspaceId = 'local'; // pre-fix behavior, ignoring the account entirely

    for (let i = 0; i < 60; i++) {
      limiter.checkLimit(bareWorkspaceId, 'claude-haiku-4-5', 'anthropic');
    }
    // With the old keying, every account's requests share this one bucket, so
    // a completely different (fresh) account also reads as exhausted.
    const check = limiter.checkLimit(bareWorkspaceId, 'claude-haiku-4-5', 'anthropic');
    expect(check.allowed).toBe(false);
  });
});
