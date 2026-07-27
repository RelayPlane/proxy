import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// RelayPlane is free and open source (MIT). plans.config.json is a single
// free plan with every feature included, no paid tiers. Cost guardrails
// (hard caps, auto-kill, runaway-loop detection) are no longer tier-gated;
// they ship to everyone. These tests guard against a paid tier creeping back.
describe('plans.config.json - free and open source', () => {
  const plansPath = join(__dirname, '..', '..', '..', 'plans.config.json');
  const plans = JSON.parse(readFileSync(plansPath, 'utf8'));

  it('test_only_the_free_plan_exists', () => {
    expect(Object.keys(plans.plans)).toEqual(['free']);
  });

  it('test_free_plan_is_zero_cost', () => {
    expect(plans.plans.free.price_monthly).toBe(0);
  });

  it('test_no_paid_tiers', () => {
    const paid = Object.values(plans.plans).filter(
      (p: any) => typeof p.price_monthly === 'number' && p.price_monthly > 0,
    );
    expect(paid).toHaveLength(0);
  });
});
