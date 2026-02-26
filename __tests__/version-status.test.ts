import { describe, expect, it } from 'vitest';
import { compareSemver, getVersionStatus } from '../src/utils/version-status';

describe('compareSemver', () => {
  it('compares versions correctly', () => {
    expect(compareSemver('1.7.0', '1.7.0')).toBe(0);
    expect(compareSemver('1.7.0', '1.7.1')).toBe(-1);
    expect(compareSemver('1.8.0', '1.7.9')).toBe(1);
  });
});

describe('getVersionStatus', () => {
  it('returns up-to-date state', () => {
    expect(getVersionStatus('1.7.0', '1.7.0')).toEqual({
      state: 'up-to-date',
      current: '1.7.0',
      latest: '1.7.0',
    });
  });

  it('returns outdated state', () => {
    expect(getVersionStatus('1.6.9', '1.7.0').state).toBe('outdated');
  });

  it('returns unavailable state when latest cannot be fetched', () => {
    expect(getVersionStatus('1.7.0', null)).toEqual({
      state: 'unavailable',
      current: '1.7.0',
      latest: null,
    });
  });
});
