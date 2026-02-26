/**
 * Osmosis Knowledge Mesh — Mesh Sync
 * Push local atoms to mesh server, pull high-fitness atoms back.
 */

import type { KnowledgeAtom, SyncResult } from './types.js';
import { MeshStore } from './store.js';

/**
 * Push unsynced atoms to the mesh endpoint.
 */
export async function pushToMesh(
  store: MeshStore,
  endpoint: string,
  apiKey?: string,
): Promise<SyncResult> {
  const errors: string[] = [];
  const now = new Date().toISOString();
  const toSync = store.getUnsynced();

  if (toSync.length === 0) {
    store.setLastPushAt(endpoint, now);
    return { pushed: 0, pulled: 0, deduped: 0, errors: [], timestamp: now };
  }

  let pushed = 0;
  let deduped = 0;

  try {
    const payload = toSync.map(({ id, created_at, updated_at, synced, ...rest }) => rest);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${endpoint}/atoms/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const body = await res.json() as { accepted?: number; results?: Array<{ id: string; status: string }> };
      pushed = body.accepted ?? toSync.length;
      store.markSynced(toSync.map(a => a.id));
    } else {
      const errBody = await res.text();
      errors.push(`Push failed: ${res.status} ${errBody}`);
    }
  } catch (err: any) {
    errors.push(`Push error: ${err.message}`);
  }

  store.setLastPushAt(endpoint, now);
  return { pushed, pulled: 0, deduped, errors, timestamp: now };
}

/**
 * Pull high-fitness atoms from the mesh.
 */
export async function pullFromMesh(
  store: MeshStore,
  endpoint: string,
  apiKey?: string,
): Promise<SyncResult> {
  const errors: string[] = [];
  const now = new Date().toISOString();
  const since = store.getLastPullAt(endpoint);

  try {
    const url = since
      ? `${endpoint}/atoms?since=${encodeURIComponent(since)}`
      : `${endpoint}/atoms`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const errBody = await res.text();
      return { pushed: 0, pulled: 0, deduped: 0, errors: [`Pull failed: ${res.status} ${errBody}`], timestamp: now };
    }

    const remoteAtoms = await res.json() as KnowledgeAtom[];
    let pulled = 0;
    for (const atom of remoteAtoms) {
      try {
        const { id, created_at, updated_at, synced, ...data } = atom as any;
        store.insert({ ...data, synced: true });
        pulled++;
      } catch (err: any) {
        errors.push(`Pull insert error: ${err.message}`);
      }
    }

    store.setLastPullAt(endpoint, now);
    return { pushed: 0, pulled, deduped: 0, errors, timestamp: now };
  } catch (err: any) {
    return { pushed: 0, pulled: 0, deduped: 0, errors: [`Pull error: ${err.message}`], timestamp: now };
  }
}

/**
 * Run a full sync cycle (push then pull).
 */
export async function syncWithMesh(
  store: MeshStore,
  endpoint: string,
  apiKey?: string,
): Promise<SyncResult> {
  const pushResult = await pushToMesh(store, endpoint, apiKey);
  const pullResult = await pullFromMesh(store, endpoint, apiKey);
  return {
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    deduped: pushResult.deduped + pullResult.deduped,
    errors: [...pushResult.errors, ...pullResult.errors],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Auto-sync manager. Starts interval-based sync.
 */
export class MeshSyncManager {
  private timer: NodeJS.Timeout | null = null;
  private lastSync: string | null = null;
  private lastErrors: string[] = [];

  constructor(
    private store: MeshStore,
    private endpoint: string,
    private intervalMs: number,
    private apiKey?: string,
  ) {}

  start(): void {
    if (this.timer) return;
    // Initial sync after short delay
    setTimeout(() => this.doSync(), 5000);
    this.timer = setInterval(() => this.doSync(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async doSync(): Promise<SyncResult> {
    const result = await syncWithMesh(this.store, this.endpoint, this.apiKey);
    this.lastSync = result.timestamp;
    this.lastErrors = result.errors;
    if (result.errors.length > 0) {
      console.log(`[MESH] Sync errors: ${result.errors.join('; ')}`);
    } else if (result.pushed > 0 || result.pulled > 0) {
      console.log(`[MESH] Synced: pushed ${result.pushed}, pulled ${result.pulled}`);
    }
    return result;
  }

  getLastSyncTime(): string | null {
    return this.lastSync;
  }

  getLastErrors(): string[] {
    return this.lastErrors;
  }
}
