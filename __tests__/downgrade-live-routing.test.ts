import { describe, it, expect } from 'vitest';
import { resolveLiveModel } from '../src/standalone-proxy.js';
import type { RoutingPolicy } from '../src/agent-policy.js';

const CANDIDATE = 'anthropic/claude-opus-5';
const CHEAPER = 'anthropic/claude-haiku-4-5';

function policyWith(rule: Record<string, unknown>): RoutingPolicy {
  return { version: 1, tasks: { general: rule } } as unknown as RoutingPolicy;
}

describe('resolveLiveModel (live downgrade wiring)', () => {
  it('simple request downgrades to the strictly-cheaper policy model on the live path', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: CHEAPER }),
      taskType: 'general',
    });
    expect(out).toBe(CHEAPER);
  });

  // Contract change (always-on routing): a moderate request now routes DOWN to
  // the cheaper complexity tier (Sonnet) even without an explicit policy. This
  // is the fix for the "escalated up, routed zero down" gap; the classifier is
  // authoritative so a caller does not need to hand-set a default model.
  it('moderate request routes down to the cheaper tier (Sonnet), no policy needed', () => {
    const out = resolveLiveModel({
      complexity: 'moderate',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: CHEAPER }),
      taskType: 'general',
    });
    expect(out).toBe('claude-sonnet-5');
  });

  it('complex request is unchanged', () => {
    const out = resolveLiveModel({
      complexity: 'complex',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: CHEAPER }),
      taskType: 'general',
    });
    expect(out).toBe(CANDIDATE);
  });

  it('elite request keeps the elite candidate and is never downgraded', () => {
    const elite = 'anthropic/claude-fable-5-1';
    const out = resolveLiveModel({
      complexity: 'elite',
      candidateModel: elite,
      policy: policyWith({ preferred: elite, downgradeTo: CHEAPER }),
      taskType: 'general',
    });
    expect(out).toBe(elite);
  });

  it('neverDowngrade policy is not downgraded even when simple', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: CHEAPER, neverDowngrade: true }),
      taskType: 'general',
    });
    expect(out).toBe(CANDIDATE);
  });

  // Contract change: an EMPTY policy no longer means "no downgrade". A simple
  // request routes down to the built-in cheaper tier (Sonnet floor here, since
  // no Haiku-capable key is passed). complex/elite still fall back safely.
  it('empty policy still routes a simple request down to the cheaper tier', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: { version: 1 } as RoutingPolicy,
      taskType: 'general',
    });
    expect(out).toBe('claude-sonnet-5');
  });

  it('an unknown-priced policy downgradeTo is ignored; falls to the built-in tier', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: 'anthropic/not-a-real-model' }),
      taskType: 'general',
    });
    // The unknown policy target is never used (its price can't be verified);
    // the policy-free tier downgrade still applies, landing on the Sonnet floor.
    expect(out).not.toBe('anthropic/not-a-real-model');
    expect(out).toBe('claude-sonnet-5');
  });

  it('downgrade that is not strictly cheaper falls back to the candidate', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CHEAPER,
      policy: policyWith({ preferred: CHEAPER, downgradeTo: CANDIDATE }),
      taskType: 'general',
    });
    expect(out).toBe(CHEAPER);
  });
});
