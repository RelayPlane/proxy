/**
 * RelayPlane Anomaly Detection
 *
 * Sliding window analysis to detect runaway agent loops and cost spikes.
 * Maintains an in-memory circular buffer of last 100 requests.
 *
 * Detection types:
 * - Velocity spike: >10x normal request rate in 5-minute window
 * - Cost acceleration: spend rate doubling every minute
 * - Repetition detection: same model + similar token count >20 times in 5 min
 * - Token explosion: single request >$5 estimated cost
 *
 * @packageDocumentation
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface AnomalyConfig {
  enabled: boolean;
  /** Max requests in 5-minute window before velocity spike (default: 50) */
  velocityThreshold: number;
  /** Cost threshold for single request token explosion (default: 5.0 USD) */
  tokenExplosionUsd: number;
  /** Same model+token pattern count in 5 min before repetition flag (default: 20) */
  repetitionThreshold: number;
  /** Window size in ms for analysis (default: 300000 = 5 min) */
  windowMs: number;
}

export type AnomalyType = 'velocity_spike' | 'cost_acceleration' | 'repetition' | 'token_explosion';

export interface AnomalyResult {
  detected: boolean;
  anomalies: AnomalyDetail[];
}

export interface AnomalyDetail {
  type: AnomalyType;
  message: string;
  severity: 'warning' | 'critical';
  data: Record<string, number | string>;
}

interface RequestEntry {
  timestamp: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: false,
  velocityThreshold: 50,
  tokenExplosionUsd: 5.0,
  repetitionThreshold: 20,
  windowMs: 300_000,
};

// ─── AnomalyDetector ────────────────────────────────────────────────

export class AnomalyDetector {
  private config: AnomalyConfig;
  private buffer: RequestEntry[] = [];
  private readonly maxBufferSize = 100;

  // Baseline: rolling average requests per minute over last hour
  private minuteBuckets: Map<number, number> = new Map();

  constructor(config?: Partial<AnomalyConfig>) {
    this.config = { ...DEFAULT_ANOMALY_CONFIG, ...config };
  }

  updateConfig(config: Partial<AnomalyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): AnomalyConfig {
    return { ...this.config };
  }

  /**
   * Record a completed request for analysis.
   * Call this post-response. Returns anomalies detected.
   */
  recordAndAnalyze(entry: {
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }): AnomalyResult {
    if (!this.config.enabled) {
      return { detected: false, anomalies: [] };
    }

    const record: RequestEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    // Add to circular buffer
    this.buffer.push(record);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Track minute buckets for baseline
    const minuteKey = Math.floor(record.timestamp / 60_000);
    this.minuteBuckets.set(minuteKey, (this.minuteBuckets.get(minuteKey) ?? 0) + 1);
    // Cleanup old buckets (keep last 60 minutes)
    const cutoff = minuteKey - 60;
    for (const [key] of this.minuteBuckets) {
      if (key < cutoff) this.minuteBuckets.delete(key);
    }

    return this.analyze(record);
  }

  /** Get current buffer size (for testing) */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer = [];
    this.minuteBuckets.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────

  private analyze(current: RequestEntry): AnomalyResult {
    const anomalies: AnomalyDetail[] = [];
    const now = current.timestamp;
    const windowStart = now - this.config.windowMs;
    const recent = this.buffer.filter(r => r.timestamp >= windowStart);

    // 1. Token explosion — single request cost
    if (current.costUsd > this.config.tokenExplosionUsd) {
      anomalies.push({
        type: 'token_explosion',
        message: `Single request cost $${current.costUsd.toFixed(4)} exceeds threshold $${this.config.tokenExplosionUsd}`,
        severity: 'critical',
        data: { costUsd: current.costUsd, threshold: this.config.tokenExplosionUsd, model: current.model },
      });
    }

    // 2. Velocity spike — too many requests in window
    if (recent.length >= this.config.velocityThreshold) {
      // Compare to baseline (avg requests per 5 min over last hour)
      const baselineRpm = this.getBaselineRpm();
      const currentRate = recent.length;
      const expectedIn5Min = baselineRpm * 5;
      // Only flag if >10x normal OR above absolute threshold
      if (expectedIn5Min > 0 && currentRate > expectedIn5Min * 10) {
        anomalies.push({
          type: 'velocity_spike',
          message: `${currentRate} requests in ${this.config.windowMs / 1000}s (baseline: ~${Math.round(expectedIn5Min)}/5min)`,
          severity: 'warning',
          data: { currentRate, baseline: expectedIn5Min, windowMs: this.config.windowMs },
        });
      } else if (currentRate >= this.config.velocityThreshold) {
        anomalies.push({
          type: 'velocity_spike',
          message: `${currentRate} requests in ${this.config.windowMs / 1000}s exceeds threshold ${this.config.velocityThreshold}`,
          severity: 'warning',
          data: { currentRate, threshold: this.config.velocityThreshold, windowMs: this.config.windowMs },
        });
      }
    }

    // 3. Repetition detection — same model + similar token count
    if (recent.length >= this.config.repetitionThreshold) {
      const patternCounts = new Map<string, number>();
      for (const r of recent) {
        // Bucket token counts by rounding to nearest 100
        const tokenBucket = Math.round((r.tokensIn + r.tokensOut) / 100) * 100;
        const key = `${r.model}:${tokenBucket}`;
        patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
      }
      for (const [pattern, count] of patternCounts) {
        if (count >= this.config.repetitionThreshold) {
          anomalies.push({
            type: 'repetition',
            message: `Pattern "${pattern}" repeated ${count} times in ${this.config.windowMs / 1000}s (possible agent loop)`,
            severity: 'critical',
            data: { pattern, count, threshold: this.config.repetitionThreshold },
          });
          break; // One repetition alert is enough
        }
      }
    }

    // 4. Cost acceleration — check if spend rate is doubling
    if (recent.length >= 10) {
      const mid = Math.floor(recent.length / 2);
      const firstHalf = recent.slice(0, mid);
      const secondHalf = recent.slice(mid);
      const firstCost = firstHalf.reduce((s, r) => s + r.costUsd, 0);
      const secondCost = secondHalf.reduce((s, r) => s + r.costUsd, 0);
      // Time-normalize
      const firstDuration = (firstHalf[firstHalf.length - 1]!.timestamp - firstHalf[0]!.timestamp) || 1;
      const secondDuration = (secondHalf[secondHalf.length - 1]!.timestamp - secondHalf[0]!.timestamp) || 1;
      const firstRate = firstCost / firstDuration;
      const secondRate = secondCost / secondDuration;

      if (firstRate > 0 && secondRate > firstRate * 2 && secondCost > 1) {
        anomalies.push({
          type: 'cost_acceleration',
          message: `Cost rate doubled: $${(firstRate * 60000).toFixed(4)}/min → $${(secondRate * 60000).toFixed(4)}/min`,
          severity: 'warning',
          data: {
            firstRatePerMin: firstRate * 60000,
            secondRatePerMin: secondRate * 60000,
            ratio: secondRate / firstRate,
          },
        });
      }
    }

    return {
      detected: anomalies.length > 0,
      anomalies,
    };
  }

  private getBaselineRpm(): number {
    if (this.minuteBuckets.size <= 1) return 0;
    let total = 0;
    for (const [, count] of this.minuteBuckets) {
      total += count;
    }
    return total / this.minuteBuckets.size;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: AnomalyDetector | null = null;

export function getAnomalyDetector(config?: Partial<AnomalyConfig>): AnomalyDetector {
  if (!_instance) {
    _instance = new AnomalyDetector(config);
  }
  return _instance;
}

export function resetAnomalyDetector(): void {
  _instance = null;
}
