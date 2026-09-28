/**
 * Same-Provider Model-Tier Fallback
 *
 * Incident 2026-09-28: claude-sonnet-5-5 and claude-opus-5-5 returned
 * 429 rate_limit_error on every pool account (both real Anthropic OAuth
 * accounts, verified with direct calls bypassing the proxy) while
 * claude-haiku-4-5 kept succeeding and the accounts' own weekly/session
 * unified rate-limit headers showed 20-30% utilization ("allowed" on every
 * axis). That rules out a per-account/weekly cap: Anthropic was rejecting
 * specific model tiers at the API/capacity layer, not the org's quota.
 *
 * The credential pool already fails a request over to the OTHER account for
 * the SAME model, and crossProviderCascade already fails a request over to a
 * DIFFERENT provider for a similar-tier model. Neither covers the gap this
 * incident exposed: the top-tier model itself unavailable on every account,
 * on the provider real traffic is already authenticated against. This module
 * steps the model DOWN a tier on the same provider (same billing, same auth)
 * before cross-provider cascade is even attempted, so real traffic degrades
 * gracefully instead of hard-failing while a model launch/capacity event is
 * in progress upstream.
 *
 * Config example (~/.relayplane/config.json):
 * ```json
 * {
 *   "tierFallback": {
 *     "enabled": true,
 *     "triggerStatuses": [429, 503, 529],
 *     "maxHops": 3
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

/** Statuses that indicate the requested tier itself is unavailable upstream. */
export const DEFAULT_TIER_FALLBACK_TRIGGER_STATUSES = [429, 503, 529];

/**
 * Built-in same-provider (Anthropic) tier step-down map. Each entry points to
 * the next cheaper/more-available tier to try when the key model is
 * unavailable. Chains: sonnet-5-5 -> sonnet-5 -> haiku-4-5; opus-5-5 ->
 * opus-5 -> sonnet-5 -> haiku-4-5.
 */
export const DEFAULT_TIER_FALLBACK_MAP: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5',
  'claude-opus-5': 'claude-sonnet-5',
  'claude-sonnet-5-5': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-haiku-4-5-20251001',
};

export interface TierFallbackConfig {
  enabled: boolean;
  /** model -> next-tier-down model */
  mapping: Record<string, string>;
  /** Upstream HTTP statuses that trigger a tier step-down attempt. */
  triggerStatuses: number[];
  /** Max number of fallback hops to attempt (excludes the original model). */
  maxHops: number;
}

export const DEFAULT_TIER_FALLBACK_CONFIG: TierFallbackConfig = {
  enabled: true,
  mapping: { ...DEFAULT_TIER_FALLBACK_MAP },
  triggerStatuses: [...DEFAULT_TIER_FALLBACK_TRIGGER_STATUSES],
  maxHops: 3,
};

/** Merge a partial user config over the built-in defaults. */
export function resolveTierFallbackConfig(
  partial?: Partial<TierFallbackConfig>,
): TierFallbackConfig {
  if (!partial) return { ...DEFAULT_TIER_FALLBACK_CONFIG, mapping: { ...DEFAULT_TIER_FALLBACK_MAP } };
  return {
    enabled: partial.enabled ?? DEFAULT_TIER_FALLBACK_CONFIG.enabled,
    mapping: { ...DEFAULT_TIER_FALLBACK_MAP, ...(partial.mapping ?? {}) },
    triggerStatuses: partial.triggerStatuses ?? [...DEFAULT_TIER_FALLBACK_TRIGGER_STATUSES],
    maxHops: partial.maxHops ?? DEFAULT_TIER_FALLBACK_CONFIG.maxHops,
  };
}

/** True when this upstream status means "the requested tier is unavailable, try a lower one." */
export function shouldTierFallback(status: number, config: TierFallbackConfig = DEFAULT_TIER_FALLBACK_CONFIG): boolean {
  if (!config.enabled) return false;
  return config.triggerStatuses.includes(status);
}

/**
 * Build the ordered chain of fallback models to attempt for `model`,
 * excluding `model` itself. Stops at `maxHops`, and guards against cycles in
 * a misconfigured mapping (never revisits a model already in the chain).
 */
export function buildTierFallbackChain(
  model: string,
  config: TierFallbackConfig = DEFAULT_TIER_FALLBACK_CONFIG,
): string[] {
  if (!config.enabled) return [];
  const chain: string[] = [];
  const visited = new Set<string>([model]);
  let current = model;
  while (chain.length < config.maxHops) {
    const next = config.mapping[current];
    if (!next || visited.has(next)) break;
    chain.push(next);
    visited.add(next);
    current = next;
  }
  return chain;
}
