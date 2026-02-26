export type VersionState = 'up-to-date' | 'outdated' | 'unavailable';

export interface VersionStatus {
  state: VersionState;
  current: string;
  latest: string | null;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));

  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  return 0;
}

export function getVersionStatus(current: string, latest: string | null): VersionStatus {
  if (!latest) {
    return { state: 'unavailable', current, latest: null };
  }

  return {
    state: compareSemver(current, latest) < 0 ? 'outdated' : 'up-to-date',
    current,
    latest,
  };
}
