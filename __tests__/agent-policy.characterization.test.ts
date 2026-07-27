/**
 * Characterization tests for src/agent-policy.ts (resolvePolicy).
 *
 * These tests pin down CURRENT behavior, observed by reading and executing
 * the code. They are not a spec of intended behavior. If one of these fails
 * after a source change, the behavior changed; decide deliberately whether
 * that change was intended.
 *
 * loadPolicy() is intentionally NOT exercised here: POLICY_FILE is fixed to
 * a path under os.homedir() at module load time, so testing it would touch
 * the real home directory. resolvePolicy is pure given a policy object, so
 * we construct policies inline. _resetPolicyCache() is called defensively
 * in case another suite in the same worker populated the cache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePolicy,
  _resetPolicyCache,
  type RoutingPolicy,
} from '../src/agent-policy.js';

const CANDIDATE = 'anthropic/claude-3-5-haiku';

describe('resolvePolicy characterization', () => {
  beforeEach(() => {
    _resetPolicyCache();
  });

  describe('pass-through (no rule matches)', () => {
    it('empty policy (no agents, no tasks) resolves to candidateModel via default_routing', () => {
      const policy: RoutingPolicy = { version: 1 };
      const res = resolvePolicy(policy, undefined, undefined, 'code', 'simple', CANDIDATE);
      expect(res).toEqual({
        model: CANDIDATE,
        resolvedBy: 'default_routing',
        neverDowngrade: false,
        reason: 'No policy rule matched; using complexity routing',
        candidateModel: CANDIDATE,
      });
    });

    it('policy with an EMPTY agents object is not treated as empty: resolvedBy is complexity_routing', () => {
      // Observed: emptyPolicy is computed as (!policy.agents && !policy.tasks),
      // so agents: {} flips the pass-through label from default_routing to
      // complexity_routing even though no rule can possibly match.
      const policy: RoutingPolicy = { version: 1, agents: {} };
      const res = resolvePolicy(policy, undefined, undefined, 'code', 'simple', CANDIDATE);
      expect(res.model).toBe(CANDIDATE);
      expect(res.resolvedBy).toBe('complexity_routing');
      expect(res.neverDowngrade).toBe(false);
    });

    it('non-empty policy with no matching agent or task passes through as complexity_routing', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: { alice: { preferred: 'openai/gpt-4o' } },
        tasks: { summarize: { preferred: 'openai/gpt-4o-mini' } },
      };
      const res = resolvePolicy(policy, undefined, 'bob', 'code', 'complex', CANDIDATE);
      expect(res).toEqual({
        model: CANDIDATE,
        resolvedBy: 'complexity_routing',
        neverDowngrade: false,
        reason: 'No policy rule matched; using complexity routing',
        candidateModel: CANDIDATE,
      });
    });
  });

  describe('precedence order', () => {
    const fullPolicy: RoutingPolicy = {
      version: 1,
      agents: {
        alice: {
          preferred: 'agent/pref-model',
          tasks: {
            code: { preferred: 'agent-task/model' },
          },
        },
      },
      tasks: {
        code: { preferred: 'task/model' },
      },
    };

    it('agent.tasks[taskType] beats global task rule and agent rule (agent_task_override)', () => {
      const res = resolvePolicy(fullPolicy, undefined, 'alice', 'code', 'simple', CANDIDATE);
      expect(res.model).toBe('agent-task/model');
      expect(res.resolvedBy).toBe('agent_task_override');
      expect(res.reason).toBe('Agent "alice" task override for "code": agent-task/model');
      expect(res.candidateModel).toBe(CANDIDATE);
    });

    it('global task rule beats agent-level rule when the agent has no task override (task_rule)', () => {
      const res = resolvePolicy(fullPolicy, undefined, 'alice', 'review', 'simple', CANDIDATE);
      // 'review' is not in alice.tasks, and not in policy.tasks either, so
      // this falls to the agent rule. Use a taskType present only globally.
      expect(res.resolvedBy).toBe('agent_rule');

      const policy: RoutingPolicy = {
        version: 1,
        agents: { alice: { preferred: 'agent/pref-model' } },
        tasks: { code: { preferred: 'task/model' } },
      };
      const res2 = resolvePolicy(policy, undefined, 'alice', 'code', 'simple', CANDIDATE);
      expect(res2.model).toBe('task/model');
      expect(res2.resolvedBy).toBe('task_rule');
      expect(res2.reason).toBe('Task rule for "code": task/model');
    });

    it('agent-level rule applies when no task rules match (agent_rule)', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: { alice: { preferred: 'agent/pref-model' } },
      };
      const res = resolvePolicy(policy, undefined, 'alice', 'anything', 'moderate', CANDIDATE);
      expect(res.model).toBe('agent/pref-model');
      expect(res.resolvedBy).toBe('agent_rule');
      expect(res.reason).toBe('Agent rule for "alice": agent/pref-model');
      expect(res.neverDowngrade).toBe(false);
    });

    it('a global task rule applies even for an agent with no policy entry', () => {
      const policy: RoutingPolicy = {
        version: 1,
        tasks: { code: { preferred: 'task/model' } },
      };
      const res = resolvePolicy(policy, 'fp-unknown', 'nobody', 'code', 'simple', CANDIDATE);
      expect(res.resolvedBy).toBe('task_rule');
      expect(res.model).toBe('task/model');
    });
  });

  describe('agent matching (fingerprint vs name)', () => {
    it('matches by fingerprint even when the request agentName differs from the policy key', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: {
          alice: { fingerprint: 'fp-123', preferred: 'alice/model' },
          bob: { preferred: 'bob/model' },
        },
      };
      // agentName says "bob" but fingerprint matches alice: fingerprint wins.
      const res = resolvePolicy(policy, 'fp-123', 'bob', 'code', 'simple', CANDIDATE);
      expect(res.model).toBe('alice/model');
      expect(res.reason).toBe('Agent rule for "alice": alice/model');
    });

    it('falls back to name matching when the fingerprint matches no entry', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: {
          alice: { fingerprint: 'fp-123', preferred: 'alice/model' },
          bob: { preferred: 'bob/model' },
        },
      };
      const res = resolvePolicy(policy, 'fp-nomatch', 'bob', 'code', 'simple', CANDIDATE);
      expect(res.model).toBe('bob/model');
      expect(res.resolvedBy).toBe('agent_rule');
    });

    it('an agent entry with a fingerprint is still matchable by name when no fingerprint is sent', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: { alice: { fingerprint: 'fp-123', preferred: 'alice/model' } },
      };
      const res = resolvePolicy(policy, undefined, 'alice', 'code', 'simple', CANDIDATE);
      expect(res.model).toBe('alice/model');
      expect(res.resolvedBy).toBe('agent_rule');
    });
  });

  describe('escalation triggers', () => {
    it('task rule escalates to escalateTo only when escalateOn includes complexity_high AND complexity is complex', () => {
      const policy: RoutingPolicy = {
        version: 1,
        tasks: {
          code: {
            preferred: 'cheap/model',
            escalateTo: 'big/model',
            escalateOn: ['complexity_high'],
          },
        },
      };
      const complex = resolvePolicy(policy, undefined, undefined, 'code', 'complex', CANDIDATE);
      expect(complex.model).toBe('big/model');
      expect(complex.reason).toBe('Task rule for "code": big/model');

      const moderate = resolvePolicy(policy, undefined, undefined, 'code', 'moderate', CANDIDATE);
      expect(moderate.model).toBe('cheap/model');

      const simple = resolvePolicy(policy, undefined, undefined, 'code', 'simple', CANDIDATE);
      expect(simple.model).toBe('cheap/model');
    });

    it('rate_limit and error triggers do NOT escalate here, even at complex complexity', () => {
      // Observed: resolveEscalation only ever fires on the complexity_high
      // trigger. rate_limit/error entries are inert in resolvePolicy.
      const policy: RoutingPolicy = {
        version: 1,
        tasks: {
          code: {
            preferred: 'cheap/model',
            escalateTo: 'big/model',
            escalateOn: ['rate_limit', 'error'],
          },
        },
      };
      const res = resolvePolicy(policy, undefined, undefined, 'code', 'complex', CANDIDATE);
      expect(res.model).toBe('cheap/model');
    });

    it('escalateTo without escalateOn never escalates', () => {
      const policy: RoutingPolicy = {
        version: 1,
        tasks: { code: { preferred: 'cheap/model', escalateTo: 'big/model' } },
      };
      const res = resolvePolicy(policy, undefined, undefined, 'code', 'complex', CANDIDATE);
      expect(res.model).toBe('cheap/model');
    });

    it('agent-level escalation follows the same complexity_high rule', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: {
          alice: {
            preferred: 'cheap/model',
            escalateTo: 'big/model',
            escalateOn: ['complexity_high'],
          },
        },
      };
      const complex = resolvePolicy(policy, undefined, 'alice', 'code', 'complex', CANDIDATE);
      expect(complex.model).toBe('big/model');
      expect(complex.reason).toBe('Agent rule for "alice": big/model');

      const simple = resolvePolicy(policy, undefined, 'alice', 'code', 'simple', CANDIDATE);
      expect(simple.model).toBe('cheap/model');
    });

    it('agent task override escalation also honors complexity_high', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: {
          alice: {
            preferred: 'agent/model',
            tasks: {
              code: {
                preferred: 'cheap/model',
                escalateTo: 'big/model',
                escalateOn: ['complexity_high'],
              },
            },
          },
        },
      };
      const res = resolvePolicy(policy, undefined, 'alice', 'code', 'complex', CANDIDATE);
      expect(res.model).toBe('big/model');
      expect(res.resolvedBy).toBe('agent_task_override');
      expect(res.reason).toBe('Agent "alice" task override for "code": big/model');
    });
  });

  describe('neverDowngrade propagation', () => {
    it('is true only when the MATCHED rule sets neverDowngrade === true', () => {
      const policy: RoutingPolicy = {
        version: 1,
        tasks: { code: { preferred: 'task/model', neverDowngrade: true } },
      };
      const res = resolvePolicy(policy, undefined, undefined, 'code', 'simple', CANDIDATE);
      expect(res.neverDowngrade).toBe(true);
    });

    it('agent-level neverDowngrade does not leak into a matched task rule', () => {
      const policy: RoutingPolicy = {
        version: 1,
        agents: { alice: { preferred: 'agent/model', neverDowngrade: true } },
        tasks: { code: { preferred: 'task/model' } },
      };
      // Task rule wins the match and its (absent) neverDowngrade governs.
      const res = resolvePolicy(policy, undefined, 'alice', 'code', 'simple', CANDIDATE);
      expect(res.resolvedBy).toBe('task_rule');
      expect(res.neverDowngrade).toBe(false);

      // Whereas an agent_rule match does carry the agent flag.
      const res2 = resolvePolicy(policy, undefined, 'alice', 'other', 'simple', CANDIDATE);
      expect(res2.resolvedBy).toBe('agent_rule');
      expect(res2.neverDowngrade).toBe(true);
    });
  });

  it('candidateModel is echoed back on every resolution path', () => {
    const policy: RoutingPolicy = {
      version: 1,
      agents: { alice: { preferred: 'agent/model', tasks: { code: { preferred: 'at/model' } } } },
      tasks: { review: { preferred: 'task/model' } },
    };
    const paths = [
      resolvePolicy(policy, undefined, 'alice', 'code', 'simple', CANDIDATE),
      resolvePolicy(policy, undefined, 'alice', 'review', 'simple', CANDIDATE),
      resolvePolicy(policy, undefined, 'alice', 'other', 'simple', CANDIDATE),
      resolvePolicy(policy, undefined, 'nobody', 'other', 'simple', CANDIDATE),
      resolvePolicy({ version: 1 }, undefined, undefined, 'x', 'simple', CANDIDATE),
    ];
    for (const res of paths) {
      expect(res.candidateModel).toBe(CANDIDATE);
    }
  });
});
