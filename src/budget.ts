/**
 * RelayPlane Budget Enforcement
 *
 * SQLite-based spend tracking with in-memory cache for <5ms hot-path checks.
 * Tracks daily/hourly windows and per-request limits.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ─── Model Pricing Constants ──────────────────────────────────────────

/** Per-million token pricing for known Claude models (USD). */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-opus-4-6':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-opus-4-5':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-sonnet-4-6':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-4-5':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5':             { inputPer1M: 0.80,  outputPer1M: 4.00  },
  'claude-haiku-4-5-20251001':    { inputPer1M: 0.80,  outputPer1M: 4.00  },
  'claude-3-5-sonnet-20241022':   { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-3-5-haiku-20241022':    { inputPer1M: 0.80,  outputPer1M: 4.00  },
  'claude-3-opus-20240229':       { inputPer1M: 15.00, outputPer1M: 75.00 },
};

/**
 * Estimate cost in USD for a completed request given token counts.
 * Returns 0 if the model is not in MODEL_PRICING.
 */
export function estimateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface BudgetConfig {
  enabled: boolean;
  /** Daily spend limit in USD (default: 50) */
  dailyUsd: number;
  /** Hourly spend limit in USD (default: 10) */
  hourlyUsd: number;
  /** Per-request spend limit in USD (default: 2) */
  perRequestUsd: number;
  /** Action on breach: block, warn, downgrade, alert */
  onBreach: 'block' | 'warn' | 'downgrade' | 'alert';
  /** Model to downgrade to when onBreach=downgrade */
  downgradeTo: string;
  /** Webhook URL for alerts */
  alertWebhook?: string;
  /** Alert thresholds as percentages of daily limit */
  alertThresholds: number[];
  /** Per-session spend cap in USD (default: 1.00). Session budget is only active when a session ID is present. */
  sessionCapUsd: number;
  /** Model downgrade ladder — when a session exceeds 80% of its cap, downgrade to the next rung */
  modelLadder: string[];
  /**
   * Simple daily cap in USD used by BudgetTracker.
   * When set, all requests are blocked once this amount is reached today.
   * null / undefined = unlimited.
   */
  dailyCapUSD?: number;
  /**
   * Warning threshold as a fraction of dailyCapUSD (0–1). Default: 0.8.
   * When daily spend / dailyCapUSD >= warningThreshold, a warning header is added.
   */
  warningThreshold?: number;
}

// ─── Session Budget Types ────────────────────────────────────────────

export interface SessionBudgetRecord {
  sessionId: string;
  capUsd: number;
  spentUsd: number;
  modelUsed: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionBudgetCheckResult {
  allowed: boolean;
  model: string;
  reason?: string;
  spent: number;
  cap: number;
}

export interface BudgetStatus {
  dailySpend: number;
  dailyLimit: number;
  dailyPercent: number;
  hourlySpend: number;
  hourlyLimit: number;
  hourlyPercent: number;
  dailyWindow: string;
  hourlyWindow: string;
  breached: boolean;
  breachType: 'none' | 'daily' | 'hourly';
}

export interface BudgetCheckResult {
  allowed: boolean;
  breached: boolean;
  breachType: 'none' | 'daily' | 'hourly' | 'per-request';
  action: 'allow' | 'block' | 'warn' | 'downgrade' | 'alert';
  currentDailySpend: number;
  currentHourlySpend: number;
  thresholdsCrossed: number[];
}

interface SpendRecord {
  amount: number;
  timestamp: number;
  model: string;
  dailyWindow: string;
  hourlyWindow: string;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: false,
  dailyUsd: 50,
  hourlyUsd: 10,
  perRequestUsd: 2,
  onBreach: 'downgrade',
  downgradeTo: 'claude-sonnet-4-6',
  alertThresholds: [50, 80, 95],
  sessionCapUsd: 1.00,
  modelLadder: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
};

// ─── Window helpers ──────────────────────────────────────────────────

export function getDailyWindow(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function getHourlyWindow(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

// ─── SQLite helpers ──────────────────────────────────────────────────

interface SqliteDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
}

function openDatabase(dbPath: string): SqliteDb {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

// ─── BudgetManager ──────────────────────────────────────────────────

export class BudgetManager {
  private config: BudgetConfig;
  private db: SqliteDb | null = null;
  private _initialized = false;

  // In-memory cache for <5ms hot-path
  private dailySpendCache: number = 0;
  private hourlySpendCache: number = 0;
  private cachedDailyWindow: string = '';
  private cachedHourlyWindow: string = '';
  private firedThresholds: Set<string> = new Set();

  // Pending async writes
  private pendingWrites: SpendRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  // In-memory session budget cache: sessionId → SessionBudgetRecord
  private sessionCache: Map<string, SessionBudgetRecord> = new Map();

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /** Initialize SQLite storage. Safe to call multiple times. */
  init(): void {
    if (this._initialized) return;
    if (!this.config.enabled) return;
    this._initialized = true;

    const budgetDir = path.join(os.homedir(), '.relayplane');
    fs.mkdirSync(budgetDir, { recursive: true });

    try {
      const dbPath = path.join(budgetDir, 'budget.db');
      this.db = openDatabase(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS spend_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          amount REAL NOT NULL,
          model TEXT NOT NULL,
          daily_window TEXT NOT NULL,
          hourly_window TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_window ON spend_log(daily_window);
        CREATE INDEX IF NOT EXISTS idx_hourly_window ON spend_log(hourly_window);

        CREATE TABLE IF NOT EXISTS session_budgets (
          session_id TEXT PRIMARY KEY,
          cap_usd REAL NOT NULL,
          spent_usd REAL NOT NULL DEFAULT 0,
          model_used TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Load current window totals into memory
      this.refreshCache();
    } catch (err) {
      console.warn('[RelayPlane Budget] SQLite unavailable, memory-only mode:', (err as Error).message);
      this.db = null;
    }
  }

  /** Update config at runtime */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * Pre-request budget check. Must be <5ms.
   * Uses in-memory cache, never touches SQLite.
   */
  checkBudget(estimatedCost?: number): BudgetCheckResult {
    if (!this.config.enabled) {
      return {
        allowed: true, breached: false, breachType: 'none',
        action: 'allow', currentDailySpend: 0, currentHourlySpend: 0,
        thresholdsCrossed: [],
      };
    }

    // Ensure cache is for current windows
    this.ensureCacheWindows();

    // Per-request check
    if (estimatedCost !== undefined && estimatedCost > this.config.perRequestUsd) {
      return {
        allowed: this.config.onBreach !== 'block',
        breached: true,
        breachType: 'per-request',
        action: this.config.onBreach,
        currentDailySpend: this.dailySpendCache,
        currentHourlySpend: this.hourlySpendCache,
        thresholdsCrossed: [],
      };
    }

    // Hourly check
    if (this.hourlySpendCache >= this.config.hourlyUsd) {
      return {
        allowed: this.config.onBreach !== 'block',
        breached: true,
        breachType: 'hourly',
        action: this.config.onBreach,
        currentDailySpend: this.dailySpendCache,
        currentHourlySpend: this.hourlySpendCache,
        thresholdsCrossed: [],
      };
    }

    // Daily check
    if (this.dailySpendCache >= this.config.dailyUsd) {
      return {
        allowed: this.config.onBreach !== 'block',
        breached: true,
        breachType: 'daily',
        action: this.config.onBreach,
        currentDailySpend: this.dailySpendCache,
        currentHourlySpend: this.hourlySpendCache,
        thresholdsCrossed: [],
      };
    }

    // Check thresholds
    const thresholdsCrossed: number[] = [];
    for (const threshold of this.config.alertThresholds) {
      const pct = (this.dailySpendCache / this.config.dailyUsd) * 100;
      const key = `${this.cachedDailyWindow}:${threshold}`;
      if (pct >= threshold && !this.firedThresholds.has(key)) {
        thresholdsCrossed.push(threshold);
      }
    }

    return {
      allowed: true, breached: false, breachType: 'none',
      action: 'allow',
      currentDailySpend: this.dailySpendCache,
      currentHourlySpend: this.hourlySpendCache,
      thresholdsCrossed,
    };
  }

  /**
   * Record spend after a request completes.
   * Updates in-memory cache immediately, writes to SQLite async.
   */
  recordSpend(amount: number, model: string): void {
    if (!this.config.enabled) return;

    this.ensureCacheWindows();

    // Update in-memory cache immediately
    this.dailySpendCache += amount;
    this.hourlySpendCache += amount;

    // Queue async write
    const record: SpendRecord = {
      amount,
      model,
      timestamp: Date.now(),
      dailyWindow: this.cachedDailyWindow,
      hourlyWindow: this.cachedHourlyWindow,
    };
    this.pendingWrites.push(record);
    this.scheduleFlush();
  }

  /** Mark a threshold as fired (for deduplication) */
  markThresholdFired(threshold: number): void {
    const key = `${this.cachedDailyWindow}:${threshold}`;
    this.firedThresholds.add(key);
  }

  /** Get current budget status */
  getStatus(): BudgetStatus {
    this.ensureCacheWindows();
    const dailyPercent = this.config.dailyUsd > 0
      ? (this.dailySpendCache / this.config.dailyUsd) * 100 : 0;
    const hourlyPercent = this.config.hourlyUsd > 0
      ? (this.hourlySpendCache / this.config.hourlyUsd) * 100 : 0;

    let breachType: 'none' | 'daily' | 'hourly' = 'none';
    if (this.hourlySpendCache >= this.config.hourlyUsd) breachType = 'hourly';
    else if (this.dailySpendCache >= this.config.dailyUsd) breachType = 'daily';

    return {
      dailySpend: this.dailySpendCache,
      dailyLimit: this.config.dailyUsd,
      dailyPercent,
      hourlySpend: this.hourlySpendCache,
      hourlyLimit: this.config.hourlyUsd,
      hourlyPercent,
      dailyWindow: this.cachedDailyWindow,
      hourlyWindow: this.cachedHourlyWindow,
      breached: breachType !== 'none',
      breachType,
    };
  }

  /** Reset current window spend */
  reset(): void {
    this.dailySpendCache = 0;
    this.hourlySpendCache = 0;
    this.firedThresholds.clear();
    if (this.db) {
      const dw = getDailyWindow();
      const hw = getHourlyWindow();
      this.db.prepare('DELETE FROM spend_log WHERE daily_window = ?').run(dw);
      this.cachedDailyWindow = dw;
      this.cachedHourlyWindow = hw;
    }
  }

  /** Set budget limits */
  setLimits(limits: { dailyUsd?: number; hourlyUsd?: number; perRequestUsd?: number }): void {
    if (limits.dailyUsd !== undefined) this.config.dailyUsd = limits.dailyUsd;
    if (limits.hourlyUsd !== undefined) this.config.hourlyUsd = limits.hourlyUsd;
    if (limits.perRequestUsd !== undefined) this.config.perRequestUsd = limits.perRequestUsd;
  }

  // ─── Session Budget ──────────────────────────────────────────────

  /**
   * Pre-request session budget check.
   * Returns whether the request is allowed, possibly with a downgraded model.
   * Called only when X-Claude-Code-Session-Id header is present.
   */
  checkSessionBudget(sessionId: string, requestedModel: string): SessionBudgetCheckResult {
    const record = this._getOrCreateSessionRecord(sessionId, this.config.sessionCapUsd);
    const spent = record.spentUsd;
    const cap = record.capUsd;

    if (spent >= cap) {
      return { allowed: false, model: requestedModel, reason: 'session_budget_exceeded', spent, cap };
    }

    // Downgrade if >80% of cap spent
    const pct = cap > 0 ? spent / cap : 0;
    let model = requestedModel;
    if (pct >= 0.8) {
      model = this._nextLadderModel(requestedModel);
    }

    return { allowed: true, model, spent, cap };
  }

  /**
   * Post-request: record actual cost for a session.
   * Fire-and-forget — updates in-memory cache immediately, writes SQLite async.
   */
  updateSessionBudget(sessionId: string, cost: number, modelUsed: string): void {
    const cap = this.config.sessionCapUsd;
    const record = this._getOrCreateSessionRecord(sessionId, cap);
    record.spentUsd += cost;
    record.modelUsed = modelUsed;
    record.updatedAt = Date.now();
    this.sessionCache.set(sessionId, record);

    // Async SQLite write (fire-and-forget)
    if (this.db) {
      setImmediate(() => {
        try {
          this.db!.prepare(`
            INSERT INTO session_budgets (session_id, cap_usd, spent_usd, model_used, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              spent_usd = excluded.spent_usd,
              model_used = excluded.model_used,
              updated_at = excluded.updated_at
          `).run(sessionId, record.capUsd, record.spentUsd, record.modelUsed, record.createdAt, record.updatedAt);
        } catch {
          // SQLite writes are best-effort; in-memory cache is authoritative
        }
      });
    }
  }

  /** Get session budget record by session ID */
  getSessionBudget(sessionId: string): SessionBudgetRecord | null {
    if (this.sessionCache.has(sessionId)) {
      return { ...this.sessionCache.get(sessionId)! };
    }
    if (this.db) {
      const row = this.db.prepare(
        'SELECT session_id, cap_usd, spent_usd, model_used, created_at, updated_at FROM session_budgets WHERE session_id = ?'
      ).get(sessionId) as { session_id: string; cap_usd: number; spent_usd: number; model_used: string; created_at: number; updated_at: number } | undefined;
      if (row) {
        const record: SessionBudgetRecord = {
          sessionId: row.session_id,
          capUsd: row.cap_usd,
          spentUsd: row.spent_usd,
          modelUsed: row.model_used,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        this.sessionCache.set(sessionId, record);
        return { ...record };
      }
    }
    return null;
  }

  /** List recent session budget records (last N by updated_at) */
  listSessionBudgets(limit = 50): SessionBudgetRecord[] {
    if (this.db) {
      const rows = this.db.prepare(
        'SELECT session_id, cap_usd, spent_usd, model_used, created_at, updated_at FROM session_budgets ORDER BY updated_at DESC LIMIT ?'
      ).all(limit) as Array<{ session_id: string; cap_usd: number; spent_usd: number; model_used: string; created_at: number; updated_at: number }>;
      return rows.map(row => ({
        sessionId: row.session_id,
        capUsd: row.cap_usd,
        spentUsd: row.spent_usd,
        modelUsed: row.model_used,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    }
    // Memory-only fallback
    return Array.from(this.sessionCache.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(r => ({ ...r }));
  }

  /** Override the per-session cap for a specific session */
  setSessionCap(sessionId: string, capUsd: number): void {
    const existing = this._getOrCreateSessionRecord(sessionId, this.config.sessionCapUsd);
    existing.capUsd = capUsd;
    existing.updatedAt = Date.now();
    this.sessionCache.set(sessionId, existing);

    if (this.db) {
      setImmediate(() => {
        try {
          this.db!.prepare(`
            INSERT INTO session_budgets (session_id, cap_usd, spent_usd, model_used, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              cap_usd = excluded.cap_usd,
              updated_at = excluded.updated_at
          `).run(sessionId, capUsd, existing.spentUsd, existing.modelUsed, existing.createdAt, existing.updatedAt);
        } catch {
          // best-effort
        }
      });
    }
  }

  // ─── Private session helpers ──────────────────────────────────────

  private _getOrCreateSessionRecord(sessionId: string, defaultCap: number): SessionBudgetRecord {
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }
    // Try SQLite
    if (this.db) {
      const row = this.db.prepare(
        'SELECT session_id, cap_usd, spent_usd, model_used, created_at, updated_at FROM session_budgets WHERE session_id = ?'
      ).get(sessionId) as { session_id: string; cap_usd: number; spent_usd: number; model_used: string; created_at: number; updated_at: number } | undefined;
      if (row) {
        const record: SessionBudgetRecord = {
          sessionId: row.session_id,
          capUsd: row.cap_usd,
          spentUsd: row.spent_usd,
          modelUsed: row.model_used,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        this.sessionCache.set(sessionId, record);
        return record;
      }
    }
    // Create new in-memory record
    const now = Date.now();
    const record: SessionBudgetRecord = {
      sessionId,
      capUsd: defaultCap,
      spentUsd: 0,
      modelUsed: '',
      createdAt: now,
      updatedAt: now,
    };
    this.sessionCache.set(sessionId, record);
    return record;
  }

  private _nextLadderModel(currentModel: string): string {
    const ladder = this.config.modelLadder;
    if (!ladder || ladder.length === 0) return currentModel;
    const idx = ladder.indexOf(currentModel);
    if (idx === -1) return currentModel; // model not in ladder, no change
    if (idx >= ladder.length - 1) return currentModel; // already at bottom
    return ladder[idx + 1]!;
  }

  /** Shutdown: flush pending writes */
  close(): void {
    this.flushPendingWrites();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private ensureCacheWindows(): void {
    const dw = getDailyWindow();
    const hw = getHourlyWindow();

    if (dw !== this.cachedDailyWindow) {
      this.cachedDailyWindow = dw;
      this.dailySpendCache = 0;
      this.firedThresholds.clear();
      if (this.db) {
        const row = this.db.prepare(
          'SELECT COALESCE(SUM(amount), 0) as total FROM spend_log WHERE daily_window = ?'
        ).get(dw) as { total: number } | undefined;
        if (row) this.dailySpendCache = row.total;
      }
    }

    if (hw !== this.cachedHourlyWindow) {
      this.cachedHourlyWindow = hw;
      this.hourlySpendCache = 0;
      if (this.db) {
        const row = this.db.prepare(
          'SELECT COALESCE(SUM(amount), 0) as total FROM spend_log WHERE hourly_window = ?'
        ).get(hw) as { total: number } | undefined;
        if (row) this.hourlySpendCache = row.total;
      }
    }
  }

  private refreshCache(): void {
    this.cachedDailyWindow = '';
    this.cachedHourlyWindow = '';
    this.ensureCacheWindows();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingWrites();
    }, 1000);
  }

  private flushPendingWrites(): void {
    if (!this.db || this.pendingWrites.length === 0) return;
    const writes = this.pendingWrites.splice(0);
    try {
      const stmt = this.db.prepare(
        'INSERT INTO spend_log (amount, model, daily_window, hourly_window, timestamp) VALUES (?, ?, ?, ?, ?)'
      );
      for (const w of writes) {
        stmt.run(w.amount, w.model, w.dailyWindow, w.hourlyWindow, w.timestamp);
      }
    } catch (err) {
      console.warn('[RelayPlane Budget] SQLite flush failed:', (err as Error).message);
      // In-memory cache is still accurate; SQLite is best-effort persistence
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: BudgetManager | null = null;

export function getBudgetManager(config?: Partial<BudgetConfig>): BudgetManager {
  if (!_instance) {
    _instance = new BudgetManager(config);
  }
  return _instance;
}

export function resetBudgetManager(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

// ─── BudgetTracker ──────────────────────────────────────────────────
//
// Simpler daily cap tracker, separate from BudgetManager.
// Keyed off config.budget.dailyCapUSD / config.budget.warningThreshold.
// Uses its own `daily_cap_log` table inside ~/.relayplane/budget.db.

export interface BudgetCapConfig {
  /** Daily spend cap in USD. Undefined / null = unlimited (no enforcement). */
  dailyCapUSD?: number;
  /** Warning threshold as a fraction of the cap (0–1). Default: 0.8 */
  warningThreshold?: number;
}

export interface DailySpendRecord {
  date: string;        // YYYY-MM-DD
  totalSpend: number;  // USD
  byModel: Record<string, number>;
}

export interface BudgetCapCheckResult {
  allowed: boolean;
  warn: boolean;
  spent: number;
  cap: number | null;
  warningThreshold: number;
}

export class BudgetTracker {
  private dailyCapUSD: number | null;
  private warningThreshold: number;
  private db: SqliteDb | null = null;
  private _initialized = false;

  // In-memory daily spend cache
  private dailySpend: number = 0;
  private cachedDay: string = '';

  // Pending async writes
  private pendingWrites: Array<{ amount: number; model: string; dailyWindow: string; timestamp: number }> = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config?: BudgetCapConfig) {
    this.dailyCapUSD = config?.dailyCapUSD ?? null;
    this.warningThreshold = config?.warningThreshold ?? 0.8;
  }

  /** Initialize SQLite storage. Safe to call multiple times. */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;
    if (this.dailyCapUSD === null) return; // unlimited — no persistence needed

    const budgetDir = path.join(os.homedir(), '.relayplane');
    fs.mkdirSync(budgetDir, { recursive: true });

    try {
      const dbPath = path.join(budgetDir, 'budget.db');
      this.db = openDatabase(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS daily_cap_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          amount REAL NOT NULL,
          model TEXT NOT NULL,
          daily_window TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dcl_daily_window ON daily_cap_log(daily_window);
      `);
      this._refreshDay();
    } catch (err) {
      console.warn('[RelayPlane BudgetTracker] SQLite unavailable, memory-only mode:', (err as Error).message);
      this.db = null;
    }
  }

  /** Update cap / threshold at runtime (e.g. on config reload). */
  updateConfig(config: BudgetCapConfig): void {
    if ('dailyCapUSD' in config) {
      const newCap = config.dailyCapUSD ?? null;
      if (newCap !== this.dailyCapUSD) {
        this.dailyCapUSD = newCap;
        // If cap just became active and DB not open yet, re-init
        if (newCap !== null && !this.db && this._initialized) {
          this._initialized = false;
          this.init();
        }
      }
    }
    if (config.warningThreshold !== undefined) {
      this.warningThreshold = config.warningThreshold;
    }
  }

  /**
   * Pre-request check. Always <5ms — reads in-memory cache only.
   * Call `init()` before first use.
   */
  check(): BudgetCapCheckResult {
    if (this.dailyCapUSD === null) {
      return { allowed: true, warn: false, spent: 0, cap: null, warningThreshold: this.warningThreshold };
    }
    this._ensureDay();
    const cap = this.dailyCapUSD;
    const spent = this.dailySpend;
    const allowed = spent < cap;
    const warn = allowed && cap > 0 && (spent / cap) >= this.warningThreshold;
    return { allowed, warn, spent, cap, warningThreshold: this.warningThreshold };
  }

  /**
   * Record actual spend after a request completes.
   * Updates in-memory cache immediately; SQLite write is async.
   */
  record(amount: number, model: string): void {
    if (this.dailyCapUSD === null || amount <= 0) return;
    this._ensureDay();
    this.dailySpend += amount;
    this.pendingWrites.push({ amount, model, dailyWindow: this.cachedDay, timestamp: Date.now() });
    this._scheduleFlush();
  }

  /**
   * Return daily spend history for the last `days` calendar days.
   * Requires SQLite; falls back to today's in-memory total only.
   */
  getHistory(days = 30): DailySpendRecord[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    if (this.db) {
      const rows = this.db.prepare(`
        SELECT daily_window, model, SUM(amount) as total
        FROM daily_cap_log
        WHERE daily_window >= ?
        GROUP BY daily_window, model
        ORDER BY daily_window DESC
      `).all(cutoffStr) as Array<{ daily_window: string; model: string; total: number }>;

      const byDate = new Map<string, DailySpendRecord>();
      for (const row of rows) {
        if (!byDate.has(row.daily_window)) {
          byDate.set(row.daily_window, { date: row.daily_window, totalSpend: 0, byModel: {} });
        }
        const rec = byDate.get(row.daily_window)!;
        rec.byModel[row.model] = (rec.byModel[row.model] ?? 0) + row.total;
        rec.totalSpend += row.total;
      }
      return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
    }

    // Memory-only fallback
    if (this.dailySpend > 0 && this.cachedDay >= cutoffStr) {
      return [{ date: this.cachedDay, totalSpend: this.dailySpend, byModel: {} }];
    }
    return [];
  }

  /** Today's total spend (USD). */
  getDailySpend(): number {
    this._ensureDay();
    return this.dailySpend;
  }

  /** Configured daily cap (null = unlimited). */
  getCap(): number | null {
    return this.dailyCapUSD;
  }

  /** Flush pending writes and close SQLite. */
  close(): void {
    this._flushPendingWrites();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private _ensureDay(): void {
    const today = getDailyWindow();
    if (today !== this.cachedDay) {
      this.cachedDay = today;
      this.dailySpend = 0;
      if (this.db) {
        const row = this.db.prepare(
          'SELECT COALESCE(SUM(amount), 0) as total FROM daily_cap_log WHERE daily_window = ?'
        ).get(today) as { total: number } | undefined;
        this.dailySpend = row?.total ?? 0;
      }
    }
  }

  private _refreshDay(): void {
    this.cachedDay = '';
    this._ensureDay();
  }

  private _scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flushPendingWrites();
    }, 1000);
  }

  private _flushPendingWrites(): void {
    if (!this.db || this.pendingWrites.length === 0) return;
    const writes = this.pendingWrites.splice(0);
    try {
      const stmt = this.db.prepare(
        'INSERT INTO daily_cap_log (amount, model, daily_window, timestamp) VALUES (?, ?, ?, ?)'
      );
      for (const w of writes) {
        stmt.run(w.amount, w.model, w.dailyWindow, w.timestamp);
      }
    } catch (err) {
      console.warn('[RelayPlane BudgetTracker] SQLite flush failed:', (err as Error).message);
    }
  }
}

// ─── BudgetTracker Singleton ─────────────────────────────────────────

let _trackerInstance: BudgetTracker | null = null;

export function getBudgetTracker(config?: BudgetCapConfig): BudgetTracker {
  if (!_trackerInstance) {
    _trackerInstance = new BudgetTracker(config);
  }
  return _trackerInstance;
}

export function resetBudgetTracker(): void {
  if (_trackerInstance) {
    _trackerInstance.close();
    _trackerInstance = null;
  }
}
