/**
 * Adaptive Provider Recovery — Phase 1: Local Recovery
 *
 * Detects provider errors, applies recovery strategies with exponential backoff,
 * extracts recovery patterns from successful retries, and applies them preemptively.
 *
 * @packageDocumentation
 */

import { type Logger, defaultLogger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Categories of recovery patterns the system can detect and apply */
export type RecoveryPatternType =
  | 'auth-header'      // e.g., oat token needs x-api-key not Bearer
  | 'model-rename'     // e.g., claude-3-opus → claude-opus-4
  | 'timeout-tune'     // e.g., long prompts need 120s
  | 'provider-fallback'; // route to alternative provider

/** Context captured when a provider request fails */
export interface FailureContext {
  provider: string;
  model: string;
  authMethod: string;         // 'bearer' | 'x-api-key'
  errorCode: number;          // HTTP status code
  errorMessage: string;
  errorType: string;          // parsed error type/code from provider
  tokenPrefix?: string;       // e.g., 'sk-ant-oat', 'sk-ant-api'
  timestamp: number;
  requestHeaders: Record<string, string>;  // sanitized — no values, just names
  estimatedTokens?: number;
  timeoutMs?: number;
}

/** A discovered recovery pattern */
export interface RecoveryPattern {
  id: string;
  type: RecoveryPatternType;
  provider: string;
  trigger: {
    errorCode: number;
    errorType?: string;
    tokenPrefix?: string;
    model?: string;
    minTokens?: number;
  };
  fix: {
    authHeader?: string;       // Switch to this auth header
    model?: string;            // Use this model name instead
    timeoutMs?: number;        // Use this timeout
    provider?: string;         // Fallback to this provider
  };
  confidence: number;          // 0-1, based on success rate
  successCount: number;
  failureCount: number;
  firstSeen: string;           // ISO timestamp
  lastSeen: string;
  lastApplied?: string;
}

/** Result of a recovery attempt */
export interface RecoveryResult {
  recovered: boolean;
  strategy: string;
  pattern?: RecoveryPattern;
  response?: ProviderResponse;
  attempts: number;
  totalLatencyMs: number;
}

/** Provider response shape (simplified) */
export interface ProviderResponse {
  success: boolean;
  status?: number;
  data?: unknown;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  ttft_ms?: number;
  error?: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    raw?: unknown;
  };
}

/** A recovery event logged for observability */
export interface RecoveryEvent {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  originalError: { code: number; type: string; message: string };
  strategy: string;
  recovered: boolean;
  attempts: number;
  latencyMs: number;
  patternId?: string;
  delta?: Record<string, unknown>;
}

/** Function that forwards a request to a provider */
export type ForwardFn = (
  provider: string,
  request: Record<string, unknown>,
  config: { apiKey: string; baseUrl?: string },
  runId: string,
  overrides?: RequestOverrides
) => Promise<ProviderResponse>;

/** Overrides that recovery strategies can apply to a request */
export interface RequestOverrides {
  authHeader?: string;        // 'x-api-key' | 'Authorization'
  model?: string;
  timeoutMs?: number;
}

export interface RecoveryConfig {
  /** Enable/disable recovery (default: true) */
  enabled?: boolean;
  /** Maximum retry attempts per failure (default: 2) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 500) */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 5000) */
  maxDelayMs?: number;
  /** Minimum confidence for preemptive pattern application (default: 0.8) */
  minPreemptiveConfidence?: number;
  /** Maximum stored patterns (default: 100) */
  maxPatterns?: number;
  /** Pattern expiry in days (default: 30) */
  patternExpiryDays?: number;
  /** Logger */
  logger?: Logger;
}

// ─── Recovery Pattern Store ───────────────────────────────────────────────────

/**
 * In-memory store for recovery patterns.
 * Phase 1 uses in-memory; Phase 2 could use SQLite.
 */
export class RecoveryPatternStore {
  private patterns: Map<string, RecoveryPattern> = new Map();
  private readonly maxPatterns: number;
  private readonly expiryDays: number;

  constructor(maxPatterns = 100, expiryDays = 30) {
    this.maxPatterns = maxPatterns;
    this.expiryDays = expiryDays;
  }

  /** Get all patterns */
  getAll(): RecoveryPattern[] {
    this.pruneExpired();
    return Array.from(this.patterns.values());
  }

  /** Find patterns matching a failure context */
  findMatching(ctx: FailureContext): RecoveryPattern[] {
    this.pruneExpired();
    return Array.from(this.patterns.values()).filter((p) => {
      if (p.provider !== ctx.provider) return false;
      if (p.trigger.errorCode !== ctx.errorCode) return false;
      if (p.trigger.tokenPrefix && ctx.tokenPrefix && !ctx.tokenPrefix.startsWith(p.trigger.tokenPrefix)) return false;
      if (p.trigger.model && p.trigger.model !== ctx.model) return false;
      if (p.trigger.errorType && p.trigger.errorType !== ctx.errorType) return false;
      if (p.trigger.minTokens && (ctx.estimatedTokens ?? 0) < p.trigger.minTokens) return false;
      return true;
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /** Find preemptive patterns for a request (before any failure) */
  findPreemptive(provider: string, model: string, tokenPrefix?: string): RecoveryPattern[] {
    this.pruneExpired();
    return Array.from(this.patterns.values()).filter((p) => {
      if (p.provider !== provider) return false;
      if (p.confidence < 0.8) return false;  // Only high-confidence patterns
      if (p.trigger.tokenPrefix && tokenPrefix && !tokenPrefix.startsWith(p.trigger.tokenPrefix)) return false;
      if (p.trigger.model && p.trigger.model !== model) return false;
      return true;
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /** Store or update a pattern */
  upsert(pattern: RecoveryPattern): void {
    const existing = this.patterns.get(pattern.id);
    if (existing) {
      existing.successCount += pattern.successCount;
      existing.failureCount += pattern.failureCount;
      existing.confidence = existing.successCount / (existing.successCount + existing.failureCount);
      existing.lastSeen = pattern.lastSeen;
      if (pattern.lastApplied) existing.lastApplied = pattern.lastApplied;
    } else {
      if (this.patterns.size >= this.maxPatterns) {
        // Evict lowest-confidence pattern
        let lowestKey = '';
        let lowestConf = Infinity;
        for (const [key, p] of this.patterns) {
          if (p.confidence < lowestConf) {
            lowestConf = p.confidence;
            lowestKey = key;
          }
        }
        if (lowestKey) this.patterns.delete(lowestKey);
      }
      this.patterns.set(pattern.id, pattern);
    }
  }

  /** Record a successful application of a pattern */
  recordSuccess(patternId: string): void {
    const p = this.patterns.get(patternId);
    if (p) {
      p.successCount++;
      p.confidence = p.successCount / (p.successCount + p.failureCount);
      p.lastApplied = new Date().toISOString();
    }
  }

  /** Record a failed application of a pattern */
  recordFailure(patternId: string): void {
    const p = this.patterns.get(patternId);
    if (p) {
      p.failureCount++;
      p.confidence = p.successCount / (p.successCount + p.failureCount);
    }
  }

  /** Get store stats */
  stats(): { total: number; highConfidence: number; avgConfidence: number } {
    const all = Array.from(this.patterns.values());
    return {
      total: all.length,
      highConfidence: all.filter((p) => p.confidence >= 0.8).length,
      avgConfidence: all.length > 0
        ? all.reduce((sum, p) => sum + p.confidence, 0) / all.length
        : 0,
    };
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.expiryDays * 24 * 60 * 60 * 1000;
    for (const [key, p] of this.patterns) {
      if (new Date(p.lastSeen).getTime() < cutoff) {
        this.patterns.delete(key);
      }
    }
  }
}

// ─── Failure Observer ─────────────────────────────────────────────────────────

/**
 * Observes provider failures and determines if they are recovery-eligible.
 */
export class FailureObserver {
  private readonly logger: Logger;
  private readonly events: RecoveryEvent[] = [];
  private readonly maxEvents = 500;

  constructor(logger?: Logger) {
    this.logger = logger ?? defaultLogger;
  }

  /** Determine if a failure is eligible for recovery attempt */
  isRecoverable(response: ProviderResponse): boolean {
    if (!response.error) return false;
    const status = response.error.status;
    // 4xx (except 400 bad request for malformed bodies)
    // 5xx (server errors, potentially transient)
    // 429 (rate limit — might work with backoff)
    if (status === 400) return false; // Malformed request, retry won't help
    if (status === 401 || status === 403) return true; // Auth issues — can try different header
    if (status === 404) return true; // Model not found — can try alias
    if (status === 429) return true; // Rate limit
    if (status >= 500) return true;  // Server errors
    return false;
  }

  /** Build failure context from a failed request */
  buildContext(
    provider: string,
    model: string,
    request: Record<string, unknown>,
    config: { apiKey: string; baseUrl?: string },
    response: ProviderResponse,
    overrides?: RequestOverrides
  ): FailureContext {
    const apiKey = config.apiKey ?? '';
    const tokenPrefix = apiKey.slice(0, 10); // e.g., 'sk-ant-oat'

    // Determine auth method used
    let authMethod = 'bearer';
    if (provider === 'anthropic') authMethod = 'x-api-key';
    if (overrides?.authHeader === 'Authorization') authMethod = 'bearer';
    if (overrides?.authHeader === 'x-api-key') authMethod = 'x-api-key';

    // Sanitize headers (names only, no values)
    const requestHeaders: Record<string, string> = {};
    if (overrides?.authHeader) requestHeaders['auth'] = overrides.authHeader;

    // Estimate tokens
    const messages = request['messages'] as Array<{ content?: string }> | undefined;
    const estimatedTokens = messages
      ? messages.reduce((sum, m) => sum + ((m.content?.length ?? 0) / 4), 0)
      : undefined;

    return {
      provider,
      model,
      authMethod,
      errorCode: response.error?.status ?? 0,
      errorMessage: response.error?.message ?? 'Unknown error',
      errorType: response.error?.code ?? 'unknown',
      tokenPrefix,
      timestamp: Date.now(),
      requestHeaders,
      estimatedTokens: estimatedTokens ? Math.round(estimatedTokens) : undefined,
      timeoutMs: overrides?.timeoutMs,
    };
  }

  /** Log a recovery event */
  logEvent(event: RecoveryEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (event.recovered) {
      this.logger.info(
        `Recovery: ${event.provider}/${event.model} recovered via ${event.strategy} ` +
        `(${event.attempts} attempts, ${event.latencyMs}ms)`
      );
    } else {
      this.logger.warn(
        `Recovery: ${event.provider}/${event.model} failed all strategies ` +
        `(${event.attempts} attempts, ${event.latencyMs}ms)`
      );
    }
  }

  /** Get recent recovery events */
  getRecentEvents(limit = 20): RecoveryEvent[] {
    return this.events.slice(-limit);
  }

  /** Get recovery stats */
  getStats(): { total: number; recovered: number; failed: number; recoveryRate: number } {
    const total = this.events.length;
    const recovered = this.events.filter((e) => e.recovered).length;
    return {
      total,
      recovered,
      failed: total - recovered,
      recoveryRate: total > 0 ? recovered / total : 0,
    };
  }
}

// ─── Recovery Strategies ──────────────────────────────────────────────────────

interface RecoveryStrategy {
  name: string;
  /** Check if this strategy applies to the failure */
  applies(ctx: FailureContext): boolean;
  /** Generate overrides to try */
  getOverrides(ctx: FailureContext): RequestOverrides;
  /** Extract a pattern from a successful recovery */
  extractPattern(ctx: FailureContext, overrides: RequestOverrides): RecoveryPattern;
}

/** Strategy: rotate auth header (Bearer ↔ x-api-key) */
const authRotationStrategy: RecoveryStrategy = {
  name: 'auth-rotation',
  applies(ctx) {
    return (ctx.errorCode === 401 || ctx.errorCode === 403) && ctx.provider === 'anthropic';
  },
  getOverrides(ctx) {
    // If currently using x-api-key, try Bearer, and vice versa
    const newHeader = ctx.authMethod === 'x-api-key' ? 'Authorization' : 'x-api-key';
    return { authHeader: newHeader };
  },
  extractPattern(ctx, overrides) {
    const id = `auth-header:${ctx.provider}:${ctx.tokenPrefix ?? 'unknown'}`;
    return {
      id,
      type: 'auth-header',
      provider: ctx.provider,
      trigger: {
        errorCode: ctx.errorCode,
        errorType: ctx.errorType,
        tokenPrefix: ctx.tokenPrefix,
      },
      fix: { authHeader: overrides.authHeader },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  },
};

/** Known model aliases for fuzzy matching */
const MODEL_ALIASES: Record<string, string[]> = {
  'claude-3-opus': ['claude-3-opus-20240229', 'claude-opus-4'],
  'claude-3-sonnet': ['claude-3-sonnet-20240229', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4'],
  'claude-3-haiku': ['claude-3-haiku-20240307', 'claude-3-5-haiku-20241022'],
  'claude-opus-4': ['claude-3-opus', 'claude-3-opus-20240229'],
  'claude-sonnet-4': ['claude-3-5-sonnet-20241022', 'claude-3-sonnet'],
  'gpt-4': ['gpt-4-0613', 'gpt-4-turbo'],
  'gpt-4-turbo': ['gpt-4-turbo-2024-04-09', 'gpt-4'],
  'gpt-4o': ['gpt-4o-2024-08-06', 'gpt-4o-2024-05-13'],
};

/** Strategy: try model name aliases */
const modelRenameStrategy: RecoveryStrategy = {
  name: 'model-rename',
  applies(ctx) {
    return ctx.errorCode === 404 && ctx.errorType.includes('not_found');
  },
  getOverrides(ctx) {
    // Find an alias for the current model
    const aliases = MODEL_ALIASES[ctx.model] ?? [];
    // Try the first alias we haven't tried yet
    const altModel = aliases[0];
    return altModel ? { model: altModel } : {};
  },
  extractPattern(ctx, overrides) {
    const id = `model-rename:${ctx.provider}:${ctx.model}`;
    return {
      id,
      type: 'model-rename',
      provider: ctx.provider,
      trigger: {
        errorCode: ctx.errorCode,
        errorType: ctx.errorType,
        model: ctx.model,
      },
      fix: { model: overrides.model },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  },
};

/** Strategy: extend timeout for long prompts */
const timeoutExtensionStrategy: RecoveryStrategy = {
  name: 'timeout-extension',
  applies(ctx) {
    return (
      ctx.errorType === 'timeout' ||
      ctx.errorMessage.toLowerCase().includes('timeout') ||
      ctx.errorMessage.toLowerCase().includes('timed out')
    );
  },
  getOverrides(ctx) {
    const currentTimeout = ctx.timeoutMs ?? 30000;
    return { timeoutMs: Math.min(currentTimeout * 2, 120000) };
  },
  extractPattern(ctx, overrides) {
    const id = `timeout-tune:${ctx.provider}:${ctx.estimatedTokens ? 'long' : 'default'}`;
    return {
      id,
      type: 'timeout-tune',
      provider: ctx.provider,
      trigger: {
        errorCode: ctx.errorCode,
        errorType: 'timeout',
        minTokens: ctx.estimatedTokens ? Math.round(ctx.estimatedTokens * 0.8) : undefined,
      },
      fix: { timeoutMs: overrides.timeoutMs },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  },
};

/** All recovery strategies in priority order */
const RECOVERY_STRATEGIES: RecoveryStrategy[] = [
  authRotationStrategy,
  modelRenameStrategy,
  timeoutExtensionStrategy,
];

// ─── Pattern Applicator ───────────────────────────────────────────────────────

/**
 * Applies stored recovery patterns preemptively before forwarding requests.
 */
export class PatternApplicator {
  private readonly store: RecoveryPatternStore;
  private readonly minConfidence: number;
  private readonly logger: Logger;
  private preemptiveHits = 0;
  private preemptiveMisses = 0;

  constructor(store: RecoveryPatternStore, minConfidence = 0.8, logger?: Logger) {
    this.store = store;
    this.minConfidence = minConfidence;
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Check for preemptive patterns and return overrides to apply.
   * Called before forwarding a request.
   */
  getPreemptiveOverrides(
    provider: string,
    model: string,
    apiKey?: string
  ): RequestOverrides | null {
    const tokenPrefix = apiKey?.slice(0, 10);
    const patterns = this.store.findPreemptive(provider, model, tokenPrefix);

    if (patterns.length === 0) return null;

    // Apply the highest-confidence pattern
    const best = patterns[0];
    if (best.confidence < this.minConfidence) return null;

    this.preemptiveHits++;
    this.logger.info(
      `Preemptive recovery: applying pattern ${best.id} (${best.type}, ` +
      `confidence: ${(best.confidence * 100).toFixed(0)}%)`
    );

    return best.fix as RequestOverrides;
  }

  /** Record that a preemptive application worked */
  recordPreemptiveSuccess(provider: string, model: string): void {
    const patterns = this.store.findPreemptive(provider, model);
    if (patterns.length > 0) {
      this.store.recordSuccess(patterns[0].id);
    }
  }

  /** Record that a preemptive application failed */
  recordPreemptiveFailure(provider: string, model: string): void {
    this.preemptiveMisses++;
    const patterns = this.store.findPreemptive(provider, model);
    if (patterns.length > 0) {
      this.store.recordFailure(patterns[0].id);
    }
  }

  /** Get preemptive application stats */
  getStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.preemptiveHits + this.preemptiveMisses;
    return {
      hits: this.preemptiveHits,
      misses: this.preemptiveMisses,
      hitRate: total > 0 ? this.preemptiveHits / total : 0,
    };
  }
}

// ─── Recovery Engine ──────────────────────────────────────────────────────────

/**
 * Main recovery engine that orchestrates failure observation,
 * recovery strategies, pattern extraction, and preemptive application.
 */
export class RecoveryEngine {
  readonly observer: FailureObserver;
  readonly store: RecoveryPatternStore;
  readonly applicator: PatternApplicator;

  private readonly config: Required<RecoveryConfig>;
  private readonly logger: Logger;

  constructor(config?: RecoveryConfig) {
    this.logger = config?.logger ?? defaultLogger;
    this.config = {
      enabled: config?.enabled ?? true,
      maxRetries: config?.maxRetries ?? 2,
      baseDelayMs: config?.baseDelayMs ?? 500,
      maxDelayMs: config?.maxDelayMs ?? 5000,
      minPreemptiveConfidence: config?.minPreemptiveConfidence ?? 0.8,
      maxPatterns: config?.maxPatterns ?? 100,
      patternExpiryDays: config?.patternExpiryDays ?? 30,
      logger: this.logger,
    };

    this.observer = new FailureObserver(this.logger);
    this.store = new RecoveryPatternStore(this.config.maxPatterns, this.config.patternExpiryDays);
    this.applicator = new PatternApplicator(
      this.store,
      this.config.minPreemptiveConfidence,
      this.logger
    );
  }

  /** Check if recovery is enabled */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get preemptive overrides to apply before forwarding.
   * Called by the request pipeline before forwardToProvider.
   */
  getPreemptiveOverrides(
    provider: string,
    model: string,
    apiKey?: string
  ): RequestOverrides | null {
    if (!this.config.enabled) return null;
    return this.applicator.getPreemptiveOverrides(provider, model, apiKey);
  }

  /**
   * Attempt to recover from a provider failure.
   * Tries applicable strategies with exponential backoff.
   *
   * @returns RecoveryResult with the outcome
   */
  async attemptRecovery(
    provider: string,
    model: string,
    request: Record<string, unknown>,
    providerConfig: { apiKey: string; baseUrl?: string },
    runId: string,
    failedResponse: ProviderResponse,
    forwardFn: ForwardFn
  ): Promise<RecoveryResult> {
    if (!this.config.enabled) {
      return { recovered: false, strategy: 'none', attempts: 0, totalLatencyMs: 0 };
    }

    // Check if this failure is recoverable
    if (!this.observer.isRecoverable(failedResponse)) {
      return { recovered: false, strategy: 'not-recoverable', attempts: 0, totalLatencyMs: 0 };
    }

    // Build failure context
    const ctx = this.observer.buildContext(
      provider, model, request, providerConfig, failedResponse
    );

    // First check if we have a stored pattern for this failure
    const matchingPatterns = this.store.findMatching(ctx);
    if (matchingPatterns.length > 0) {
      const pattern = matchingPatterns[0];
      const overrides = pattern.fix as RequestOverrides;
      const start = Date.now();

      try {
        const response = await forwardFn(provider, request, providerConfig, runId, overrides);
        if (response.success) {
          this.store.recordSuccess(pattern.id);
          this.logRecoveryEvent(ctx, 'stored-pattern', true, 1, Date.now() - start, pattern.id);
          return {
            recovered: true,
            strategy: `stored-pattern:${pattern.type}`,
            pattern,
            response,
            attempts: 1,
            totalLatencyMs: Date.now() - start,
          };
        }
        this.store.recordFailure(pattern.id);
      } catch {
        this.store.recordFailure(pattern.id);
      }
    }

    // Try recovery strategies
    const start = Date.now();
    let attempts = 0;

    for (const strategy of RECOVERY_STRATEGIES) {
      if (!strategy.applies(ctx)) continue;
      if (attempts >= this.config.maxRetries) break;

      const overrides = strategy.getOverrides(ctx);
      if (!overrides || Object.keys(overrides).length === 0) continue;

      // Exponential backoff
      const delay = Math.min(
        this.config.baseDelayMs * Math.pow(2, attempts),
        this.config.maxDelayMs
      );
      await sleep(delay);

      attempts++;

      try {
        const response = await forwardFn(provider, request, providerConfig, runId, overrides);

        if (response.success) {
          // Extract and store the recovery pattern
          const pattern = strategy.extractPattern(ctx, overrides);
          this.store.upsert(pattern);

          this.logRecoveryEvent(ctx, strategy.name, true, attempts, Date.now() - start, pattern.id, {
            originalAuthMethod: ctx.authMethod,
            ...overrides,
          });

          return {
            recovered: true,
            strategy: strategy.name,
            pattern,
            response,
            attempts,
            totalLatencyMs: Date.now() - start,
          };
        }
      } catch {
        // Strategy didn't work, try next
      }
    }

    // All strategies failed
    this.logRecoveryEvent(ctx, 'all-failed', false, attempts, Date.now() - start);

    return {
      recovered: false,
      strategy: 'all-failed',
      attempts,
      totalLatencyMs: Date.now() - start,
    };
  }

  /**
   * Get recovery dashboard data
   */
  getDashboardData(): {
    enabled: boolean;
    patterns: RecoveryPattern[];
    patternStats: { total: number; highConfidence: number; avgConfidence: number };
    recoveryStats: { total: number; recovered: number; failed: number; recoveryRate: number };
    preemptiveStats: { hits: number; misses: number; hitRate: number };
    recentEvents: RecoveryEvent[];
  } {
    return {
      enabled: this.config.enabled,
      patterns: this.store.getAll(),
      patternStats: this.store.stats(),
      recoveryStats: this.observer.getStats(),
      preemptiveStats: this.applicator.getStats(),
      recentEvents: this.observer.getRecentEvents(20),
    };
  }

  private logRecoveryEvent(
    ctx: FailureContext,
    strategy: string,
    recovered: boolean,
    attempts: number,
    latencyMs: number,
    patternId?: string,
    delta?: Record<string, unknown>
  ): void {
    const event: RecoveryEvent = {
      id: `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      provider: ctx.provider,
      model: ctx.model,
      originalError: {
        code: ctx.errorCode,
        type: ctx.errorType,
        message: ctx.errorMessage,
      },
      strategy,
      recovered,
      attempts,
      latencyMs,
      patternId,
      delta,
    };
    this.observer.logEvent(event);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
