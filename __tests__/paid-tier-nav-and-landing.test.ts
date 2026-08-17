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

    // The honest-positioning revamp removed the paid tiers entirely, so none of
    // the Pro / Kill switch / Pricing labels should appear in the primary chrome.
    expect(combined).not.toMatch(/>\s*Pro\s*</);
    expect(combined).not.toMatch(/>\s*Kill switch\s*</);
    expect(combined).not.toMatch(/>\s*Pricing\s*</);
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
