/**
 * RelayPlane Cost Alerts & Webhooks
 *
 * Alert types: threshold (budget %), anomaly, breach.
 * Webhook delivery via POST to configured URL.
 * SQLite storage for alert history.
 * Alert deduplication per window.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { AnomalyDetail } from './anomaly.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface AlertsConfig {
  enabled: boolean;
  /** Webhook URL for alert delivery */
  webhookUrl?: string;
  /** Alert cooldown in ms to prevent spam (default: 300000 = 5 min) */
  cooldownMs: number;
  /** Max alerts stored in history */
  maxHistory: number;
}

export type AlertType = 'threshold' | 'anomaly' | 'breach';

export interface Alert {
  id: string;
  type: AlertType;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: number;
  data: Record<string, unknown>;
  delivered: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  enabled: false,
  cooldownMs: 300_000,
  maxHistory: 500,
};

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

// ─── AlertManager ───────────────────────────────────────────────────

export class AlertManager {
  private config: AlertsConfig;
  private db: SqliteDb | null = null;
  private _initialized = false;

  // In-memory deduplication: key → last fired timestamp
  private dedup: Map<string, number> = new Map();
  // In-memory alert history for when DB is unavailable
  private memoryAlerts: Alert[] = [];
  private alertCounter = 0;

  constructor(config?: Partial<AlertsConfig>) {
    this.config = { ...DEFAULT_ALERTS_CONFIG, ...config };
  }

  /** Initialize SQLite storage */
  init(): void {
    if (this._initialized) return;
    if (!this.config.enabled) return;
    this._initialized = true;

    const dir = path.join(os.homedir(), '.relayplane');
    fs.mkdirSync(dir, { recursive: true });

    try {
      const dbPath = path.join(dir, 'alerts.db');
      this.db = openDatabase(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          message TEXT NOT NULL,
          severity TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          delivered INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
        CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
      `);

      // Prune old alerts
      const cutoff = Date.now() - 7 * 86400_000;
      this.db.prepare('DELETE FROM alerts WHERE timestamp < ?').run(cutoff);
    } catch (err) {
      console.warn('[RelayPlane Alerts] SQLite unavailable, memory-only mode:', (err as Error).message);
      this.db = null;
    }
  }

  updateConfig(config: Partial<AlertsConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): AlertsConfig {
    return { ...this.config };
  }

  /**
   * Fire a threshold alert (budget % crossed)
   */
  fireThreshold(threshold: number, currentPercent: number, currentSpend: number, limit: number): Alert | null {
    if (!this.config.enabled) return null;
    const dedupKey = `threshold:${threshold}`;
    if (this.isDuplicate(dedupKey)) return null;

    const severity = threshold >= 95 ? 'critical' as const : threshold >= 80 ? 'warning' as const : 'info' as const;
    return this.createAlert('threshold', `Budget ${threshold}% threshold crossed (${currentPercent.toFixed(1)}% used: $${currentSpend.toFixed(2)} / $${limit})`, severity, {
      threshold, currentPercent, currentSpend, limit,
    });
  }

  /**
   * Fire an anomaly alert
   */
  fireAnomaly(anomaly: AnomalyDetail): Alert | null {
    if (!this.config.enabled) return null;
    const dedupKey = `anomaly:${anomaly.type}`;
    if (this.isDuplicate(dedupKey)) return null;

    return this.createAlert('anomaly', `Anomaly detected: ${anomaly.message}`, anomaly.severity === 'critical' ? 'critical' : 'warning', {
      anomalyType: anomaly.type, ...anomaly.data,
    });
  }

  /**
   * Fire a breach alert (budget limit exceeded)
   */
  fireBreach(breachType: string, currentSpend: number, limit: number): Alert | null {
    if (!this.config.enabled) return null;
    const dedupKey = `breach:${breachType}`;
    if (this.isDuplicate(dedupKey)) return null;

    return this.createAlert('breach', `Budget breach: ${breachType} limit exceeded ($${currentSpend.toFixed(2)} / $${limit})`, 'critical', {
      breachType, currentSpend, limit,
    });
  }

  /**
   * Get recent alerts
   */
  getRecent(limit: number = 20): Alert[] {
    if (this.db) {
      const rows = this.db.prepare(
        'SELECT id, type, message, severity, timestamp, data, delivered FROM alerts ORDER BY timestamp DESC LIMIT ?'
      ).all(limit) as Array<{ id: string; type: string; message: string; severity: string; timestamp: number; data: string; delivered: number }>;
      return rows.map(r => ({
        id: r.id,
        type: r.type as AlertType,
        message: r.message,
        severity: r.severity as 'info' | 'warning' | 'critical',
        timestamp: r.timestamp,
        data: JSON.parse(r.data),
        delivered: r.delivered === 1,
      }));
    }
    return this.memoryAlerts.slice(-limit).reverse();
  }

  /**
   * Get alert count by type
   */
  getCounts(): Record<AlertType, number> {
    const counts: Record<AlertType, number> = { threshold: 0, anomaly: 0, breach: 0 };
    if (this.db) {
      const rows = this.db.prepare('SELECT type, COUNT(*) as c FROM alerts GROUP BY type').all() as Array<{ type: string; c: number }>;
      for (const r of rows) {
        if (r.type in counts) counts[r.type as AlertType] = r.c;
      }
    } else {
      for (const a of this.memoryAlerts) {
        counts[a.type]++;
      }
    }
    return counts;
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private isDuplicate(key: string): boolean {
    const last = this.dedup.get(key);
    if (last && (Date.now() - last) < this.config.cooldownMs) {
      return true;
    }
    this.dedup.set(key, Date.now());
    return false;
  }

  private createAlert(type: AlertType, message: string, severity: 'info' | 'warning' | 'critical', data: Record<string, unknown>): Alert {
    const alert: Alert = {
      id: `alert-${++this.alertCounter}-${Date.now()}`,
      type,
      message,
      severity,
      timestamp: Date.now(),
      data,
      delivered: false,
    };

    // Store
    this.storeAlert(alert);

    // Deliver webhook (non-blocking)
    this.deliverWebhook(alert);

    return alert;
  }

  private storeAlert(alert: Alert): void {
    if (this.db) {
      this.db.prepare(
        'INSERT INTO alerts (id, type, message, severity, timestamp, data, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(alert.id, alert.type, alert.message, alert.severity, alert.timestamp, JSON.stringify(alert.data), alert.delivered ? 1 : 0);

      // Prune excess
      const count = (this.db.prepare('SELECT COUNT(*) as c FROM alerts').get() as { c: number }).c;
      if (count > this.config.maxHistory) {
        this.db.prepare(
          'DELETE FROM alerts WHERE id IN (SELECT id FROM alerts ORDER BY timestamp ASC LIMIT ?)'
        ).run(count - this.config.maxHistory);
      }
    } else {
      this.memoryAlerts.push(alert);
      if (this.memoryAlerts.length > this.config.maxHistory) {
        this.memoryAlerts.shift();
      }
    }
  }

  private deliverWebhook(alert: Alert): void {
    if (!this.config.webhookUrl) return;
    const url = this.config.webhookUrl;

    // Fire and forget
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'relayplane',
        alert: {
          id: alert.id,
          type: alert.type,
          message: alert.message,
          severity: alert.severity,
          timestamp: new Date(alert.timestamp).toISOString(),
          data: alert.data,
        },
      }),
    }).then(() => {
      alert.delivered = true;
      try {
        if (this.db) {
          this.db!.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').run(alert.id);
        }
      } catch { /* SQLite failure non-fatal */ }
    }).catch(() => {
      // Webhook delivery failure — non-fatal
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: AlertManager | null = null;

export function getAlertManager(config?: Partial<AlertsConfig>): AlertManager {
  if (!_instance) {
    _instance = new AlertManager(config);
  }
  return _instance;
}

export function resetAlertManager(): void {
  if (_instance) { _instance.close(); _instance = null; }
}
