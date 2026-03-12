/**
 * Adaptive Provider Recovery — Phase 2: Mesh Sharing
 *
 * Shares provider recovery/health patterns across proxy instances via the mesh layer.
 * When one instance discovers a provider is down or degraded, other instances learn from it.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type {
  RecoveryPattern,
  RecoveryPatternType,
  RecoveryPatternStore,
} from './recovery.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A recovery atom shared via the mesh.
 * Contains only non-sensitive pattern data (no tokens, keys, prompts).
 */
export interface RecoveryAtom {
  /** Unique ID for this atom (deterministic from type+provider+trigger) */
  id: string;
  /** Atom type discriminator for the mesh */
  atomType: 'recovery';
  /** Recovery pattern type */
  type: RecoveryPatternType;
  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;
  /** Trigger conditions for this pattern */
  trigger: {
    errorCode: number;
    errorType?: string;
    tokenPrefix?: string;
    model?: string;
    minTokens?: number;
  };
  /** Fix to apply when trigger matches */
  fix: {
    authHeader?: string;
    model?: string;
    timeoutMs?: number;
    provider?: string;
  };
  /** Confidence score 0-1, aggregated across reports */
  confidence: number;
  /** Number of instances that reported this pattern */
  reportCount: number;
  /** Number of confirmed successful applications across instances */
  confirmCount: number;
  /** Number of confirmed failures across instances */
  denyCount: number;
  /** ISO timestamp of first discovery */
  firstSeen: string;
  /** ISO timestamp of last report/confirmation */
  lastSeen: string;
  /** ISO timestamp of last successful confirmation */
  lastConfirmed?: string;
  /** Instance hash that first discovered this pattern */
  originInstance: string;
  /** Version counter for conflict resolution (last-write-wins with merge) */
  version: number;
}

/** Result of a mesh recovery sync operation */
export interface MeshRecoverySyncResult {
  /** Number of patterns pushed to mesh */
  pushed: number;
  /** Number of patterns pulled from mesh */
  pulled: number;
  /** Number of patterns merged (conflict resolved) */
  merged: number;
  /** Number of patterns expired/removed */
  expired: number;
  /** Errors encountered */
  errors: string[];
  /** Timestamp of this sync */
  timestamp: string;
}

/** Configuration for mesh recovery sharing */
export interface MeshRecoveryConfig {
  /** URL of the mesh server */
  meshUrl: string;
  /** API key for mesh authentication */
  apiKey?: string;
  /** Unique hash identifying this proxy instance (anonymous) */
  instanceHash: string;
  /** Minimum local confidence before sharing to mesh (default: 0.7) */
  minShareConfidence: number;
  /** Minimum local success count before sharing (default: 3) */
  minShareSuccessCount: number;
  /** Minimum mesh report count for preemptive application (default: 2) */
  minMeshReportCount: number;
  /** Minimum mesh confidence for preemptive application (default: 0.6) */
  minMeshConfidence: number;
  /** Pattern expiry in days without confirmation (default: 30) */
  expiryDays: number;
  /** Maximum patterns to push per sync (default: 50) */
  maxPushPerSync: number;
  /** Rate limit: minimum seconds between syncs (default: 60) */
  minSyncIntervalSec: number;
}

export const DEFAULT_MESH_RECOVERY_CONFIG: MeshRecoveryConfig = {
  meshUrl: '',
  instanceHash: 'unknown',
  minShareConfidence: 0.7,
  minShareSuccessCount: 3,
  minMeshReportCount: 2,
  minMeshConfidence: 0.6,
  expiryDays: 30,
  maxPushPerSync: 50,
  minSyncIntervalSec: 60,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a deterministic atom ID from pattern properties using SHA-256 */
export function recoveryAtomId(type: RecoveryPatternType, provider: string, trigger: RecoveryAtom['trigger']): string {
  const parts: (string | number)[] = [type, provider, trigger.errorCode];
  if (trigger.tokenPrefix) parts.push(trigger.tokenPrefix);
  if (trigger.model) parts.push(trigger.model);
  if (trigger.errorType) parts.push(trigger.errorType);
  return `recovery:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

/** Convert a local RecoveryPattern to a mesh RecoveryAtom */
export function patternToAtom(pattern: RecoveryPattern, instanceHash: string): RecoveryAtom {
  return {
    id: recoveryAtomId(pattern.type, pattern.provider, pattern.trigger),
    atomType: 'recovery',
    type: pattern.type,
    provider: pattern.provider,
    trigger: { ...pattern.trigger },
    fix: { ...pattern.fix },
    confidence: pattern.confidence,
    reportCount: 1,
    confirmCount: pattern.successCount,
    denyCount: pattern.failureCount,
    firstSeen: pattern.firstSeen,
    lastSeen: pattern.lastSeen,
    lastConfirmed: pattern.lastApplied,
    originInstance: instanceHash,
    version: 1,
  };
}

/** Convert a mesh RecoveryAtom to a local RecoveryPattern */
export function atomToPattern(atom: RecoveryAtom): RecoveryPattern {
  return {
    id: atom.id,
    type: atom.type,
    provider: atom.provider,
    trigger: { ...atom.trigger },
    fix: { ...atom.fix },
    confidence: atom.confidence,
    successCount: atom.confirmCount,
    failureCount: atom.denyCount,
    firstSeen: atom.firstSeen,
    lastSeen: atom.lastSeen,
    lastApplied: atom.lastConfirmed,
  };
}

// ─── Conflict Resolution ──────────────────────────────────────────────────────

/**
 * Merge two recovery atoms with conflict resolution.
 *
 * Strategy: "aggregate-and-recalculate"
 * - Report/confirm/deny counts are summed
 * - Confidence is recalculated from aggregated counts
 * - Timestamps use earliest firstSeen, latest lastSeen
 * - Version incremented
 * - If fixes differ, the one with higher confirmCount wins
 */
export function mergeRecoveryAtoms(local: RecoveryAtom, remote: RecoveryAtom): RecoveryAtom {
  // If they're not the same atom, return remote (shouldn't happen but be safe)
  if (local.id !== remote.id) return remote;

  // Aggregate counts — but avoid double-counting if this instance already contributed
  // We use Math.max for report counts from the same origin, sum for different origins
  const totalConfirm = Math.max(local.confirmCount, remote.confirmCount);
  const totalDeny = Math.max(local.denyCount, remote.denyCount);
  const totalReports = Math.max(local.reportCount, remote.reportCount);

  // Recalculate confidence from aggregated data
  const totalAttempts = totalConfirm + totalDeny;
  const confidence = totalAttempts > 0 ? totalConfirm / totalAttempts : 0;

  // Use the fix with more confirmations
  const fix = local.confirmCount >= remote.confirmCount ? local.fix : remote.fix;

  return {
    id: local.id,
    atomType: 'recovery',
    type: local.type,
    provider: local.provider,
    trigger: local.trigger,
    fix,
    confidence,
    reportCount: totalReports + (local.originInstance !== remote.originInstance ? 1 : 0),
    confirmCount: totalConfirm,
    denyCount: totalDeny,
    firstSeen: local.firstSeen < remote.firstSeen ? local.firstSeen : remote.firstSeen,
    lastSeen: local.lastSeen > remote.lastSeen ? local.lastSeen : remote.lastSeen,
    lastConfirmed: newerTimestamp(local.lastConfirmed, remote.lastConfirmed),
    originInstance: local.originInstance, // keep local origin
    version: Math.max(local.version, remote.version) + 1,
  };
}

function newerTimestamp(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ─── Mesh Recovery Atom Store ─────────────────────────────────────────────────

/**
 * Stores recovery atoms for mesh sharing.
 * Separate from the local RecoveryPatternStore to keep mesh vs local concerns clean.
 */
export class MeshRecoveryAtomStore {
  private atoms: Map<string, RecoveryAtom> = new Map();
  private readonly expiryDays: number;

  constructor(expiryDays = 30) {
    this.expiryDays = expiryDays;
  }

  /** Get all non-expired atoms */
  getAll(): RecoveryAtom[] {
    this.pruneExpired();
    return Array.from(this.atoms.values());
  }

  /** Get a specific atom by ID */
  get(id: string): RecoveryAtom | undefined {
    this.pruneExpired();
    return this.atoms.get(id);
  }

  /** Upsert with merge semantics */
  upsert(atom: RecoveryAtom): RecoveryAtom {
    const existing = this.atoms.get(atom.id);
    if (existing) {
      const merged = mergeRecoveryAtoms(existing, atom);
      this.atoms.set(atom.id, merged);
      return merged;
    }
    this.atoms.set(atom.id, atom);
    return atom;
  }

  /** Remove an atom */
  remove(id: string): boolean {
    return this.atoms.delete(id);
  }

  /** Get atoms modified since a timestamp */
  getSince(since: string): RecoveryAtom[] {
    this.pruneExpired();
    return Array.from(this.atoms.values()).filter(a => a.lastSeen > since);
  }

  /** Record a local confirmation of a mesh pattern */
  recordConfirmation(id: string): void {
    const atom = this.atoms.get(id);
    if (atom) {
      atom.confirmCount++;
      atom.confidence = atom.confirmCount / (atom.confirmCount + atom.denyCount);
      atom.lastConfirmed = new Date().toISOString();
      atom.lastSeen = new Date().toISOString();
      atom.version++;
    }
  }

  /** Record a local denial of a mesh pattern */
  recordDenial(id: string): void {
    const atom = this.atoms.get(id);
    if (atom) {
      atom.denyCount++;
      atom.confidence = atom.confirmCount / (atom.confirmCount + atom.denyCount);
      atom.lastSeen = new Date().toISOString();
      atom.version++;
    }
  }

  /** Get stats */
  stats(): { total: number; highConfidence: number; avgConfidence: number; totalReports: number } {
    const all = this.getAll();
    return {
      total: all.length,
      highConfidence: all.filter(a => a.confidence >= 0.8).length,
      avgConfidence: all.length > 0
        ? all.reduce((sum, a) => sum + a.confidence, 0) / all.length
        : 0,
      totalReports: all.reduce((sum, a) => sum + a.reportCount, 0),
    };
  }

  /** Prune atoms that haven't been seen in expiryDays */
  pruneExpired(): number {
    const cutoff = Date.now() - this.expiryDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [key, atom] of this.atoms) {
      const lastActivity = atom.lastConfirmed ?? atom.lastSeen;
      if (new Date(lastActivity).getTime() < cutoff) {
        this.atoms.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /** Clear all atoms */
  clear(): void {
    this.atoms.clear();
  }

  /** Get count */
  get size(): number {
    return this.atoms.size;
  }
}

// ─── Mesh Recovery Sync ───────────────────────────────────────────────────────

/**
 * Handles syncing recovery patterns between a local RecoveryPatternStore
 * and the mesh via the mesh server's recovery endpoints.
 */
export class MeshRecoverySync {
  private readonly config: MeshRecoveryConfig;
  private readonly meshStore: MeshRecoveryAtomStore;
  private lastSyncTimestamp?: string;
  private lastSyncAt = 0; // unix ms — for rate limiting

  constructor(config: Partial<MeshRecoveryConfig> & { meshUrl: string; instanceHash: string }) {
    this.config = { ...DEFAULT_MESH_RECOVERY_CONFIG, ...config };
    this.meshStore = new MeshRecoveryAtomStore(this.config.expiryDays);
  }

  /** Get the mesh atom store (for testing/inspection) */
  getMeshStore(): MeshRecoveryAtomStore {
    return this.meshStore;
  }

  /**
   * Push eligible local patterns to the mesh.
   * Only shares patterns that meet minimum confidence and success count.
   */
  async pushPatterns(localStore: RecoveryPatternStore): Promise<{
    pushed: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    const eligible = localStore.getAll().filter(p =>
      p.confidence >= this.config.minShareConfidence &&
      p.successCount >= this.config.minShareSuccessCount
    );

    if (eligible.length === 0) {
      return { pushed: 0, errors: [] };
    }

    // Convert to atoms and limit
    const atoms = eligible
      .slice(0, this.config.maxPushPerSync)
      .map(p => patternToAtom(p, this.config.instanceHash));

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      const res = await fetch(`${this.config.meshUrl}/mesh/recovery/contribute`, {
        method: 'POST',
        headers,
        body: JSON.stringify(atoms),
      });

      if (!res.ok) {
        const errBody = await res.text();
        errors.push(`Push failed: ${res.status} ${errBody}`);
        return { pushed: 0, errors };
      }

      const body = await res.json() as { accepted: number; results: Array<{ id: string; status: string }> };

      // Update local mesh store with push results
      for (const atom of atoms) {
        this.meshStore.upsert(atom);
      }

      return { pushed: body.accepted, errors: [] };
    } catch (err: any) {
      errors.push(`Push error: ${err.message}`);
      return { pushed: 0, errors };
    }
  }

  /**
   * Pull recovery patterns from the mesh and merge into local store.
   * Applies conflict resolution when patterns overlap.
   */
  async pullPatterns(localStore: RecoveryPatternStore): Promise<{
    pulled: number;
    merged: number;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      const url = this.lastSyncTimestamp
        ? `${this.config.meshUrl}/mesh/recovery/atoms?since=${encodeURIComponent(this.lastSyncTimestamp)}`
        : `${this.config.meshUrl}/mesh/recovery/atoms`;

      const headers: Record<string, string> = {};
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errBody = await res.text();
        errors.push(`Pull failed: ${res.status} ${errBody}`);
        return { pulled: 0, merged: 0, errors };
      }

      const remoteAtoms = await res.json() as RecoveryAtom[];
      let pulled = 0;
      let merged = 0;

      for (const remoteAtom of remoteAtoms) {
        // Validate the atom has required fields
        if (!remoteAtom.id || !remoteAtom.type || !remoteAtom.provider) continue;

        // Update mesh store (handles merge)
        const existing = this.meshStore.get(remoteAtom.id);
        this.meshStore.upsert(remoteAtom);

        if (existing) {
          merged++;
        } else {
          pulled++;
        }

        // Apply to local pattern store if it meets our thresholds
        if (
          remoteAtom.reportCount >= this.config.minMeshReportCount &&
          remoteAtom.confidence >= this.config.minMeshConfidence
        ) {
          const localPattern = atomToPattern(remoteAtom);
          localStore.upsert(localPattern);
        }
      }

      this.lastSyncTimestamp = new Date().toISOString();
      return { pulled, merged, errors: [] };
    } catch (err: any) {
      errors.push(`Pull error: ${err.message}`);
      return { pulled: 0, merged: 0, errors };
    }
  }

  /**
   * Full sync: push local patterns, then pull from mesh.
   * Respects rate limiting.
   */
  async sync(localStore: RecoveryPatternStore): Promise<MeshRecoverySyncResult> {
    const now = Date.now();
    const minInterval = this.config.minSyncIntervalSec * 1000;

    if (now - this.lastSyncAt < minInterval) {
      return {
        pushed: 0,
        pulled: 0,
        merged: 0,
        expired: 0,
        errors: ['Rate limited: sync too frequent'],
        timestamp: new Date().toISOString(),
      };
    }

    this.lastSyncAt = now;

    const pushResult = await this.pushPatterns(localStore);
    const pullResult = await this.pullPatterns(localStore);

    // Prune expired patterns
    const expired = this.meshStore.pruneExpired();

    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      merged: pullResult.merged,
      expired,
      errors: [...pushResult.errors, ...pullResult.errors],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Report a local confirmation of a mesh-sourced pattern.
   * Called when a pattern pulled from mesh works locally.
   */
  async reportConfirmation(patternId: string): Promise<void> {
    this.meshStore.recordConfirmation(patternId);

    // Asynchronously report to mesh (best effort)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      await fetch(`${this.config.meshUrl}/mesh/recovery/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          patternId,
          instanceHash: this.config.instanceHash,
          success: true,
        }),
      });
    } catch {
      // Best effort — don't fail on confirmation report
    }
  }

  /**
   * Report a local denial of a mesh-sourced pattern.
   * Called when a pattern pulled from mesh fails locally.
   */
  async reportDenial(patternId: string): Promise<void> {
    this.meshStore.recordDenial(patternId);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      await fetch(`${this.config.meshUrl}/mesh/recovery/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          patternId,
          instanceHash: this.config.instanceHash,
          success: false,
        }),
      });
    } catch {
      // Best effort
    }
  }

  /** Get sync status for dashboard */
  getStatus(): {
    meshStore: ReturnType<MeshRecoveryAtomStore['stats']>;
    lastSync: string | undefined;
    config: { meshUrl: string; minShareConfidence: number; minMeshReportCount: number };
  } {
    return {
      meshStore: this.meshStore.stats(),
      lastSync: this.lastSyncTimestamp,
      config: {
        meshUrl: this.config.meshUrl,
        minShareConfidence: this.config.minShareConfidence,
        minMeshReportCount: this.config.minMeshReportCount,
      },
    };
  }
}
