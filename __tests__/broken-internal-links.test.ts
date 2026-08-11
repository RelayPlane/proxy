import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '../../../apps/marketing-site/src/app');

const links = [
  {
    file: 'openclaw-proxy/page.tsx',
    label: 'Full Setup Guide',
  },
  {
    file: 'compare/aisix/page.tsx',
    label: 'Compare all alternatives',
  },
  {
    file: 'compare/microsoft-agent-framework/page.tsx',
    label: 'Compare all alternatives',
  },
  {
    file: 'insights/page.tsx',
    label: 'Sign in to see yours',
  },
  {
    file: 'insights/page.tsx',
    label: 'Open Insights Dashboard',
  },
  {
    file: 'guides/openclaw-proxy-setup/page.tsx',
    label: 'Guides',
  },
  {
    file: 'guides/reduce-claude-code-costs/page.tsx',
    label: 'Guides',
  },
  {
    file: 'guides/local-first-ai-automation/page.tsx',
    label: 'Guides',
  },
  {
    file: 'guides/openclaw-proxy-cost-guide/page.tsx',
    label: 'Guides',
  },
];

function hrefForLink(file: string, label: string): string {
  const source = readFileSync(resolve(APP_ROOT, file), 'utf8');
  const linkPattern = /<Link\b(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/Link>/g;
  const match = [...source.matchAll(linkPattern)].find((candidate) =>
    candidate[2].includes(label),
  );

  expect(match, `${file} should render a Link labelled "${label}"`).toBeDefined();
  return match![1];
}

function routeExists(href: string): boolean {
  const pathname = href.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/';
  const routeDirectory = pathname === '/' ? APP_ROOT : resolve(APP_ROOT, `.${pathname}`);

  return ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'page.mdx'].some((page) =>
    existsSync(resolve(routeDirectory, page)),
  );
}

describe('rp-fix-broken-internal-links-2026-07-12', () => {
  it.each(links)('$file "$label" points to an existing internal route', ({ file, label }) => {
    const href = hrefForLink(file, label);

    expect(href, `${file} "${label}" should remain an internal link`).toMatch(/^\/(?!\/)/);
    expect(routeExists(href), `${file} "${label}" points to missing route ${href}`).toBe(true);
  });
});
