/**
 * Rate Limiter - In-memory rate limiting for RelayPlane Proxy
 * 
 * Hard limits:
 * - Opus models: 10 requests per minute
 * - Other models: 60 requests per minute (default)
 * 
 * Auto-expires old entries every 5 minutes
 */

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

// Hardcoded limits - Opus is expensive, be conservative
export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // Anthropic models
  'claude-opus-4-6': { rpm: 10, maxTokens: 4096 },
  'claude-opus': { rpm: 10, maxTokens: 4096 },
  'claude-sonnet-4-6': { rpm: 30 },
  'claude-haiku-4-5': { rpm: 60 },
  
  // OpenAI models
  'gpt-4o': { rpm: 30 },
  'gpt-4': { rpm: 20 },
  'o1': { rpm: 10, maxTokens: 4096 },
  'o3-mini': { rpm: 30 },
  
  // Default for unknown models
  'default': { rpm: 60 }
};

interface BucketEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  /**
   * Check if a request is allowed under rate limits
   */
  checkLimit(workspaceId: string, model: string): RateLimitCheck {
    this.maybeCleanup();

    const config = this.getConfig(model);
    const key = `${workspaceId}:${this.getModelKey(model)}:${this.getCurrentMinute()}`;
    
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window
    const resetAt = this.getCurrentMinute() + windowMs;

    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { count: 0, resetAt };
      this.buckets.set(key, entry);
    }

    // Check if window expired and reset
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
      retryAfter: allowed ? undefined : Math.ceil((resetAt - now) / 1000)
    };
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
      resetAt: entry?.resetAt || this.getCurrentMinute() + 60 * 1000
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
   * Get all active limits (for debugging)
   */
  getActiveLimits(): Array<{ key: string; count: number; resetAt: number }> {
    return Array.from(this.buckets.entries()).map(([key, entry]) => ({
      key,
      count: entry.count,
      resetAt: entry.resetAt
    }));
  }

  private getConfig(model: string): RateLimitConfig {
    // Normalize model name
    const normalized = model.toLowerCase().replace(/[^a-z0-9-]/g, '');
    
    // Check exact match first
    if (DEFAULT_LIMITS[normalized]) {
      return DEFAULT_LIMITS[normalized];
    }
    
    // Check partial match
    for (const [key, config] of Object.entries(DEFAULT_LIMITS)) {
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
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL) {
      return;
    }

    // Remove expired entries
    for (const [key, entry] of this.buckets) {
      if (now > entry.resetAt + 60000) { // Keep 1 minute grace period
        this.buckets.delete(key);
      }
    }

    this.lastCleanup = now;
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

// Convenience exports
export const checkLimit = (workspaceId: string, model: string) => 
  rateLimiter.checkLimit(workspaceId, model);

export const getUsage = (workspaceId: string, model: string) => 
  rateLimiter.getUsage(workspaceId, model);

export const resetLimit = (workspaceId: string, model?: string) => 
  rateLimiter.resetLimit(workspaceId, model);
