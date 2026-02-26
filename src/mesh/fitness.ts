/**
 * Osmosis Knowledge Mesh — Fitness Scoring
 * Adapted from ~/osmosis/packages/core/src/fitness/
 */

import { MeshStore } from './store.js';

/**
 * fitness = usage_rate × success_ratio × recency_factor
 */
export function computeFitness(
  useCount: number,
  successAfterUse: number,
  failureAfterUse: number,
  lastUsed: string | null,
  maxUseCount: number,
  now: Date = new Date(),
): number {
  const usageRate = maxUseCount > 0 ? useCount / maxUseCount : 0;
  const total = successAfterUse + failureAfterUse;
  const successRatio = total > 0 ? successAfterUse / total : 0.5;
  const daysSinceUse = lastUsed
    ? Math.max(0, (now.getTime() - new Date(lastUsed).getTime()) / 86_400_000)
    : 30;
  const recencyFactor = Math.exp(-0.05 * daysSinceUse);
  return Math.min(1, Math.max(0, usageRate * successRatio * recencyFactor));
}

/**
 * Batch-recalculate fitness for all atoms.
 */
export function recalculateFitness(store: MeshStore): void {
  const atoms = store.getAll();
  let maxUseCount = 1;
  for (const a of atoms) {
    const uc = (a as any).use_count ?? 0;
    if (uc > maxUseCount) maxUseCount = uc;
  }
  const now = new Date();
  for (const atom of atoms) {
    const a = atom as any;
    const score = computeFitness(
      a.use_count ?? 0,
      a.success_after_use ?? 0,
      a.failure_after_use ?? 0,
      a.last_used ?? null,
      maxUseCount,
      now,
    );
    store.updateFitness(atom.id, score);
  }
}
