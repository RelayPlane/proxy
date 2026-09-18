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

  it('moderate request is unchanged', () => {
    const out = resolveLiveModel({
      complexity: 'moderate',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: CHEAPER }),
      taskType: 'general',
    });
    expect(out).toBe(CANDIDATE);
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

  it('resolution failure falls back to the candidate model', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: { version: 1 } as RoutingPolicy,
      taskType: 'general',
    });
    expect(out).toBe(CANDIDATE);
  });

  it('downgrade to an unknown-priced model falls back to the candidate', () => {
    const out = resolveLiveModel({
      complexity: 'simple',
      candidateModel: CANDIDATE,
      policy: policyWith({ preferred: CANDIDATE, downgradeTo: 'anthropic/not-a-real-model' }),
      taskType: 'general',
    });
    expect(out).toBe(CANDIDATE);
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
