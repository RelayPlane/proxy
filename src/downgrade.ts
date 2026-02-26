/**
 * RelayPlane Auto-Downgrade
 *
 * When budget threshold hit (configurable, default 80%), rewrites model
 * to a cheaper alternative. Adds X-RelayPlane headers to indicate downgrade.
 *
 * @packageDocumentation
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface DowngradeConfig {
  enabled: boolean;
  /** Budget percentage threshold to trigger downgrade (default: 80) */
  thresholdPercent: number;
  /** Model mapping: expensive → cheaper */
  mapping: Record<string, string>;
}

export interface DowngradeResult {
  downgraded: boolean;
  originalModel: string;
  newModel: string;
  reason: string;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_DOWNGRADE_MAPPING: Record<string, string> = {
  // Anthropic
  'claude-opus-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-20250514': 'claude-sonnet-4-20250514',
  'claude-opus-4-latest': 'claude-sonnet-4-latest',
  'claude-3-opus-20240229': 'claude-3-5-sonnet-20241022',
  'claude-sonnet-4-6': 'claude-3-5-haiku-20241022',
  'claude-sonnet-4-20250514': 'claude-3-5-haiku-20241022',
  'claude-sonnet-4-latest': 'claude-3-5-haiku-latest',
  'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20240620': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-haiku-latest',
  // OpenAI
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4o-mini',
  'gpt-4': 'gpt-4o-mini',
  'o1': 'o3-mini',
  // Google
  'gemini-2.5-pro': 'gemini-2.0-flash',
  'gemini-1.5-pro': 'gemini-1.5-flash',
};

export const DEFAULT_DOWNGRADE_CONFIG: DowngradeConfig = {
  enabled: false,
  thresholdPercent: 80,
  mapping: { ...DEFAULT_DOWNGRADE_MAPPING },
};

// ─── Downgrade Logic ────────────────────────────────────────────────

/**
 * Check if a model should be downgraded given current budget state.
 *
 * @param model - The requested model
 * @param budgetPercent - Current budget utilization as a percentage (0-100+)
 * @param config - Downgrade configuration
 * @returns DowngradeResult indicating if/how the model was changed
 */
export function checkDowngrade(
  model: string,
  budgetPercent: number,
  config: DowngradeConfig = DEFAULT_DOWNGRADE_CONFIG,
): DowngradeResult {
  if (!config.enabled) {
    return { downgraded: false, originalModel: model, newModel: model, reason: '' };
  }

  if (budgetPercent < config.thresholdPercent) {
    return { downgraded: false, originalModel: model, newModel: model, reason: '' };
  }

  const cheaper = config.mapping[model];
  if (!cheaper) {
    // No mapping — can't downgrade this model
    return { downgraded: false, originalModel: model, newModel: model, reason: 'no mapping available' };
  }

  return {
    downgraded: true,
    originalModel: model,
    newModel: cheaper,
    reason: `budget at ${budgetPercent.toFixed(1)}% (threshold: ${config.thresholdPercent}%)`,
  };
}

/**
 * Apply downgrade headers to response headers map.
 */
export function applyDowngradeHeaders(
  headers: Record<string, string>,
  result: DowngradeResult,
): void {
  if (result.downgraded) {
    headers['X-RelayPlane-Downgraded'] = 'true';
    headers['X-RelayPlane-Downgrade-Reason'] = result.reason;
    headers['X-RelayPlane-Original-Model'] = result.originalModel;
  }
}
