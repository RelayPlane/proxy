import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '..', '..', '..');
const marketingSiteRoot = join(repositoryRoot, 'apps', 'marketing-site');
const marketingSiteApp = join(marketingSiteRoot, 'src', 'app');
const marketingSiteSrc = join(marketingSiteRoot, 'src');

// The live site contradicted itself: title claimed 90% savings, og claimed
// 40-60%, and the internal record (notes/relayplane-true-story-2026-09-02.md
// section 5) flags 73%/77% as fabricated. None of these unverifiable
// percentage-savings figures may appear anywhere on the marketing site, not
// just on the homepage: guides, compare pages, integrations, and docs pages
// repeat the same fabricated numbers.
const BANNED_SAVINGS_CLAIMS = [/90%/, /77%/, /73%/, /40-60%/, /40-70%/, /60-90%/];

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

const SCAN_EXTENSIONS = new Set(['.tsx', '.ts', '.html', '.mdx']);

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.turbo') continue;

    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

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

  it('no page, guide, compare, integration, blog, or static asset anywhere on the marketing site contains an unverifiable savings percentage', () => {
    const files = [...walk(join(marketingSiteRoot, 'src')), ...walk(join(marketingSiteRoot, 'public'))];

    const offenders: { file: string; claim: string }[] = [];

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');

      for (const bannedClaim of BANNED_SAVINGS_CLAIMS) {
        if (bannedClaim.test(contents)) {
          offenders.push({ file, claim: bannedClaim.source });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

// PR5: the run attribution surfaces quote real dollar figures, which the
// honesty rule allows only when the same breath says they are notional list
// price (the counterfactual cost of the traffic at published per-token rates,
// not an invoice). JSX has no paragraph boundary a regex can trust, since a
// single <p> is routinely broken up by <code> and <strong>, so "same
// paragraph" is approximated by a character window either side of the figure.
const MONEY_FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const PERCENT_FIGURE = /\d[\d,]*(?:\.\d+)?\s?%/g;
const CAVEAT_WINDOW = 500;

const RUN_ATTRIBUTION_SURFACES = [
  join('app', 'docs', 'runs', 'page.tsx'),
  join('components', 'landing-v2', 'runs-section.tsx'),
  join('components', 'landing-v2', 'runs-screenshot.tsx'),
];

function uncaveatedFigures(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [MONEY_FIGURE, PERCENT_FIGURE]) {
    for (const match of source.matchAll(pattern)) {
      const at = match.index ?? 0;
      const window = source.slice(Math.max(0, at - CAVEAT_WINDOW), at + CAVEAT_WINDOW);
      if (!window.includes('notional')) found.push(match[0]);
    }
  }
  return found;
}

describe('run attribution surfaces never quote a figure without the notional caveat', () => {
  for (const relativePath of RUN_ATTRIBUTION_SURFACES) {
    it(`${relativePath} carries "notional" alongside every dollar and percent figure`, () => {
      const source = readFileSync(join(marketingSiteSrc, relativePath), 'utf8');
      expect(uncaveatedFigures(source)).toEqual([]);
    });

    it(`${relativePath} has no unverifiable savings percentage`, () => {
      const source = readFileSync(join(marketingSiteSrc, relativePath), 'utf8');
      for (const bannedClaim of BANNED_SAVINGS_CLAIMS) {
        expect(source).not.toMatch(bannedClaim);
      }
    });
  }

  it('the sniffer actually catches an uncaveated figure', () => {
    expect(uncaveatedFigures('<p>You save $42.00 every night.</p>')).toEqual(['$42.00']);
    expect(uncaveatedFigures('<p>$42.00 notional list price.</p>')).toEqual([]);
  });
});
