/**
 * Guards the two CI workflows that were red on config, not code
 * (opportunity scan 2026-09-04): validate-pricing looped over plans that
 * no longer exist, and docs.yml pushed without contents: write.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('validate-pricing.yml agrees with plans.config.json', () => {
  const wf = read('.github/workflows/validate-pricing.yml');
  const plans = JSON.parse(read('plans.config.json')) as { plans: Record<string, { price_monthly: number }> };

  it('only loops over plans that exist in the config', () => {
    const m = /for plan in ([a-z ]+); do/.exec(wf);
    expect(m, 'plan loop not found').not.toBeNull();
    for (const plan of m![1]!.trim().split(/\s+/)) {
      expect(Object.keys(plans.plans), `workflow checks plan '${plan}'`).toContain(plan);
    }
  });

  it('does not hardcode prices for plans missing from the config', () => {
    for (const plan of ['pro', 'fleet', 'max', 'starter']) {
      if (!(plan in plans.plans)) {
        expect(wf, `references .plans.${plan}`).not.toMatch(new RegExp(`\\.plans\\.${plan}\\b`));
      }
    }
  });

  it('every plan in the config is free (open-source only)', () => {
    for (const [name, plan] of Object.entries(plans.plans)) {
      expect(plan.price_monthly, name).toBe(0);
    }
  });
});

describe('docs.yml can push the types reference', () => {
  const wf = read('.github/workflows/docs.yml');

  it('declares a restrictive top-level permissions block', () => {
    expect(wf).toMatch(/^permissions:\n\s+contents: read/m);
  });

  it('grants contents: write to the job that runs git push', () => {
    const jobStart = wf.indexOf('  generate-types:');
    expect(jobStart).toBeGreaterThan(-1);
    const job = wf.slice(jobStart);
    expect(job).toMatch(/permissions:\n\s+contents: write/);
    expect(job).toMatch(/git push/);
  });
});
