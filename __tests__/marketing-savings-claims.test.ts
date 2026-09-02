import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '..', '..', '..');
const marketingSiteApp = join(repositoryRoot, 'apps', 'marketing-site', 'src', 'app');

// The live site contradicted itself: title claimed 90% savings, og claimed
// 40-60%, and the internal record (notes/relayplane-true-story-2026-09-02.md
// section 5) flags 73%/77% as fabricated. None of these unverifiable
// percentage-savings figures may appear anywhere on the marketing site.
const BANNED_SAVINGS_CLAIMS = [/90%/, /77%/, /73%/, /40-60%/, /40-70%/];

// Verifiable proof points from notes/relayplane-true-story-2026-09-02.md
// section 3, safe to use in place of unverifiable percentages.
const VERIFIABLE_PROOF_POINTS = [
  /11 providers/i,
  /200,?000\+?\s*(logged\s*)?requests/i,
  /2,?400\+?\s*npm (installs|downloads)/i,
  /200\+?\s*(GitHub\s*)?stars/i,
  /\bMIT\b/,
];

const LEDGER_LANGUAGE = /ledger|meter(s|ing)?/i;

function readMarketingFiles(relativePaths: string[]): string {
  return relativePaths
    .map((relativePath) => readFileSync(join(marketingSiteApp, relativePath), 'utf8'))
    .join('\n');
}

describe('marketing site savings claims converge on record-true proof', () => {
  it('layout.tsx (title/og/twitter metadata) has no unverifiable savings percentages', () => {
    const layout = readMarketingFiles(['layout.tsx']);

    for (const bannedClaim of BANNED_SAVINGS_CLAIMS) {
      expect(layout).not.toMatch(bannedClaim);
    }
  });

  it('layout.tsx metadata mentions the local ledger/metering story and a verifiable proof point', () => {
    const layout = readMarketingFiles(['layout.tsx']);

    expect(layout).toMatch(LEDGER_LANGUAGE);
    expect(VERIFIABLE_PROOF_POINTS.some((pattern) => pattern.test(layout))).toBe(true);
  });

  it('docs pages have no unverifiable savings percentages', () => {
    const docs = readMarketingFiles([
      join('docs', 'cost-optimization', 'page.tsx'),
      join('docs', 'cost-optimization', 'savings', 'page.tsx'),
    ]);

    for (const bannedClaim of BANNED_SAVINGS_CLAIMS) {
      expect(docs).not.toMatch(bannedClaim);
    }
  });
});
