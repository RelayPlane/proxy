import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// plans.config.json v5.0 collapsed Pro/Fleet into a single free plan, but
// free.features still concatenates leftover strings from the deleted tiers
// ('Everything in Free', 'Everything in Pro', 'Priority support',
// 'Dedicated support'). Those are nonsense in a single-plan world and are
// one render away from shipping to the marketing site / API. This guards
// against that debris, and against re-introduced duplicates.
describe('plans.config.json - free.features is clean', () => {
  const plansPath = join(__dirname, '..', '..', '..', 'plans.config.json');
  const plans = JSON.parse(readFileSync(plansPath, 'utf8'));
  const features: string[] = plans.plans.free.features;

  it('test_no_leftover_tier_references', () => {
    const leftovers = features.filter((f) =>
      /Everything in|Priority support|Dedicated support/.test(f),
    );
    expect(leftovers).toEqual([]);
  });

  it('test_features_are_deduplicated', () => {
    expect(new Set(features).size).toBe(features.length);
  });
});
