import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '..', '..', '..');
const marketingComponents = join(repositoryRoot, 'apps', 'marketing-site', 'src', 'components');

describe('marketing site paid-tier cleanup', () => {
  it('keeps paid-tier framing (Pro, Kill switch, Pricing) out of nav and footer', () => {
    const combined = ['site-nav.tsx', 'site-footer.tsx']
      .map((file) => readFileSync(join(marketingComponents, file), 'utf8'))
      .join('\n');

    // The honest-positioning revamp removed the old paid tiers, so the old
    // paid-tier framing (Pro, Kill switch) must not appear in the primary chrome.
    // Reconciled 2026-09-06: a /pricing page IS intentional again, the hosted-tier
    // fake-door demand test (PR #280) lives there and must be discoverable, so a
    // "Pricing" nav link is allowed. The page itself is free-proxy + a hosted
    // waitlist, not a resurrected paid tier.
    expect(combined).not.toMatch(/>\s*Pro\s*</);
    expect(combined).not.toMatch(/>\s*Kill switch\s*</);
  });

  it('removes obsolete landing components that preserve paid-tier UI', () => {
    const obsoleteComponents = [
      'feature-matrix.tsx',
      'landing-page.tsx',
      join('landing', 'pricing-section.tsx'),
    ];

    expect(
      obsoleteComponents.filter((file) => existsSync(join(marketingComponents, file)))
    ).toEqual([]);
  });
});
