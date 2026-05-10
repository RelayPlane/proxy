/**
 * Rate Limiter - In-memory rate limiting for RelayPlane Proxy
 *
 * Limits are configurable via ~/.relayplane/config.json under `rateLimit.models`.
 * When a limit is hit, requests are queued (up to maxQueueDepth) instead of
 * immediately returning 429. Queue overflow or timeout results in a 429.
 *
 * Defaults:
 * - Sonnet models: 60 RPM
 * - Opus models:   30 RPM
 * - Haiku models:  60 RPM
 * - Other models:  60 RPM
 *
 * Auto-expires old entries every 5 minutes.
 */

import type { RateLimitConfigSection, ProviderConfig } from './config.js';

// ── Sanitizers (defence against Infinity / NaN / negative values) ────────────

/** Maximum configurable RPM — prevents Infinity from bypassing the limiter. */
const MAX_RPM = 10_000;
/** Maximum configurable queue depth. */
const MAX_QUEUE_DEPTH = 10_000;
/** Maximum configurable queue timeout (10 minutes). */
const MAX_QUEUE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Clamp an RPM value to a safe finite integer in [1, MAX_RPM].
 * Returns the safe default (60) when the input is 0, negative, NaN, or Infinity.
 */
function sanitizeRpm(value: unknown, safeDefault = 60): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return safeDefault;
  return Math.min(MAX_RPM, Math.floor(num));
}

/**
 * Clamp a maxQueueDepth value to a safe finite integer in [0, MAX_QUEUE_DEPTH].
 */
function sanitizeQueueDepth(value: unknown, safeDefault = 50): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return safeDefault;
  return Math.min(MAX_QUEUE_DEPTH, Math.floor(num));
}

/**
 * Clamp a queueTimeoutMs value to a safe finite integer in [100, MAX_QUEUE_TIMEOUT_MS].
 */
function sanitizeTimeoutMs(value: unknown, safeDefault = 30_000): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 100) return safeDefault;
  return Math.min(MAX_QUEUE_TIMEOUT_MS, Math.floor(num));
}

export interface RateLimitConfig {
  rpm: number;
  maxTokens?: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  retryAfter?: number;
}

export class RateLimitError extends Error {
  readonly code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT';
  readonly retryAfter: number;
  readonly limit: number;
  readonly resetAt: number;

  constructor(
    message: string,
    opts: { code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT'; retryAfter: number; limit: number; resetAt: number }
  ) {
    super(message);
    this.name = 'RateLimitError';
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
    this.limit = opts.limit;
    this.resetAt = opts.resetAt;
  }
}

// Default limits. Sonnet bumped to 60 RPM, Opus bumped to 30 RPM (GH #39).
export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // Anthropic models
  'claude-opus-4-6': { rpm: 30, maxTokens: 4096 },
  'claude-opus': { rpm: 30, maxTokens: 4096 },
  'claude-sonnet-4-6': { rpm: 60 },
  'claude-haiku-4-5': { rpm: 60 },

  // OpenAI models
  'gpt-4o': { rpm: 30 },
  'gpt-4': { rpm: 20 },
  'o1': { rpm: 10, maxTokens: 4096 },
  'o3-mini': { rpm: 30 },

  // Default for unknown models
  'default': { rpm: 60 },
};

interface BucketEntry {
  count: number;
  resetAt: number;
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: RateLimitError) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  check: RateLimitCheck;
}

export class RateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private queues = new Map<string, QueueEntry[]>();
  private drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  private modelOverrides: Record<string, RateLimitConfig> = {};
  /**
   * Provider-level overrides. Key is provider name (e.g. "anthropic").
   * Applied when no model-specific override exists.
   * Set via config.json `providers.{name}.rateLimit.rpm`.
   */
  private providerOverrides: Record<string, RateLimitConfig> = {};
  private maxQueueDepth: number;
  private queueTimeoutMs: number;

  constructor(opts?: { maxQueueDepth?: number; queueTimeoutMs?: number }) {
    this.maxQueueDepth = opts?.maxQueueDepth ?? 50;
    this.queueTimeoutMs = opts?.queueTimeoutMs ?? 30_000;
  }

  /**
   * Apply configuration from ~/.relayplane/config.json rateLimit section.
   * Call once at proxy startup.
   */
  configure(cfg: RateLimitConfigSection): void {
    if (cfg.models) {
      for (const [model, modelCfg] of Object.entries(cfg.models)) {
        this.modelOverrides[model.toLowerCase()] = { rpm: sanitizeRpm(modelCfg.rpm) };
      }
    }
    if (cfg.maxQueueDepth !== undefined) {
      this.maxQueueDepth = sanitizeQueueDepth(cfg.maxQueueDepth);
    }
    if (cfg.queueTimeoutMs !== undefined) {
      this.queueTimeoutMs = sanitizeTimeoutMs(cfg.queueTimeoutMs);
    }
  }

  /**
   * Apply per-provider configuration from ~/.relayplane/config.json `providers` section.
   * Call once at proxy startup, after configure().
   *
   * Each provider's rateLimit.rpm becomes the fallback for ALL models from that provider
   * when no model-specific override exists.
   *
   * Example config.json:
   * ```json
   * { "providers": { "anthropic": { "rateLimit": { "rpm": 100 } } } }
   * ```
   */
  configureProviders(providers: Record<string, ProviderConfig>): void {
    for (const [provider, cfg] of Object.entries(providers)) {
      if (cfg.rateLimit?.rpm !== undefined) {
        this.providerOverrides[provider.toLowerCase()] = { rpm: sanitizeRpm(cfg.rateLimit.rpm) };
      }
    }
  }

  /**
   * Synchronous check — returns immediately without queuing.
   * Increments counter if allowed.
   *
   * @param provider  Optional provider name (e.g. "anthropic"). Used to look up
   *                  provider-level RPM limits when no model-specific override exists.
   *                  Limits are isolated per-provider — one provider hitting its cap
   *                  does NOT affect other providers.
   */
  checkLimit(workspaceId: string, model: string, provider?: string): RateLimitCheck {
    this.maybeCleanup();

    const config = this.getConfig(model, provider);
    const providerSeg = provider ? `:${provider.toLowerCase()}` : '';
    const key = `${workspaceId}${providerSeg}:${this.getModelKey(model)}:${this.getCurrentMinute()}`;

    const now = Date.now();
    const windowMs = 60 * 1000;
    const resetAt = this.getCurrentMinute() + windowMs;

    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { count: 0, resetAt };
      this.buckets.set(key, entry);
    }

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = resetAt;
    }

    const remaining = Math.max(0, config.rpm - entry.count);
    const allowed = entry.count < config.rpm;

    if (allowed) {
      entry.count++;
    }

    return {
      allowed,
      remaining,
      resetAt,
      limit: config.rpm,
      retryAfter: allowed ? undefined : Math.ceil((resetAt - now) / 1000),
    };
  }

  /**
   * Async slot acquisition with queuing.
   *
   * - Resolves immediately if a slot is available.
   * - Queues the request if the limit is hit (up to maxQueueDepth).
   * - Throws RateLimitError with code QUEUE_FULL if the queue is full.
   * - Throws RateLimitError with code QUEUE_TIMEOUT if the request waits too long.
   */
  async acquireSlot(workspaceId: string, model: string, provider?: string): Promise<void> {
    const check = this.checkLimit(workspaceId, model, provider);
    if (check.allowed) return;

    const providerSeg = provider ? `:${provider.toLowerCase()}` : '';
    const queueKey = `${workspaceId}${providerSeg}:${this.getModelKey(model)}`;
    if (!this.queues.has(queueKey)) {
      this.queues.set(queueKey, []);
    }
    const queue = this.queues.get(queueKey)!;

    if (queue.length >= this.maxQueueDepth) {
      throw new RateLimitError(
        `Rate limit queue full for ${model}. Max queue depth (${this.maxQueueDepth}) reached. ` +
          `Retry after ${check.retryAfter ?? 60}s.`,
        {
          code: 'QUEUE_FULL',
          retryAfter: check.retryAfter ?? 60,
          limit: check.limit,
          resetAt: check.resetAt,
        }
      );
    }

    // Schedule drain at window reset (only one timer per queue key)
    this.scheduleDrain(queueKey, workspaceId, model, check.resetAt, provider);

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = queue.indexOf(entry);
        if (idx >= 0) queue.splice(idx, 1);
        reject(
          new RateLimitError(
            `Rate limit queue timeout for ${model} after ${this.queueTimeoutMs}ms. ` +
              `Retry after ${entry.check.retryAfter ?? 60}s.`,
            {
              code: 'QUEUE_TIMEOUT',
              retryAfter: entry.check.retryAfter ?? 60,
              limit: entry.check.limit,
              resetAt: entry.check.resetAt,
            }
          )
        );
      }, this.queueTimeoutMs);

      const entry: QueueEntry = {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err: RateLimitError) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
        check,
      };
      queue.push(entry);
    });
  }

  private scheduleDrain(
    queueKey: string, workspaceId: string, model: string, resetAt: number, provider?: string,
    reSchedule = false,
  ): void {
    if (this.drainTimers.has(queueKey)) return; // already scheduled
    // Initial scheduling: use a minimum of 60 s so the drain never fires before
    // queueTimeoutMs when the runtime happens to be near a minute boundary.
    // Re-scheduling (from drainQueue): use the remaining window minus 1 ms so the
    // re-scheduled drain fires before any queued-entry timeout that fires at resetAt.
    const remaining = Math.max(0, resetAt - Date.now());
    const delay = reSchedule ? Math.max(1, remaining - 1) : Math.max(60_000, remaining);
    const timer = setTimeout(() => {
      this.drainTimers.delete(queueKey);
      this.drainQueue(queueKey, workspaceId, model, provider);
    }, delay);
    this.drainTimers.set(queueKey, timer);
  }

  private drainQueue(queueKey: string, workspaceId: string, model: string, provider?: string): void {
    const queue = this.queues.get(queueKey);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0) {
      const check = this.checkLimit(workspaceId, model, provider);
      if (!check.allowed) {
        // Window filled up — schedule next drain at next window reset
        this.scheduleDrain(queueKey, workspaceId, model, check.resetAt, provider, true);
        return;
      }
      const entry = queue.shift()!;
      entry.resolve();
    }
  }

  /**
   * Get current usage for a workspace/model
   */
  getUsage(workspaceId: string, model: string): { used: number; limit: number; resetAt: number } {
    const config = this.getConfig(model);
    const key = `${workspaceId}:${this.getModelKey(model)}:${this.getCurrentMinute()}`;
    const entry = this.buckets.get(key);

    return {
      used: entry?.count || 0,
      limit: config.rpm,
      resetAt: entry?.resetAt || this.getCurrentMinute() + 60 * 1000,
    };
  }

  /**
   * Reset limit for a specific workspace/model (emergency use)
   */
  resetLimit(workspaceId: string, model?: string): void {
    const prefix = model
      ? `${workspaceId}:${this.getModelKey(model)}:`
      : `${workspaceId}:`;

    for (const [key] of this.buckets) {
      if (key.startsWith(prefix)) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Get current queue depth for a workspace/model
   */
  getQueueDepth(workspaceId: string, model: string): number {
    const queueKey = `${workspaceId}:${this.getModelKey(model)}`;
    return this.queues.get(queueKey)?.length ?? 0;
  }

  /**
   * Get all active limits (for debugging)
   */
  getActiveLimits(): Array<{ key: string; count: number; resetAt: number }> {
    return Array.from(this.buckets.entries()).map(([key, entry]) => ({
      key,
      count: entry.count,
      resetAt: entry.resetAt,
    }));
  }

  private getConfig(model: string, provider?: string): RateLimitConfig {
    const normalized = model.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // 1. Model-specific override takes highest priority
    if (this.modelOverrides[normalized]) {
      return this.modelOverrides[normalized];
    }

    // 2. Provider-level override (e.g. providers.anthropic.rateLimit.rpm)
    //    Applies to ALL models from this provider when no model-specific override exists.
    //    Each provider maintains its own isolated bucket — limits don't cascade across providers.
    if (provider) {
      const providerNorm = provider.toLowerCase();
      if (this.providerOverrides[providerNorm]) {
        return this.providerOverrides[providerNorm];
      }
    }

    // 3. Check exact match in built-in defaults
    if (DEFAULT_LIMITS[normalized]) {
      return DEFAULT_LIMITS[normalized];
    }

    // 4. Partial match (e.g. "claude-sonnet" matches "claude-sonnet-4-6")
    for (const [key, config] of Object.entries(DEFAULT_LIMITS)) {
      if (key === 'default') continue;
      if (normalized.includes(key) || key.includes(normalized)) {
        return config;
      }
    }

    return DEFAULT_LIMITS.default;
  }

  private getModelKey(model: string): string {
    const normalized = model.toLowerCase();
    if (normalized.includes('opus')) return 'opus';
    if (normalized.includes('sonnet')) return 'sonnet';
    if (normalized.includes('haiku')) return 'haiku';
    if (normalized.includes('gpt-4o')) return 'gpt-4o';
    if (normalized.includes('gpt-4')) return 'gpt-4';
    if (normalized.includes('o1')) return 'o1';
    return 'default';
  }

  private getCurrentMinute(): number {
    const now = Date.now();
    return Math.floor(now / 60000) * 60000;
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL) return;

    for (const [key, entry] of this.buckets) {
      if (now > entry.resetAt + 60000) {
        this.buckets.delete(key);
      }
    }

    this.lastCleanup = now;
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Load rateLimit + providers config from ~/.relayplane/config.json and apply to the singleton.
 * Call once at proxy startup.
 */
export function configureRateLimiter(): void {
  try {
    // Dynamic require to avoid circular deps at module init time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require('./config.js') as {
      getRateLimitConfig: () => import('./config.js').RateLimitConfigSection;
      getProviderConfigs: () => Record<string, import('./config.js').ProviderConfig>;
    };
    rateLimiter.configure(cfg.getRateLimitConfig());
    rateLimiter.configureProviders(cfg.getProviderConfigs());
  } catch {
    // Ignore — use defaults
  }
}

// Convenience exports
export const checkLimit = (workspaceId: string, model: string, provider?: string): RateLimitCheck =>
  rateLimiter.checkLimit(workspaceId, model, provider);

export const acquireSlot = (workspaceId: string, model: string, provider?: string): Promise<void> =>
  rateLimiter.acquireSlot(workspaceId, model, provider);

export const getUsage = (workspaceId: string, model: string) =>
  rateLimiter.getUsage(workspaceId, model);

export const resetLimit = (workspaceId: string, model?: string): void =>
  rateLimiter.resetLimit(workspaceId, model);
