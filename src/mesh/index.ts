/**
 * Osmosis Knowledge Mesh — Integrated into RelayPlane Proxy
 *
 * Self-contained mesh learning layer: capture, store, fitness, sync.
 * No external mesh packages required.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MeshStore } from './store.js';
import { captureRequest } from './capture.js';
import { recalculateFitness } from './fitness.js';
import { MeshSyncManager, syncWithMesh } from './sync.js';
import type { CaptureEvent, SyncResult } from './types.js';

export { MeshStore } from './store.js';
export { captureRequest } from './capture.js';
export { computeFitness, recalculateFitness } from './fitness.js';
export { pushToMesh, pullFromMesh, syncWithMesh, MeshSyncManager } from './sync.js';
export type { KnowledgeAtom, CaptureEvent, SyncResult } from './types.js';

export interface MeshConfig {
  enabled: boolean;
  endpoint: string;
  sync_interval_ms: number;
  contribute: boolean;
  db_path?: string;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  enabled: true,
  endpoint: 'https://osmosis-mesh-dev.fly.dev',
  sync_interval_ms: 60000,
  contribute: true,
};

export interface MeshHandle {
  captureRequest(event: CaptureEvent): void;
  getStats(): MeshStats;
  forceSync(): Promise<SyncResult>;
  stop(): void;
}

export interface MeshStats {
  enabled: boolean;
  atoms_local: number;
  atoms_synced: number;
  last_sync: string | null;
  endpoint: string;
}

/**
 * Initialize the integrated mesh layer.
 * Returns a handle for capture/stats/sync, or a no-op if disabled.
 */
export function initMeshLayer(config: MeshConfig, apiKey?: string): MeshHandle {
  const noopHandle: MeshHandle = {
    captureRequest() {},
    getStats() {
      return { enabled: false, atoms_local: 0, atoms_synced: 0, last_sync: null, endpoint: config.endpoint };
    },
    async forceSync() {
      return { pushed: 0, pulled: 0, deduped: 0, errors: ['Mesh disabled'], timestamp: new Date().toISOString() };
    },
    stop() {},
  };

  if (!config.enabled) return noopHandle;

  const dbDir = config.db_path
    ? config.db_path.substring(0, config.db_path.lastIndexOf('/'))
    : join(process.env.HOME ?? '/root', '.relayplane');
  const dbPath = config.db_path ?? join(dbDir, 'mesh.db');

  try {
    mkdirSync(dbDir, { recursive: true });
  } catch {}

  let store: MeshStore;
  try {
    store = new MeshStore(dbPath);
  } catch (err) {
    console.error(`[MESH] Failed to open store at ${dbPath}: ${err}`);
    return noopHandle;
  }

  // Start sync manager if contributing
  let syncManager: MeshSyncManager | null = null;
  if (config.contribute) {
    syncManager = new MeshSyncManager(store, config.endpoint, config.sync_interval_ms, apiKey);
    syncManager.start();
    console.log(`[MESH] Sync started (interval: ${config.sync_interval_ms / 1000}s, endpoint: ${config.endpoint})`);
  }

  // Periodic fitness recalculation (every 5 min)
  const fitnessTimer = setInterval(() => {
    try { recalculateFitness(store); } catch {}
  }, 300_000);
  fitnessTimer.unref();

  console.log(`[MESH] Knowledge mesh initialized (db: ${dbPath})`);

  return {
    captureRequest(event: CaptureEvent) {
      try {
        captureRequest(store, event);
      } catch (err) {
        // Never block proxy for mesh errors
      }
    },

    getStats(): MeshStats {
      return {
        enabled: true,
        atoms_local: store.count(),
        atoms_synced: store.countSynced(),
        last_sync: syncManager?.getLastSyncTime() ?? store.getLastSyncTime(config.endpoint),
        endpoint: config.endpoint,
      };
    },

    async forceSync(): Promise<SyncResult> {
      if (syncManager) {
        return syncManager.doSync();
      }
      return syncWithMesh(store, config.endpoint, apiKey);
    },

    stop() {
      syncManager?.stop();
      clearInterval(fitnessTimer);
      try { store.close(); } catch {}
    },
  };
}
