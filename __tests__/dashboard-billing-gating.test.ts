import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MARKETING_SRC = resolve(__dirname, '../../../apps/marketing-site/src');

const retiredModules = [
  'app/dashboard/billing/page.tsx',
  'components/dashboard/page-gate.tsx',
  'components/dashboard/upgrade-prompt.tsx',
  'components/dashboard/plan-badge.tsx',
  'hooks/use-plan.ts',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('rp-strip-dashboard-billing-gating-2026-07-12', () => {
  it('removes dashboard billing and plan-gating code', () => {
    const violations: string[] = [];

    for (const retiredModule of retiredModules) {
      if (existsSync(resolve(MARKETING_SRC, retiredModule))) {
        violations.push(`retired module still exists: ${retiredModule}`);
      }
    }

    const dashboardPattern =
      /PageGate|UpgradePrompt|TierGate|PlanBadge|usePlan|\/dashboard\/billing/;
    const dashboardDirectory = resolve(MARKETING_SRC, 'app/dashboard');

    for (const file of sourceFiles(dashboardDirectory)) {
      if (dashboardPattern.test(readFileSync(file, 'utf8'))) {
        violations.push(`dashboard gating remains in: ${relative(MARKETING_SRC, file)}`);
      }
    }

    const dashboardExports = readFileSync(
      resolve(MARKETING_SRC, 'components/dashboard/index.ts'),
      'utf8',
    );
    if (/PageGate|UpgradePrompt|TierGate|PlanBadge/.test(dashboardExports)) {
      violations.push('dashboard barrel still exports plan-gating components');
    }

    const apiClient = readFileSync(resolve(MARKETING_SRC, 'lib/api-client.ts'), 'utf8');
    if (/createCheckout|createPortalSession|getSubscription/.test(apiClient)) {
      violations.push('api-client still exports dashboard billing helpers');
    }

    expect(violations).toEqual([]);
  });
});
