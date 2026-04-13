/**
 * Policy Suggestions
 *
 * Takes AgentAnalysis[] and available providers to produce PolicySuggestion[]
 * with model recommendations and savings estimates.
 */

import { getProviderConfigs } from './config.js';
import { estimateDailyCost } from './policy-analyzer.js';
import type { AgentAnalysis } from './policy-analyzer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolicySuggestion {
  fingerprint: string;
  agentName: string;
  currentModel: string;
  suggestedModel: string;                                            // primary model to route to
  escalateTo?: string;                                               // optional escalation target
  escalateOn?: Array<'complexity_high' | 'rate_limit' | 'error'>;
  neverDowngrade: boolean;
  reason: string;                                                    // one-line human-readable explanation
  estimatedDailySavings: number;                                     // USD; negative means this costs more
  estimatedMonthlySavings: number;                                   // estimatedDailySavings * 30
  noSuggestion?: boolean;                                            // true if no cheaper provider available
  noSuggestionReason?: string;                                       // why no suggestion
}

// ─── Provider detection ────────────────────────────────────────────────────────

/**
 * Returns list of provider names (lowercase) where a key is available.
 * Checks both env vars and config file. Deduplicates.
 */
export function detectAvailableProviders(): string[] {
  const providers = new Set<string>();

  // Check environment variables
  if (process.env['ANTHROPIC_API_KEY']) providers.add('anthropic');
  if (process.env['OPENAI_API_KEY']) providers.add('openai');
  if (process.env['GOOGLE_API_KEY']) providers.add('google');
  if (process.env['GEMINI_API_KEY']) providers.add('google');  // alias
  if (process.env['GROQ_API_KEY']) providers.add('groq');
  if (process.env['OPENROUTER_API_KEY']) providers.add('openrouter');

  // Check config file
  try {
    const providerConfigs = getProviderConfigs();
    for (const [providerName, config] of Object.entries(providerConfigs)) {
      if (config.accounts && config.accounts.length > 0 && config.accounts[0]?.apiKey) {
        providers.add(providerName.toLowerCase());
      }
    }
  } catch {
    // Config may not exist — that's fine
  }

  return [...providers].sort();
}

// ─── Suggestion engine ────────────────────────────────────────────────────────

/**
 * Returns first candidate model whose provider prefix is in availableProviders.
 * Returns null if none are available.
 */
function bestAvailable(candidates: string[], providers: string[]): string | null {
  for (const candidate of candidates) {
    const prefix = candidate.split('/')[0] ?? '';
    if (providers.includes(prefix)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Produce a policy suggestion for a single agent.
 */
function suggestForAgent(analysis: AgentAnalysis, availableProviders: string[]): PolicySuggestion {
  const { fingerprint, name: agentName, currentModel, taskDistribution, avgTotalTokens, costPerDay, requestsPerDay, avgInputTokens, avgOutputTokens } = analysis;

  let suggestedModel: string | null = null;
  let escalateTo: string | undefined;
  let escalateOn: Array<'complexity_high' | 'rate_limit' | 'error'> | undefined;
  let neverDowngrade = false;
  let reason = '';

  // RULE 1 — Long-context: avgTotalTokens > 50_000
  if (avgTotalTokens > 50_000) {
    suggestedModel = bestAvailable([
      'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4',
      'openai/gpt-4o',
    ], availableProviders);
    neverDowngrade = true;
    reason = `Long-context patterns (avg ${Math.round(avgTotalTokens / 1000)}K tokens) — keep on full-context model`;
  }

  // RULE 2 — Security/review: review + security >= 0.8
  else if ((taskDistribution['review'] ?? 0) + (taskDistribution['security'] ?? 0) >= 0.8) {
    const pct = Math.round(((taskDistribution['review'] ?? 0) + (taskDistribution['security'] ?? 0)) * 100);
    suggestedModel = bestAvailable([
      'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4',
    ], availableProviders) ?? currentModel;
    neverDowngrade = true;
    reason = `High review/security share (${pct}%) — never downgrade for accuracy`;
  }

  // RULE 3 — Code-heavy: code >= 0.8
  else if ((taskDistribution['code'] ?? 0) >= 0.8) {
    const pct = Math.round((taskDistribution['code'] ?? 0) * 100);
    suggestedModel = bestAvailable([
      'anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4', 'openai/gpt-4o',
    ], availableProviders);
    escalateTo = bestAvailable([
      'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4',
    ], availableProviders) ?? undefined;
    escalateOn = ['complexity_high'];
    neverDowngrade = false;
    reason = `Code-heavy (${pct}%) — sonnet for speed, escalate to opus on complexity`;
  }

  // RULE 4 — Summarization: summarization >= 0.8
  else if ((taskDistribution['summarization'] ?? 0) >= 0.8) {
    const pct = Math.round((taskDistribution['summarization'] ?? 0) * 100);
    suggestedModel = bestAvailable([
      'google/gemini-2.0-flash', 'google/gemini-1.5-flash',
      'anthropic/claude-haiku-4-5', 'openai/gpt-4o-mini',
    ], availableProviders);
    neverDowngrade = false;
    reason = `Summarization-heavy (${pct}%) — fast/cheap model`;
  }

  // RULE 5 — Simple/utility: (simple + utility) >= 0.8 AND avgTotalTokens < 5_000
  else if (
    ((taskDistribution['simple'] ?? 0) + (taskDistribution['utility'] ?? 0)) >= 0.8 &&
    avgTotalTokens < 5_000
  ) {
    const pct = Math.round(((taskDistribution['simple'] ?? 0) + (taskDistribution['utility'] ?? 0)) * 100);
    suggestedModel = bestAvailable([
      'groq/llama-3.1-8b-instant', 'groq/llama-3.3-70b',
      'google/gemini-2.0-flash', 'anthropic/claude-haiku-4-5', 'openai/gpt-4o-mini',
    ], availableProviders);
    neverDowngrade = false;
    reason = `Simple tasks with low token volume (avg ${Math.round(avgTotalTokens)} tokens) — cheapest capable model`;
  }

  // DEFAULT — no dominant pattern
  else {
    suggestedModel = bestAvailable([
      'anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-2.0-flash',
    ], availableProviders);
    neverDowngrade = false;
    reason = 'Mixed patterns — balanced capability model';
  }

  // Post-rule: handle null or same model
  let noSuggestion: boolean | undefined;
  let noSuggestionReason: string | undefined;

  if (suggestedModel === null) {
    noSuggestion = true;
    noSuggestionReason = "No available provider for this agent's task profile";
    suggestedModel = currentModel;
  } else if (suggestedModel === currentModel) {
    noSuggestion = true;
    noSuggestionReason = 'Already on the recommended model';
  }

  // Compute savings
  const projectedDailyCost = estimateDailyCost(avgInputTokens, avgOutputTokens, requestsPerDay, suggestedModel);
  const estimatedDailySavings = Math.max(0, costPerDay - projectedDailyCost);
  const estimatedMonthlySavings = estimatedDailySavings * 30;

  const result: PolicySuggestion = {
    fingerprint,
    agentName,
    currentModel,
    suggestedModel,
    neverDowngrade,
    reason,
    estimatedDailySavings,
    estimatedMonthlySavings,
  };

  if (escalateTo) result.escalateTo = escalateTo;
  if (escalateOn) result.escalateOn = escalateOn;
  if (noSuggestion !== undefined) result.noSuggestion = noSuggestion;
  if (noSuggestionReason !== undefined) result.noSuggestionReason = noSuggestionReason;

  return result;
}

/**
 * Produce suggestions for all agents.
 */
export function suggestPolicies(analyses: AgentAnalysis[], availableProviders: string[]): PolicySuggestion[] {
  return analyses.map(a => suggestForAgent(a, availableProviders));
}
