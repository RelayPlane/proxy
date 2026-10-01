/**
 * In-flight spend reservations for every cap the proxy enforces.
 *
 * Why this exists: caps used to be enforced check-then-act. Admission read
 * the spend recorded so far, the request was forwarded, and its cost was
 * only recorded when the response came back. Thirty concurrent requests all
 * passed the check before the first one finished, so a 10-call per-run cap
 * let 30 through (per-run-budget-benchmark, burst30, 2026-09-30).
 *
 * The fix is reserve-then-reconcile. Admission is one synchronous step:
 * check (recorded spend + live reservations + this request's estimate)
 * against the cap and, if it fits, reserve the estimate before yielding the
 * event loop. Node runs that step without interleaving, so two requests can
 * never both claim the same headroom. When the request finishes, its actual
 * cost is recorded by the normal path and the reservation is released.
 *
 * Leak protection: every hold is released when the request handler settles
 * (success, upstream error, client disconnect, stream end), the release is
 * idempotent, and a hold that somehow outlives its handler expires after
 * HOLD_TTL_MS so a stuck reservation can never wedge a cap forever.
 */

/** Output tokens reserved when the request does not state a max. */
export const RESERVE_DEFAULT_OUTPUT_TOKENS = 1024;

/**
 * Ceiling on reserved output tokens. Clients such as Claude Code send
 * max_tokens of 32k to 64k on every call; reserving all of it would block
 * small run caps outright. Above this ceiling a cap can overshoot by at most
 * the unreserved output of the requests in flight at that moment.
 */
export const RESERVE_MAX_OUTPUT_TOKENS = 4096;

/** A hold older than this is treated as released (backstop, not the normal path). */
export const HOLD_TTL_MS = 15 * 60 * 1000;

export type ReleaseFn = () => void;

/** Relative slack for float sums: ten $0.00045 calls must fit a $0.0045 cap exactly. */
const CAP_RELATIVE_EPSILON = 1e-9;

/**
 * True when a request estimated at `projected` fits under `cap` given what is
 * already `committed` (recorded spend + live reservations). A cap that is
 * already reached admits nothing, not even a zero-estimate request.
 */
export function fitsUnderCap(committed: number, projected: number, cap: number): boolean {
  const slack = Math.abs(cap) * CAP_RELATIVE_EPSILON;
  if (committed >= cap - slack) return false;
  return committed + Math.max(0, projected) <= cap + slack;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

/** The request-body fields that state an output-token limit, across provider dialects. */
export interface OutputLimitFields {
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  max_output_tokens?: unknown;
  generationConfig?: unknown;
}

/** The output-token limit a request body asks for, across provider dialects. */
export function requestedMaxOutputTokens(body: OutputLimitFields | null | undefined): number | undefined {
  if (!body) return undefined;
  const direct = positiveInt(body.max_tokens)
    ?? positiveInt(body.max_completion_tokens)
    ?? positiveInt(body.max_output_tokens);
  if (direct !== undefined) return direct;
  const gen = body.generationConfig;
  if (gen && typeof gen === 'object' && 'maxOutputTokens' in gen) {
    return positiveInt(gen.maxOutputTokens);
  }
  return undefined;
}

/** Output tokens to reserve for a request: its stated max, clamped to the ceiling. */
export function reserveOutputTokens(body: OutputLimitFields | null | undefined): number {
  const asked = requestedMaxOutputTokens(body) ?? RESERVE_DEFAULT_OUTPUT_TOKENS;
  return Math.min(asked, RESERVE_MAX_OUTPUT_TOKENS);
}

interface Hold {
  amount: number;
  expiresAt: number;
}

/** Live reservations against one cap. */
export class ReservationPool {
  private holds = new Map<number, Hold>();
  private nextId = 1;
  private total = 0;

  constructor(private readonly ttlMs: number = HOLD_TTL_MS) {}

  /** Sum of live holds (expired holds are dropped first). */
  reserved(now: number = Date.now()): number {
    this.expire(now);
    return this.total > 1e-12 ? this.total : 0;
  }

  /** Number of live holds (expired holds are dropped first). */
  size(now: number = Date.now()): number {
    this.expire(now);
    return this.holds.size;
  }

  /** Reserve `amount` USD. The returned release is idempotent. */
  reserve(amount: number, now: number = Date.now()): ReleaseFn {
    const value = Number.isFinite(amount) && amount > 0 ? amount : 0;
    const id = this.nextId++;
    this.holds.set(id, { amount: value, expiresAt: now + this.ttlMs });
    this.total += value;
    return () => {
      const hold = this.holds.get(id);
      if (!hold) return;
      this.holds.delete(id);
      this.total -= hold.amount;
      if (this.holds.size === 0) this.total = 0;
    };
  }

  clear(): void {
    this.holds.clear();
    this.total = 0;
  }

  private expire(now: number): void {
    if (this.holds.size === 0) return;
    for (const [id, hold] of this.holds) {
      if (hold.expiresAt <= now) {
        this.holds.delete(id);
        this.total -= hold.amount;
      }
    }
    if (this.holds.size === 0) this.total = 0;
  }
}

/** Reservation pools keyed by scope id (run id, session id). Empty pools are dropped. */
export class KeyedReservationPool {
  private pools = new Map<string, ReservationPool>();

  constructor(private readonly ttlMs: number = HOLD_TTL_MS) {}

  reserved(key: string, now: number = Date.now()): number {
    const pool = this.pools.get(key);
    if (!pool) return 0;
    const value = pool.reserved(now);
    if (pool.size(now) === 0) this.pools.delete(key);
    return value;
  }

  size(key: string, now: number = Date.now()): number {
    return this.pools.get(key)?.size(now) ?? 0;
  }

  reserve(key: string, amount: number, now: number = Date.now()): ReleaseFn {
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new ReservationPool(this.ttlMs);
      this.pools.set(key, pool);
    }
    const release = pool.reserve(amount, now);
    const owner = pool;
    return () => {
      release();
      if (owner.size() === 0 && this.pools.get(key) === owner) this.pools.delete(key);
    };
  }

  clear(): void {
    this.pools.clear();
  }
}

/** The holds one request owns. `releaseAll` is idempotent. */
export class RequestHolds {
  private releases: ReleaseFn[] = [];

  add(release: ReleaseFn): void {
    this.releases.push(release);
  }

  get count(): number {
    return this.releases.length;
  }

  releaseAll(): void {
    const pending = this.releases.splice(0);
    for (const release of pending) {
      try { release(); } catch { /* releasing must never throw into a request */ }
    }
  }
}
