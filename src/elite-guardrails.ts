export const ELITE_TOKEN_WARNING_THRESHOLD = 10000;

export interface EliteGuardrailsConfig {
  enabled: boolean;
  perSessionCalls: number;
  perDayUsd: number;
}

export const DEFAULT_ELITE_GUARDRAILS: EliteGuardrailsConfig = {
  enabled: false,
  perSessionCalls: 3,
  perDayUsd: 5,
};

type Tier = 'elite' | 'complex' | 'moderate' | 'simple';

export interface RouteDecision {
  tier: Tier;
  downgraded: boolean;
  reason?: string;
  warning?: string;
}

export interface CheckRouteParams {
  sessionId: string;
  proposedTier: Tier;
  estimatedTokens: number;
}

export interface RecordCallParams {
  sessionId: string;
  costUsd: number;
}

export class EliteGuardrails {
  private config: EliteGuardrailsConfig;
  private sessionCalls = new Map<string, number>();
  private dailySpendUsd = 0;

  constructor(config: EliteGuardrailsConfig) {
    this.config = config;
  }

  getSessionCount(sessionId: string): number {
    return this.sessionCalls.get(sessionId) ?? 0;
  }

  getDailySpend(): number {
    return this.dailySpendUsd;
  }

  resetDailySpend(): void {
    this.dailySpendUsd = 0;
  }

  clearSession(sessionId: string): void {
    this.sessionCalls.delete(sessionId);
  }

  recordEliteCall(params: RecordCallParams): void {
    const count = this.sessionCalls.get(params.sessionId) ?? 0;
    this.sessionCalls.set(params.sessionId, count + 1);
    this.dailySpendUsd += params.costUsd;
  }

  checkRoute(params: CheckRouteParams): RouteDecision {
    const { sessionId, proposedTier, estimatedTokens } = params;

    if (!this.config.enabled || proposedTier !== 'elite') {
      return { tier: proposedTier, downgraded: false };
    }

    const sessionCount = this.sessionCalls.get(sessionId) ?? 0;
    if (sessionCount >= this.config.perSessionCalls) {
      return { tier: 'complex', downgraded: true, reason: 'per_session_cap' };
    }

    if (this.dailySpendUsd >= this.config.perDayUsd) {
      return { tier: 'complex', downgraded: true, reason: 'per_day_cap' };
    }

    const warning =
      estimatedTokens > ELITE_TOKEN_WARNING_THRESHOLD
        ? `High token count (${estimatedTokens}): this elite call may be expensive`
        : undefined;

    return { tier: 'elite', downgraded: false, warning };
  }
}

export function parseEliteGuardrailsConfig(config: Record<string, unknown>): EliteGuardrailsConfig {
  const routing = (config.routing ?? {}) as Record<string, unknown>;
  const enabled = routing.allow_elite_auto === true;
  const section = (routing.elite_guardrails ?? {}) as Record<string, unknown>;
  return {
    enabled,
    perSessionCalls:
      typeof section.per_session_calls === 'number'
        ? section.per_session_calls
        : DEFAULT_ELITE_GUARDRAILS.perSessionCalls,
    perDayUsd:
      typeof section.per_day_usd === 'number'
        ? section.per_day_usd
        : DEFAULT_ELITE_GUARDRAILS.perDayUsd,
  };
}
