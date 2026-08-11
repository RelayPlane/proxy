import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '..', '..', '..');
const marketingComponents = join(repositoryRoot, 'apps', 'marketing-site', 'src', 'components');

describe('marketing site paid-tier cleanup', () => {
  it('relabels every Pro navigation entry as the kill switch', () => {
    const navigationSources = ['site-nav.tsx', 'site-footer.tsx'].map((file) =>
      readFileSync(join(marketingComponents, file), 'utf8')
    );

    expect(navigationSources.join('\n')).not.toMatch(/>\s*Pro\s*</);
    expect(navigationSources.join('\n').match(/>\s*Kill switch\s*</g)).toHaveLength(3);
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
