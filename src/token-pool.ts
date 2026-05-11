/**
 * Multi-account token pool for Anthropic (and future providers).
 *
 * Supports two registration paths:
 *  1. Auto-detected  — tokens seen in incoming Authorization headers are
 *     registered automatically with lower priority (priority = 10).
 *  2. Explicit config — accounts listed in ~/.relayplane/config.json under
 *     providers.anthropic.accounts[] are registered with the user-specified
 *     priority (default 0 = highest).
 *
 * Selection strategy:
 *  - Skip tokens that are currently rate-limited.
 *  - Skip tokens that have exceeded 90% of their known RPM limit (proactive
 *    throttling).
 *  - Among remaining candidates, pick the lowest priority number first;
 *    break ties by fewest requests this minute.
 *
 * 429 handling:
 *  - When the caller receives a 429 from upstream, it calls record429() with
 *    the token that was used.  That token is marked as rate-limited until
 *    `retry-after` seconds have elapsed (default: 60 s).
 *  - The caller should then call selectToken() again to get the next
 *    available token.
 */

import { getDefaultRpm } from './provider-limits.js';

export interface PoolAccountConfig {
  /** Human-readable label, e.g. "work-max" */
  label: string;
  /** Raw API key or OAT token */
  apiKey: string;
  /**
   * Priority: lower = tried first.  Explicitly configured accounts use the
   * value from config.json (default 0).  Auto-detected tokens use 10.
   */
  priority: number;
}

export interface TokenState {
  label: string;
  apiKey: string;
  priority: number;
  /** How was this token registered? */
  source: 'config' | 'auto-detect';
  /** Whether the token is an OAT (Claude Max) subscription token */
  isOat: boolean;
  /** Unix ms timestamp until which this token is considered rate-limited */
  rateLimitedUntil: number;
  /** Number of requests dispatched in the current 1-minute window */
  requestsThisMinute: number;
  /** Start of the current 1-minute window (Unix ms) */
  windowStart: number;
  /** Best-known RPM limit learned from upstream headers */
  knownRpmLimit: number;
  /** Consecutive 401 auth failures since last success */
  consecutiveAuthFailures: number;
  /** Unix ms timestamp until which this token is quarantined after repeated 401s */
  quarantinedUntil: number;
}

export interface TokenPoolStatus {
  accounts: Array<{
    label: string;
    priority: number;
    source: 'config' | 'auto-detect';
    isOat: boolean;
    requestsThisMinute: number;
    knownRpmLimit: number;
    rateLimitedUntil: number | null;
    available: boolean;
  }>;
}

/** Tokens with requestsThisMinute >= throttleRatio * knownRpmLimit are skipped */
const THROTTLE_RATIO = 0.9;
/** Priority assigned to auto-detected tokens */
const AUTO_DETECT_PRIORITY = 10;
/** Default rate-limit window after a 429 when no Retry-After header is present */
const DEFAULT_RETRY_AFTER_S = 60;
/** Consecutive 401s before a credential is quarantined */
const AUTH_FAILURE_THRESHOLD = 2;
/** How long a quarantined credential is skipped (ms) */
const QUARANTINE_DURATION_MS = 60 * 60 * 1000; // 1 hour

export class TokenPool {
  private tokens: Map<string, TokenState> = new Map();

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register explicit config accounts.  Called once at startup.
   * Replaces any existing config-sourced entry for the same apiKey.
   */
  registerConfigAccounts(accounts: PoolAccountConfig[]): void {
    for (const acct of accounts) {
      const existing = this.tokens.get(acct.apiKey);
      if (existing && existing.source === 'config') {
        // Update priority/label in case config changed
        existing.label = acct.label;
        existing.priority = acct.priority;
      } else {
        this.tokens.set(acct.apiKey, this.makeState(acct, 'config'));
      }
    }
  }

  /**
   * Auto-register a token seen in an incoming Authorization header.
   * No-op if the token is already registered (from config or previous request).
   */
  autoDetect(apiKey: string): void {
    if (!apiKey || this.tokens.has(apiKey)) return;
    const label = `auto-${apiKey.slice(-8)}`;
    const state = this.makeState(
      { label, apiKey, priority: AUTO_DETECT_PRIORITY },
      'auto-detect',
    );
    this.tokens.set(apiKey, state);
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  /**
   * Select the best available token.
   * Returns `null` if all tokens are exhausted / rate-limited.
   */
  selectToken(now: number = Date.now()): TokenState | null {
    this.tickWindows(now);

    const candidates = Array.from(this.tokens.values()).filter((t) =>
      this.isAvailable(t, now),
    );

    if (candidates.length === 0) return null;

    // Sort: lowest priority first, then fewest requests this minute
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.requestsThisMinute - b.requestsThisMinute;
    });

    const selected = candidates[0]!;
    selected.requestsThisMinute += 1;
    return selected;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  /**
   * Record a 401 auth failure. After AUTH_FAILURE_THRESHOLD consecutive failures
   * the credential is quarantined for QUARANTINE_DURATION_MS.
   */
  recordAuthFailure(apiKey: string, now: number = Date.now()): void {
    const state = this.tokens.get(apiKey);
    if (!state) return;
    state.consecutiveAuthFailures += 1;
    if (state.consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
      state.quarantinedUntil = now + QUARANTINE_DURATION_MS;
    }
  }

  /**
   * Record a successful response — resets the consecutive auth failure counter.
   */
  recordSuccess(apiKey: string): void {
    const state = this.tokens.get(apiKey);
    if (!state) return;
    state.consecutiveAuthFailures = 0;
  }

  /**
   * Record a 429 response for the given apiKey.
   * Marks the token as rate-limited for `retryAfterSeconds`.
   */
  record429(apiKey: string, retryAfterSeconds?: number, now: number = Date.now()): void {
    const state = this.tokens.get(apiKey);
    if (!state) return;
    const waitS = retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
    state.rateLimitedUntil = now + waitS * 1000;
  }

  /**
   * Update the known RPM limit and remaining requests from upstream headers.
   * Reads `anthropic-ratelimit-requests-remaining` /
   * `x-ratelimit-remaining-requests` and `anthropic-ratelimit-requests-limit`.
   */
  recordResponseHeaders(
    apiKey: string,
    headers: Record<string, string | string[] | undefined>,
    now: number = Date.now(),
  ): void {
    const state = this.tokens.get(apiKey);
    if (!state) return;

    const h = (name: string): string | undefined => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    // Learn the limit
    const limit =
      h('anthropic-ratelimit-requests-limit') ??
      h('x-ratelimit-limit-requests');
    if (limit) {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0) state.knownRpmLimit = n;
    }

    // If retry-after is present and we haven't already recorded a 429, clear it
    const retryAfter = h('retry-after');
    if (retryAfter && state.rateLimitedUntil <= now) {
      const waitS = parseInt(retryAfter, 10);
      if (!isNaN(waitS) && waitS > 0) {
        state.rateLimitedUntil = now + waitS * 1000;
      }
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(now: number = Date.now()): TokenPoolStatus {
    this.tickWindows(now);
    const accounts = Array.from(this.tokens.values())
      .sort((a, b) => a.priority - b.priority)
      .map((t) => ({
        label: t.label,
        priority: t.priority,
        source: t.source,
        isOat: t.isOat,
        requestsThisMinute: t.requestsThisMinute,
        knownRpmLimit: t.knownRpmLimit,
        rateLimitedUntil: t.rateLimitedUntil > now ? t.rateLimitedUntil : null,
        available: this.isAvailable(t, now),
      }));
    return { accounts };
  }

  /** How many tokens are registered? */
  size(): number {
    return this.tokens.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private makeState(
    acct: PoolAccountConfig,
    source: 'config' | 'auto-detect',
  ): TokenState {
    const isOat = acct.apiKey.startsWith('sk-ant-oat');
    return {
      label: acct.label,
      apiKey: acct.apiKey,
      priority: acct.priority,
      source,
      isOat,
      rateLimitedUntil: 0,
      requestsThisMinute: 0,
      // windowStart=0 so the first tickWindows() call always initialises it to
      // the real current time rather than creation time (which may differ in tests).
      windowStart: 0,
      knownRpmLimit: getDefaultRpm('anthropic', isOat),
      consecutiveAuthFailures: 0,
      quarantinedUntil: 0,
    };
  }

  /** Roll over any per-minute windows that have expired. */
  private tickWindows(now: number): void {
    for (const state of this.tokens.values()) {
      if (now - state.windowStart >= 60_000) {
        state.requestsThisMinute = 0;
        state.windowStart = now;
      }
    }
  }

  private isAvailable(t: TokenState, now: number): boolean {
    if (t.rateLimitedUntil > now) return false;
    if (t.quarantinedUntil > now) return false;
    if (t.requestsThisMinute >= t.knownRpmLimit * THROTTLE_RATIO) return false;
    return true;
  }
}

/** Singleton pool instance shared across all requests */
let _pool: TokenPool | null = null;

export function getTokenPool(): TokenPool {
  if (!_pool) _pool = new TokenPool();
  return _pool;
}

/** Reset the singleton (used in tests) */
export function resetTokenPool(): void {
  _pool = null;
}
