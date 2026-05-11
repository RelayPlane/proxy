import { describe, it, expect } from 'vitest';
import { TokenPool } from '../src/token-pool.js';

const NOW = 1_700_000_000_000;

function makePool(): TokenPool {
  const pool = new TokenPool();
  pool.registerConfigAccounts([
    { label: 'primary', apiKey: 'sk-ant-api01-primary', priority: 0 },
    { label: 'backup', apiKey: 'sk-ant-api01-backup', priority: 1 },
  ]);
  return pool;
}

describe('TokenPool — 401 quarantine', () => {
  it('quarantines a credential after 2 consecutive 401s', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    // After 2 failures the primary should be quarantined
    const token = pool.selectToken(NOW);
    expect(token?.label).toBe('backup');
  });

  it('does not quarantine after only 1 401', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    const token = pool.selectToken(NOW);
    expect(token?.label).toBe('primary');
  });

  it('resets consecutive failure counter on success', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordSuccess('sk-ant-api01-primary');
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    // Counter reset — only 1 failure since last success, so still available
    const token = pool.selectToken(NOW);
    expect(token?.label).toBe('primary');
  });

  it('quarantined credential is skipped for ~1 hour', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    // Still quarantined 30 minutes later
    const thirtyMin = NOW + 30 * 60 * 1000;
    const token = pool.selectToken(thirtyMin);
    expect(token?.label).toBe('backup');
  });

  it('quarantined credential becomes available after 1 hour', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    // 1 hour + 1 second later quarantine expires
    const afterQuarantine = NOW + 60 * 60 * 1000 + 1000;
    const token = pool.selectToken(afterQuarantine);
    expect(token?.label).toBe('primary');
  });

  it('returns null when all credentials are quarantined', () => {
    const pool = makePool();
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordAuthFailure('sk-ant-api01-primary', NOW);
    pool.recordAuthFailure('sk-ant-api01-backup', NOW);
    pool.recordAuthFailure('sk-ant-api01-backup', NOW);
    const token = pool.selectToken(NOW);
    expect(token).toBeNull();
  });

  it('TokenState has consecutiveAuthFailures field', () => {
    const pool = makePool();
    const token = pool.selectToken(NOW);
    expect(token).not.toBeNull();
    expect(typeof (token as any).consecutiveAuthFailures).toBe('number');
  });
});
