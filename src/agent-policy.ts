/**
 * Agent-Aware Routing Policy
 *
 * Manages loading, caching, and resolving routing policies from ~/.relayplane/policy.yaml.
 * Policies allow per-agent and per-task model overrides.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { load as yamlLoad } from 'js-yaml';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskPolicy {
  preferred: string;               // "provider/model" or alias
  neverDowngrade?: boolean;
  escalateTo?: string;
  escalateOn?: Array<'complexity_high' | 'rate_limit' | 'error'>;
}

export interface AgentPolicy {
  fingerprint?: string;            // Optional — matched by name if absent
  preferred: string;
  escalateTo?: string;
  escalateOn?: Array<'complexity_high' | 'rate_limit' | 'error'>;
  fallback?: string;
  neverDowngrade?: boolean;
  budgetPerDay?: number;
  tasks?: Record<string, TaskPolicy>;  // per-taskType overrides
}

export interface RoutingPolicy {
  version: number;
  agents?: Record<string, AgentPolicy>;  // keyed by human name
  tasks?: Record<string, TaskPolicy>;    // keyed by TaskType
}

export type ResolvedBy =
  | 'agent_task_override'
  | 'task_rule'
  | 'agent_rule'
  | 'complexity_routing'
  | 'default_routing'
  | 'passthrough';

export interface PolicyResolution {
  model: string;             // "provider/model" string
  resolvedBy: ResolvedBy;
  neverDowngrade: boolean;
  reason: string;            // human-readable explanation
  candidateModel?: string;   // what would have been chosen without policy
}

// ─── File Loading ─────────────────────────────────────────────────────────────

const POLICY_DIR = path.join(os.homedir(), '.relayplane');
export const POLICY_FILE = path.join(POLICY_DIR, 'policy.yaml');
const CACHE_TTL_MS = 5000;

interface PolicyCache {
  policy: RoutingPolicy;
  loadedAt: number;
}

let _cache: PolicyCache | null = null;

/** Reset cache — for testing only */
export function _resetPolicyCache(): void {
  _cache = null;
}

/**
 * Load routing policy from ~/.relayplane/policy.yaml with 5-second TTL cache.
 * Returns empty policy { version: 1 } if file is missing or invalid.
 */
export function loadPolicy(): RoutingPolicy {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache.policy;
  }

  if (!fs.existsSync(POLICY_FILE)) {
    _cache = { policy: { version: 1 }, loadedAt: now };
    return _cache.policy;
  }

  try {
    const raw = fs.readFileSync(POLICY_FILE, 'utf-8');
    const parsed = yamlLoad(raw) as RoutingPolicy;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      if (parsed && typeof parsed === 'object' && parsed.version !== 1) {
        console.warn(`[RelayPlane] policy.yaml: unsupported version ${(parsed as RoutingPolicy).version}, expected 1`);
      }
      _cache = { policy: { version: 1 }, loadedAt: now };
      return _cache.policy;
    }
    _cache = { policy: parsed, loadedAt: now };
    return parsed;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[RelayPlane] policy.yaml parse error: ${msg}`);
    _cache = { policy: { version: 1 }, loadedAt: now };
    return { version: 1 };
  }
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve which model to use for a request, given the loaded policy.
 *
 * Resolution priority:
 * 1. agent.tasks[taskType] override (agent_task_override)
 * 2. policy.tasks[taskType] rule (task_rule)
 * 3. agent-level rule (agent_rule)
 * 4. pass-through: use candidateModel (complexity_routing)
 */
export function resolvePolicy(
  policy: RoutingPolicy,
  agentFingerprint: string | undefined,
  agentName: string | undefined,
  taskType: string,
  complexity: 'simple' | 'moderate' | 'complex',
  candidateModel: string,
): PolicyResolution {
  const emptyPolicy = !policy.agents && !policy.tasks;

  // Find matching agent entry
  let matchedAgentName: string | null = null;
  let matchedAgent: AgentPolicy | null = null;

  if (policy.agents) {
    for (const [name, agent] of Object.entries(policy.agents)) {
      if (agent.fingerprint && agentFingerprint && agent.fingerprint === agentFingerprint) {
        matchedAgentName = name;
        matchedAgent = agent;
        break;
      }
    }
    // Match by name if fingerprint didn't match
    if (!matchedAgent && agentName && policy.agents[agentName]) {
      matchedAgentName = agentName;
      matchedAgent = policy.agents[agentName]!;
    }
  }

  // 1. Agent task override
  if (matchedAgent && matchedAgent.tasks && matchedAgent.tasks[taskType]) {
    const rule = matchedAgent.tasks[taskType]!;
    const model = resolveEscalation(rule, complexity) ?? rule.preferred;
    return {
      model,
      resolvedBy: 'agent_task_override',
      neverDowngrade: rule.neverDowngrade === true,
      reason: `Agent "${matchedAgentName}" task override for "${taskType}": ${model}`,
      candidateModel,
    };
  }

  // 2. Global task rule
  if (policy.tasks && policy.tasks[taskType]) {
    const rule = policy.tasks[taskType]!;
    const model = resolveEscalation(rule, complexity) ?? rule.preferred;
    return {
      model,
      resolvedBy: 'task_rule',
      neverDowngrade: rule.neverDowngrade === true,
      reason: `Task rule for "${taskType}": ${model}`,
      candidateModel,
    };
  }

  // 3. Agent-level rule
  if (matchedAgent) {
    const model = resolveAgentEscalation(matchedAgent, complexity) ?? matchedAgent.preferred;
    return {
      model,
      resolvedBy: 'agent_rule',
      neverDowngrade: matchedAgent.neverDowngrade === true,
      reason: `Agent rule for "${matchedAgentName}": ${model}`,
      candidateModel,
    };
  }

  // 4. Pass-through
  return {
    model: candidateModel,
    resolvedBy: emptyPolicy ? 'default_routing' : 'complexity_routing',
    neverDowngrade: false,
    reason: 'No policy rule matched; using complexity routing',
    candidateModel,
  };
}

function resolveEscalation(
  rule: TaskPolicy,
  complexity: 'simple' | 'moderate' | 'complex',
): string | null {
  if (
    rule.escalateTo &&
    rule.escalateOn &&
    rule.escalateOn.includes('complexity_high') &&
    complexity === 'complex'
  ) {
    return rule.escalateTo;
  }
  return null;
}

function resolveAgentEscalation(
  agent: AgentPolicy,
  complexity: 'simple' | 'moderate' | 'complex',
): string | null {
  if (
    agent.escalateTo &&
    agent.escalateOn &&
    agent.escalateOn.includes('complexity_high') &&
    complexity === 'complex'
  ) {
    return agent.escalateTo;
  }
  return null;
}
