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
