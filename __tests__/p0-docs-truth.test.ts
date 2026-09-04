/**
 * P0-3 (install test 2026-09-04, matrix row 4c and the "23 docs lies" list):
 * the two getting-started pages told users to run `npx relayplane start`,
 * which is E404 on npm (the package is @relayplane/proxy). The budget docs
 * described three incompatible config schemas, two of which never existed.
 *
 * These assertions pin the docs to what the shipped proxy actually does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..', '..');
const docs = join(repoRoot, 'apps', 'marketing-site', 'src', 'app', 'docs');
const read = (p: string) => readFileSync(p, 'utf8');

const firstRun = join(docs, 'getting-started', 'first-run', 'page.tsx');
const quickstart = join(docs, 'getting-started', 'quickstart', 'page.tsx');
const budgetCap = join(docs, 'budget-cap', 'page.tsx');
const costCaps = join(docs, 'cost-caps', 'page.tsx');
const cliDoc = join(docs, 'proxy', 'cli', 'page.tsx');
const installDoc = join(docs, 'installation', 'page.tsx');
const rootReadme = join(repoRoot, 'README.md');

describe('getting-started pages use a command that exists on npm', () => {
  for (const page of [firstRun, quickstart]) {
    it(`${page.replace(repoRoot, '')} does not say "npx relayplane start"`, () => {
      const src = read(page);
      expect(src).not.toMatch(/npx relayplane start/);
      expect(src).toMatch(/npx @relayplane\/proxy|relayplane start/);
    });
  }

  it('first-run does not document /v1/runs/:id or /explain endpoints the proxy does not serve', () => {
    const src = read(firstRun);
    expect(src).not.toMatch(/\/v1\/runs\//);
    expect(src).not.toMatch(/"relayplane": \{/);
    expect(src).toMatch(/_relayplane/);
    expect(src).toMatch(/\/v1\/telemetry\/runs/);
  });

  it('quickstart does not document /v1/runs/:id/explain', () => {
    expect(read(quickstart)).not.toMatch(/\/v1\/runs\//);
  });

  it('SDK examples do not append /v1 to the base URL (the SDK adds /v1/messages itself)', () => {
    for (const page of [firstRun, quickstart]) {
      expect(read(page)).not.toMatch(/baseURL: 'http:\/\/localhost:4100\/v1'/);
    }
  });
});

describe('budget docs describe the one schema that actually enforces', () => {
  it('budget-cap page uses config.json budget.enabled/dailyUsd/onBreach, not relayplane.config.js', () => {
    const src = read(budgetCap);
    expect(src).not.toMatch(/relayplane\.config\.js/);
    expect(src).not.toMatch(/capAction/);
    expect(src).not.toMatch(/relayplane sessions/);
    expect(src).not.toMatch(/npx relayplane start/);
    expect(src).toMatch(/"dailyUsd"/);
    expect(src).toMatch(/"onBreach"/);
    expect(src).toMatch(/budget_exceeded/);
  });

  it('cost-caps page does not describe a YAML config the proxy never reads', () => {
    const src = read(costCaps);
    expect(src).not.toMatch(/relayplane\.config\.yml/);
    expect(src).not.toMatch(/cost_cap_exceeded/);
    expect(src).toMatch(/budget_exceeded/);
    expect(src).toMatch(/relayplane cap set --day/);
    expect(src).toMatch(/relayplane kill\b/);
  });

  it('root README shows the config.json budget form, not only the programmatic API', () => {
    const src = read(rootReadme);
    expect(src).toMatch(/"dailyUsd"/);
    expect(src).not.toMatch(/Pro killswitch/);
  });
});

describe('CLI reference matches the shipped CLI', () => {
  it('upgrade is described as opening the pricing page, not installing updates', () => {
    const src = read(cliDoc);
    expect(src).not.toMatch(/Check for proxy updates and install/);
  });
  it('start does not claim a provider key is required', () => {
    expect(read(cliDoc)).not.toMatch(/Requires at least one provider API key/);
  });
  it('status example does not show rows the command never prints', () => {
    const src = read(cliDoc);
    expect(src).not.toMatch(/Autostart:\s+✅ Enabled/);
    expect(src).not.toMatch(/API Key:\s+••••abcd/);
  });
  it('documents kill / resume as the traffic halt and disable as passthrough', () => {
    const src = read(cliDoc);
    expect(src).toMatch(/relayplane kill/);
    expect(src).toMatch(/relayplane resume/);
  });
  it('installation page version example matches the real output format', () => {
    if (!existsSync(installDoc)) return;
    expect(read(installDoc)).not.toMatch(/1\.7\.7/);
  });
});
