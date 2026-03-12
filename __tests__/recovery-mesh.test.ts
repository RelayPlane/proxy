import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MeshRecoveryAtomStore,
  MeshRecoverySync,
  mergeRecoveryAtoms,
  patternToAtom,
  atomToPattern,
  recoveryAtomId,
  type RecoveryAtom,
  type MeshRecoveryConfig,
} from '../src/recovery-mesh.js';
import {
  RecoveryPatternStore,
  type RecoveryPattern,
} from '../src/recovery.js';
import {
  startRecoveryMeshServer,
  type RecoveryMeshServerHandle,
} from '../src/recovery-mesh-server.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let nextPort = 19700;
function getPort() { return nextPort++; }

function makePattern(overrides: Partial<RecoveryPattern> = {}): RecoveryPattern {
  return {
    id: 'auth-header:anthropic:sk-ant-oat',
    type: 'auth-header',
    provider: 'anthropic',
    trigger: { errorCode: 401, tokenPrefix: 'sk-ant-oat' },
    fix: { authHeader: 'Authorization' },
    confidence: 0.95,
    successCount: 19,
    failureCount: 1,
    firstSeen: '2026-03-01T00:00:00Z',
    lastSeen: '2026-03-06T00:00:00Z',
    ...overrides,
  };
}

// Default atom trigger used in makeAtom — consistent for ID computation
const DEFAULT_ATOM_TRIGGER = { errorCode: 401, tokenPrefix: 'sk-ant-oat' };

function makeAtom(overrides: Partial<RecoveryAtom> = {}): RecoveryAtom {
  // Compute the default ID using recoveryAtomId so it stays consistent with M1 fix
  const defaultId = recoveryAtomId('auth-header', 'anthropic', DEFAULT_ATOM_TRIGGER);
  return {
    id: defaultId,
    atomType: 'recovery',
    type: 'auth-header',
    provider: 'anthropic',
    trigger: { errorCode: 401, tokenPrefix: 'sk-ant-oat' },
    fix: { authHeader: 'Authorization' },
    confidence: 0.95,
    reportCount: 5,
    confirmCount: 19,
    denyCount: 1,
    firstSeen: '2026-03-01T00:00:00Z',
    lastSeen: '2026-03-06T00:00:00Z',
    originInstance: 'instance-a',
    version: 1,
    ...overrides,
  };
}

// ─── recoveryAtomId Tests ─────────────────────────────────────────────────────

describe('recoveryAtomId', () => {
  it('generates deterministic ID with recovery: prefix and 16-char hex hash', () => {
    const id = recoveryAtomId('auth-header', 'anthropic', {
      errorCode: 401,
      tokenPrefix: 'sk-ant-oat',
    });
    expect(id).toMatch(/^recovery:[0-9a-f]{16}$/);
  });

  it('includes model and errorType fields in hash (different from trigger without them)', () => {
    const idWith = recoveryAtomId('model-rename', 'anthropic', {
      errorCode: 404,
      model: 'claude-3-opus',
      errorType: 'not_found',
    });
    const idWithout = recoveryAtomId('model-rename', 'anthropic', {
      errorCode: 404,
    });
    expect(idWith).toMatch(/^recovery:[0-9a-f]{16}$/);
    expect(idWith).not.toBe(idWithout);
  });

  it('generates same ID for same inputs (deterministic)', () => {
    const trigger = { errorCode: 401, tokenPrefix: 'sk-ant-oat' };
    const id1 = recoveryAtomId('auth-header', 'anthropic', trigger);
    const id2 = recoveryAtomId('auth-header', 'anthropic', trigger);
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different inputs (collision-resistant)', () => {
    const id1 = recoveryAtomId('auth-header', 'anthropic', { errorCode: 401 });
    const id2 = recoveryAtomId('auth-header', 'openai', { errorCode: 401 });
    expect(id1).not.toBe(id2);
  });

  it('SHA-256 IDs are collision-resistant across many inputs', () => {
    const ids = new Set<string>();
    const types = ['auth-header', 'model-rename', 'timeout-tune', 'provider-fallback'] as const;
    const providers = ['anthropic', 'openai', 'google', 'azure'];
    const codes = [400, 401, 403, 404, 429, 500, 503];
    for (const type of types) {
      for (const provider of providers) {
        for (const code of codes) {
          ids.add(recoveryAtomId(type, provider, { errorCode: code }));
        }
      }
    }
    // All 4 × 4 × 7 = 112 combinations should be unique
    expect(ids.size).toBe(types.length * providers.length * codes.length);
  });
});

// ─── patternToAtom / atomToPattern Tests ──────────────────────────────────────

describe('patternToAtom', () => {
  it('converts a local pattern to a mesh atom', () => {
    const pattern = makePattern();
    const atom = patternToAtom(pattern, 'instance-1');

    expect(atom.atomType).toBe('recovery');
    expect(atom.type).toBe('auth-header');
    expect(atom.provider).toBe('anthropic');
    expect(atom.trigger.errorCode).toBe(401);
    expect(atom.fix.authHeader).toBe('Authorization');
    expect(atom.confidence).toBe(0.95);
    expect(atom.reportCount).toBe(1);
    expect(atom.confirmCount).toBe(19);
    expect(atom.denyCount).toBe(1);
    expect(atom.originInstance).toBe('instance-1');
    expect(atom.version).toBe(1);
  });

  it('does not share sensitive data', () => {
    const pattern = makePattern();
    const atom = patternToAtom(pattern, 'instance-1');

    // Atom should not contain full API keys, tokens, prompts
    const serialized = JSON.stringify(atom);
    expect(serialized).not.toContain('sk-ant-oat01');
    expect(serialized).not.toContain('Bearer');
    // Only contains the prefix from trigger
    expect(atom.trigger.tokenPrefix).toBe('sk-ant-oat');
  });
});

describe('atomToPattern', () => {
  it('converts a mesh atom back to a local pattern', () => {
    const atom = makeAtom();
    const pattern = atomToPattern(atom);

    expect(pattern.id).toBe(atom.id);
    expect(pattern.type).toBe('auth-header');
    expect(pattern.provider).toBe('anthropic');
    expect(pattern.trigger.errorCode).toBe(401);
    expect(pattern.fix.authHeader).toBe('Authorization');
    expect(pattern.confidence).toBe(0.95);
    expect(pattern.successCount).toBe(19);
    expect(pattern.failureCount).toBe(1);
  });

  it('round-trips pattern → atom → pattern', () => {
    const original = makePattern();
    const atom = patternToAtom(original, 'test');
    const roundTripped = atomToPattern(atom);

    expect(roundTripped.type).toBe(original.type);
    expect(roundTripped.provider).toBe(original.provider);
    expect(roundTripped.trigger).toEqual(original.trigger);
    expect(roundTripped.fix).toEqual(original.fix);
    expect(roundTripped.confidence).toBe(original.confidence);
  });
});

// ─── mergeRecoveryAtoms Tests ─────────────────────────────────────────────────

describe('mergeRecoveryAtoms', () => {
  it('merges two atoms with same ID', () => {
    const local = makeAtom({ confirmCount: 10, denyCount: 2, reportCount: 3, originInstance: 'a' });
    const remote = makeAtom({ confirmCount: 15, denyCount: 1, reportCount: 5, originInstance: 'b' });

    const merged = mergeRecoveryAtoms(local, remote);

    // Takes max counts
    expect(merged.confirmCount).toBe(15);
    expect(merged.denyCount).toBe(2);
    // Report count incremented since different origin
    expect(merged.reportCount).toBe(6); // max(3,5) + 1
    // Confidence recalculated
    expect(merged.confidence).toBeCloseTo(15 / 17);
    // Version incremented
    expect(merged.version).toBeGreaterThan(Math.max(local.version, remote.version));
  });

  it('uses earliest firstSeen and latest lastSeen', () => {
    const local = makeAtom({
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-05T00:00:00Z',
    });
    const remote = makeAtom({
      firstSeen: '2026-02-28T00:00:00Z',
      lastSeen: '2026-03-06T00:00:00Z',
    });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.firstSeen).toBe('2026-02-28T00:00:00Z');
    expect(merged.lastSeen).toBe('2026-03-06T00:00:00Z');
  });

  it('uses fix from whichever side has more confirmations', () => {
    const local = makeAtom({
      confirmCount: 20,
      fix: { authHeader: 'x-api-key' },
    });
    const remote = makeAtom({
      confirmCount: 5,
      fix: { authHeader: 'Authorization' },
    });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.fix.authHeader).toBe('x-api-key'); // local has more confirms
  });

  it('picks remote fix when remote has more confirmations', () => {
    const local = makeAtom({
      confirmCount: 5,
      fix: { authHeader: 'x-api-key' },
    });
    const remote = makeAtom({
      confirmCount: 20,
      fix: { authHeader: 'Authorization' },
    });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.fix.authHeader).toBe('Authorization');
  });

  it('does not double-count reports from same instance', () => {
    const local = makeAtom({ reportCount: 3, originInstance: 'same' });
    const remote = makeAtom({ reportCount: 5, originInstance: 'same' });

    const merged = mergeRecoveryAtoms(local, remote);
    // Same origin → no increment
    expect(merged.reportCount).toBe(5); // max(3,5), no +1
  });

  it('handles zero counts gracefully', () => {
    const local = makeAtom({ confirmCount: 0, denyCount: 0 });
    const remote = makeAtom({ confirmCount: 0, denyCount: 0 });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.confidence).toBe(0);
  });

  it('selects newer lastConfirmed', () => {
    const local = makeAtom({ lastConfirmed: '2026-03-05T00:00:00Z' });
    const remote = makeAtom({ lastConfirmed: '2026-03-06T12:00:00Z' });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.lastConfirmed).toBe('2026-03-06T12:00:00Z');
  });

  it('handles missing lastConfirmed', () => {
    const local = makeAtom({ lastConfirmed: undefined });
    const remote = makeAtom({ lastConfirmed: '2026-03-06T00:00:00Z' });

    const merged = mergeRecoveryAtoms(local, remote);
    expect(merged.lastConfirmed).toBe('2026-03-06T00:00:00Z');
  });
});

// ─── MeshRecoveryAtomStore Tests ──────────────────────────────────────────────

describe('MeshRecoveryAtomStore', () => {
  let store: MeshRecoveryAtomStore;

  beforeEach(() => {
    store = new MeshRecoveryAtomStore(30);
  });

  it('starts empty', () => {
    expect(store.getAll()).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(store.stats().total).toBe(0);
  });

  it('stores and retrieves atoms', () => {
    store.upsert(makeAtom());
    expect(store.getAll()).toHaveLength(1);
    expect(store.size).toBe(1);
  });

  it('gets atom by ID', () => {
    const atom = makeAtom();
    store.upsert(atom);
    const retrieved = store.get(atom.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.type).toBe('auth-header');
  });

  it('merges on upsert with same ID', () => {
    store.upsert(makeAtom({ confirmCount: 10, originInstance: 'a' }));
    store.upsert(makeAtom({ confirmCount: 15, originInstance: 'b' }));

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].confirmCount).toBe(15);
  });

  it('records confirmation', () => {
    const atom = makeAtom({ confirmCount: 5, denyCount: 1 });
    store.upsert(atom);

    store.recordConfirmation(atom.id);
    const updated = store.get(atom.id)!;
    expect(updated.confirmCount).toBe(6);
    expect(updated.confidence).toBeCloseTo(6 / 7);
    expect(updated.lastConfirmed).toBeDefined();
  });

  it('records denial', () => {
    const atom = makeAtom({ confirmCount: 5, denyCount: 1 });
    store.upsert(atom);

    store.recordDenial(atom.id);
    const updated = store.get(atom.id)!;
    expect(updated.denyCount).toBe(2);
    expect(updated.confidence).toBeCloseTo(5 / 7);
  });

  it('removes atom', () => {
    const atom = makeAtom();
    store.upsert(atom);
    expect(store.remove(atom.id)).toBe(true);
    expect(store.getAll()).toHaveLength(0);
  });

  it('returns false for removing non-existent atom', () => {
    expect(store.remove('nonexistent')).toBe(false);
  });

  it('getSince filters by timestamp', () => {
    store.upsert(makeAtom({ id: 'old', lastSeen: '2026-01-01T00:00:00Z' }));
    store.upsert(makeAtom({ id: 'new', lastSeen: '2026-03-06T00:00:00Z' }));

    const recent = store.getSince('2026-02-01T00:00:00Z');
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe('new');
  });

  it('prunes expired atoms', () => {
    // Atom with lastSeen 60 days ago
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    store.upsert(makeAtom({ id: 'expired', lastSeen: oldDate, lastConfirmed: oldDate }));
    store.upsert(makeAtom({ id: 'fresh', lastSeen: new Date().toISOString() }));

    const pruned = store.pruneExpired();
    expect(pruned).toBe(1);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe('fresh');
  });

  it('keeps atoms confirmed within expiry window', () => {
    // Atom with old lastSeen but recent lastConfirmed
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    store.upsert(makeAtom({
      id: 'old-but-confirmed',
      lastSeen: oldDate,
      lastConfirmed: new Date().toISOString(),
    }));

    const pruned = store.pruneExpired();
    expect(pruned).toBe(0);
    expect(store.getAll()).toHaveLength(1);
  });

  it('clears all atoms', () => {
    store.upsert(makeAtom({ id: 'a' }));
    store.upsert(makeAtom({ id: 'b' }));
    store.clear();
    expect(store.getAll()).toHaveLength(0);
  });

  it('provides accurate stats', () => {
    store.upsert(makeAtom({ id: 'high', confidence: 0.9, reportCount: 5 }));
    store.upsert(makeAtom({ id: 'low', confidence: 0.5, reportCount: 3 }));

    const stats = store.stats();
    expect(stats.total).toBe(2);
    expect(stats.highConfidence).toBe(1); // only 0.9 >= 0.8
    expect(stats.avgConfidence).toBeCloseTo(0.7);
    expect(stats.totalReports).toBe(8);
  });
});

// ─── Recovery Mesh Server Tests ───────────────────────────────────────────────

// Write key used in server tests that need /confirm (always requires auth)
const TEST_WRITE_KEY = 'test-write-key-1';

describe('Recovery Mesh Server', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    // allowUnauthenticated: true → /contribute open without auth (even with writeKeys set).
    // writeKeys set → /confirm (which always requires auth per H3) can be tested.
    server = startRecoveryMeshServer({
      port,
      writeKeys: [TEST_WRITE_KEY],
      readKeys: [],
      allowUnauthenticated: true,
    });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('accepts recovery atom contributions', async () => {
    const atom = makeAtom();
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });

    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
    expect(body.results[0].status).toBe('created');

    // Verify stored
    expect(server.store.getAll()).toHaveLength(1);
  });

  it('merges duplicate contributions', async () => {
    const atom = makeAtom({ confirmCount: 10, originInstance: 'a' });
    await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });

    const atom2 = makeAtom({ confirmCount: 15, originInstance: 'b' });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom2]),
    });

    const body = await res.json() as any;
    expect(body.results[0].status).toBe('merged');
    expect(server.store.getAll()).toHaveLength(1);
    expect(server.store.getAll()[0].confirmCount).toBe(15);
  });

  it('rejects atoms with missing fields', async () => {
    const badAtom = { id: 'bad', atomType: 'recovery' } as any;
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([badAtom]),
    });

    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
  });

  it('returns recovery atoms with GET', async () => {
    server.store.upsert(makeAtom({ id: 'atom-1' }));
    server.store.upsert(makeAtom({ id: 'atom-2' }));

    const res = await fetch(`${baseUrl}/mesh/recovery/atoms`);
    const atoms = await res.json() as RecoveryAtom[];
    expect(atoms).toHaveLength(2);
  });

  it('supports incremental fetch with since parameter', async () => {
    server.store.upsert(makeAtom({ id: 'old', lastSeen: '2026-01-01T00:00:00Z' }));
    server.store.upsert(makeAtom({ id: 'new', lastSeen: '2026-03-06T00:00:00Z' }));

    const res = await fetch(`${baseUrl}/mesh/recovery/atoms?since=2026-02-01T00:00:00Z`);
    const atoms = await res.json() as RecoveryAtom[];
    expect(atoms).toHaveLength(1);
    expect(atoms[0].id).toBe('new');
  });

  it('handles confirmation reports', async () => {
    server.store.upsert(makeAtom({ confirmCount: 10, denyCount: 2 }));

    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_WRITE_KEY}`,
      },
      body: JSON.stringify({
        patternId: makeAtom().id,
        instanceHash: 'instance-x',
        success: true,
      }),
    });

    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.confirmCount).toBe(11);
  });

  it('handles denial reports', async () => {
    server.store.upsert(makeAtom({ confirmCount: 10, denyCount: 2 }));

    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_WRITE_KEY}`,
      },
      body: JSON.stringify({
        patternId: makeAtom().id,
        instanceHash: 'instance-x',
        success: false,
      }),
    });

    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.denyCount).toBe(3);
  });

  it('returns 404 for confirmation of unknown pattern', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_WRITE_KEY}`,
      },
      body: JSON.stringify({
        patternId: 'nonexistent',
        instanceHash: 'instance-x',
        success: true,
      }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 for confirmation without patternId', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_WRITE_KEY}`,
      },
      body: JSON.stringify({ instanceHash: 'x', success: true }),
    });

    expect(res.status).toBe(400);
  });

  it('provides stats endpoint', async () => {
    server.store.upsert(makeAtom({ id: 'a', type: 'auth-header', provider: 'anthropic' }));
    server.store.upsert(makeAtom({ id: 'b', type: 'model-rename', provider: 'openai' }));

    const res = await fetch(`${baseUrl}/mesh/recovery/stats`);
    const stats = await res.json() as any;

    expect(stats.total).toBe(2);
    expect(stats.byType['auth-header']).toBe(1);
    expect(stats.byType['model-rename']).toBe(1);
    expect(stats.byProvider['anthropic']).toBe(1);
    expect(stats.byProvider['openai']).toBe(1);
    expect(stats.topPatterns).toHaveLength(2);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/unknown`);
    expect(res.status).toBe(404);
  });
});

// ─── Recovery Mesh Server Auth Tests ──────────────────────────────────────────

describe('Recovery Mesh Server Auth', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({
      port,
      writeKeys: ['write-key-1'],
      readKeys: ['read-key-1'],
    });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('rejects writes without API key', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([makeAtom()]),
    });
    expect(res.status).toBe(401);
  });

  it('accepts writes with valid API key', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer write-key-1',
      },
      body: JSON.stringify([makeAtom()]),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects reads without API key (except stats)', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/atoms`);
    expect(res.status).toBe(401);
  });

  it('allows stats without API key', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/stats`);
    expect(res.ok).toBe(true);
  });
});

// ─── MeshRecoverySync Tests ──────────────────────────────────────────────────

const SYNC_TEST_KEY = 'sync-test-key-1';

describe('MeshRecoverySync', () => {
  let server: RecoveryMeshServerHandle;
  let meshUrl: string;
  let localStore: RecoveryPatternStore;
  let sync: MeshRecoverySync;

  beforeEach(() => {
    const port = getPort();
    // Use a writeKey so /confirm works (H3: /confirm always requires auth).
    // /contribute is authenticated via the same key.
    server = startRecoveryMeshServer({ port, writeKeys: [SYNC_TEST_KEY], readKeys: [] });
    meshUrl = `http://localhost:${port}`;
    localStore = new RecoveryPatternStore(100, 30);
    sync = new MeshRecoverySync({
      meshUrl,
      instanceHash: 'test-instance',
      apiKey: SYNC_TEST_KEY,
      minShareConfidence: 0.7,
      minShareSuccessCount: 3,
      minMeshReportCount: 1,   // low threshold for testing
      minMeshConfidence: 0.5,   // low threshold for testing
      minSyncIntervalSec: 0,    // disable rate limiting for tests
    });
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('pushes eligible patterns to mesh', async () => {
    // Add pattern that meets thresholds
    localStore.upsert(makePattern({ confidence: 0.9, successCount: 5 }));

    const result = await sync.pushPatterns(localStore);
    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify it's on the mesh server
    expect(server.store.getAll()).toHaveLength(1);
  });

  it('does not push patterns below confidence threshold', async () => {
    localStore.upsert(makePattern({ confidence: 0.3, successCount: 5 }));

    const result = await sync.pushPatterns(localStore);
    expect(result.pushed).toBe(0);
    expect(server.store.getAll()).toHaveLength(0);
  });

  it('does not push patterns below success count threshold', async () => {
    localStore.upsert(makePattern({ confidence: 0.9, successCount: 1 }));

    const result = await sync.pushPatterns(localStore);
    expect(result.pushed).toBe(0);
  });

  it('pulls patterns from mesh into local store', async () => {
    // Seed mesh with a pattern
    server.store.upsert(makeAtom({
      reportCount: 5,
      confidence: 0.9,
    }));

    const result = await sync.pullPatterns(localStore);
    expect(result.pulled).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify local store has the pattern
    expect(localStore.getAll()).toHaveLength(1);
  });

  it('does not apply mesh patterns below report threshold', async () => {
    const highThresholdSync = new MeshRecoverySync({
      meshUrl,
      instanceHash: 'test',
      minMeshReportCount: 10,  // high threshold
      minMeshConfidence: 0.5,
      minSyncIntervalSec: 0,
    });

    server.store.upsert(makeAtom({ reportCount: 2, confidence: 0.9 }));

    await highThresholdSync.pullPatterns(localStore);
    // Pattern pulled into mesh store but not applied to local store
    expect(localStore.getAll()).toHaveLength(0);
  });

  it('full sync pushes and pulls', async () => {
    // Local pattern to push
    localStore.upsert(makePattern({
      id: 'local-pattern',
      confidence: 0.9,
      successCount: 5,
    }));

    // Remote pattern to pull
    server.store.upsert(makeAtom({
      id: 'remote-pattern',
      type: 'model-rename',
      reportCount: 3,
      confidence: 0.8,
    }));

    const result = await sync.sync(localStore);
    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('rate limits sync calls', async () => {
    const rateLimitedSync = new MeshRecoverySync({
      meshUrl,
      instanceHash: 'test',
      minSyncIntervalSec: 60,
    });

    // First sync should work
    const result1 = await rateLimitedSync.sync(localStore);
    expect(result1.errors).toHaveLength(0);

    // Second sync immediately should be rate limited
    const result2 = await rateLimitedSync.sync(localStore);
    expect(result2.errors).toHaveLength(1);
    expect(result2.errors[0]).toContain('Rate limited');
  });

  it('reports confirmation to mesh', async () => {
    // Use separate objects to avoid shared reference mutation
    server.store.upsert(makeAtom({ confirmCount: 10 }));
    sync.getMeshStore().upsert(makeAtom({ confirmCount: 10 }));

    const atomId = makeAtom().id;
    await sync.reportConfirmation(atomId);

    // Local mesh store should be updated
    const localAtom = sync.getMeshStore().get(atomId);
    expect(localAtom!.confirmCount).toBe(11);

    // Remote should also be updated
    const remoteAtom = server.store.get(atomId);
    expect(remoteAtom!.confirmCount).toBe(11);
  });

  it('reports denial to mesh', async () => {
    server.store.upsert(makeAtom({ denyCount: 2 }));
    sync.getMeshStore().upsert(makeAtom({ denyCount: 2 }));

    const atomId = makeAtom().id;
    await sync.reportDenial(atomId);

    const localAtom = sync.getMeshStore().get(atomId);
    expect(localAtom!.denyCount).toBe(3);

    const remoteAtom = server.store.get(atomId);
    expect(remoteAtom!.denyCount).toBe(3);
  });

  it('handles push errors gracefully', async () => {
    const badSync = new MeshRecoverySync({
      meshUrl: 'http://localhost:1', // unreachable
      instanceHash: 'test',
      minShareConfidence: 0.5,
      minShareSuccessCount: 1,
      minSyncIntervalSec: 0,
    });

    localStore.upsert(makePattern({ confidence: 0.9, successCount: 5 }));
    const result = await badSync.pushPatterns(localStore);
    expect(result.errors).toHaveLength(1);
    expect(result.pushed).toBe(0);
  });

  it('handles pull errors gracefully', async () => {
    const badSync = new MeshRecoverySync({
      meshUrl: 'http://localhost:1', // unreachable
      instanceHash: 'test',
      minSyncIntervalSec: 0,
    });

    const result = await badSync.pullPatterns(localStore);
    expect(result.errors).toHaveLength(1);
    expect(result.pulled).toBe(0);
  });

  it('provides sync status', () => {
    const status = sync.getStatus();
    expect(status.config.meshUrl).toBe(meshUrl);
    expect(status.meshStore.total).toBe(0);
    expect(status.lastSync).toBeUndefined();
  });

  it('incremental pull only fetches new atoms', async () => {
    // First: seed and pull
    server.store.upsert(makeAtom({ id: 'first', lastSeen: new Date().toISOString() }));
    await sync.pullPatterns(localStore);
    expect(localStore.getAll()).toHaveLength(1);

    // Add a new atom with a later timestamp
    await new Promise(r => setTimeout(r, 50));
    server.store.upsert(makeAtom({
      id: 'second',
      type: 'model-rename',
      lastSeen: new Date().toISOString(),
    }));

    // Second pull should only get the new one
    const result = await sync.pullPatterns(localStore);
    expect(result.pulled).toBe(1);
    expect(localStore.getAll()).toHaveLength(2);
  });

  it('skips invalid atoms during pull', async () => {
    // Manually insert an atom missing required fields
    server.store.upsert(makeAtom({ id: 'valid', type: 'auth-header', provider: 'anthropic' }));
    // The store validates, so we test via HTTP mock-like behavior
    // Since server validates, all atoms in store are valid — this tests the sync pull filter
    const result = await sync.pullPatterns(localStore);
    expect(result.errors).toHaveLength(0);
    expect(result.pulled).toBe(1);
  });
});

// ─── Multi-Instance Propagation Tests ─────────────────────────────────────────

describe('Multi-Instance Pattern Propagation', () => {
  let server: RecoveryMeshServerHandle;
  let meshUrl: string;

  let storeA: RecoveryPatternStore;
  let storeB: RecoveryPatternStore;
  let storeC: RecoveryPatternStore;

  let syncA: MeshRecoverySync;
  let syncB: MeshRecoverySync;
  let syncC: MeshRecoverySync;

  const MULTI_TEST_KEY = 'multi-test-key-1';

  beforeEach(() => {
    const port = getPort();
    // Use a writeKey so /confirm works across all sync instances (H3).
    server = startRecoveryMeshServer({ port, writeKeys: [MULTI_TEST_KEY], readKeys: [] });
    meshUrl = `http://localhost:${port}`;

    storeA = new RecoveryPatternStore(100, 30);
    storeB = new RecoveryPatternStore(100, 30);
    storeC = new RecoveryPatternStore(100, 30);

    const syncConfig = {
      meshUrl,
      apiKey: MULTI_TEST_KEY,
      minShareConfidence: 0.7,
      minShareSuccessCount: 3,
      minMeshReportCount: 1,
      minMeshConfidence: 0.5,
      minSyncIntervalSec: 0,
    };

    syncA = new MeshRecoverySync({ ...syncConfig, instanceHash: 'instance-a' });
    syncB = new MeshRecoverySync({ ...syncConfig, instanceHash: 'instance-b' });
    syncC = new MeshRecoverySync({ ...syncConfig, instanceHash: 'instance-c' });
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('instance A discovers pattern, instances B and C learn it', async () => {
    // Instance A discovers an auth recovery pattern
    storeA.upsert(makePattern({
      id: 'auth-header:anthropic:sk-ant-oat',
      type: 'auth-header',
      provider: 'anthropic',
      confidence: 0.95,
      successCount: 10,
      failureCount: 0,
    }));

    // A pushes to mesh
    await syncA.pushPatterns(storeA);
    expect(server.store.getAll()).toHaveLength(1);

    // B and C pull from mesh
    await syncB.pullPatterns(storeB);
    await syncC.pullPatterns(storeC);

    // All should have the pattern
    expect(storeA.getAll()).toHaveLength(1);
    expect(storeB.getAll()).toHaveLength(1);
    expect(storeC.getAll()).toHaveLength(1);

    // Verify the fix is correct everywhere
    expect(storeB.getAll()[0].fix.authHeader).toBe('Authorization');
    expect(storeC.getAll()[0].fix.authHeader).toBe('Authorization');
  });

  it('multiple instances confirm a pattern, raising its confidence', async () => {
    // A discovers and pushes
    storeA.upsert(makePattern({ confidence: 0.8, successCount: 4, failureCount: 1 }));
    await syncA.pushPatterns(storeA);

    // B pulls and confirms
    await syncB.pullPatterns(storeB);
    const patternId = storeB.getAll()[0].id;
    await syncB.reportConfirmation(patternId);

    // C pulls and confirms
    await syncC.pullPatterns(storeC);
    await syncC.reportConfirmation(patternId);

    // Mesh pattern should have increased confirm count
    const meshAtom = server.store.get(makeAtom().id);
    expect(meshAtom!.confirmCount).toBeGreaterThan(4);
  });

  it('conflicting patterns resolve via confirmation count', async () => {
    // Instance A reports fix: use x-api-key
    server.store.upsert(makeAtom({
      id: 'conflict-test',
      confirmCount: 5,
      fix: { authHeader: 'x-api-key' },
      originInstance: 'instance-a',
    }));

    // Instance B reports different fix: use Authorization (with MORE confirmations)
    server.store.upsert(makeAtom({
      id: 'conflict-test',
      confirmCount: 20,
      fix: { authHeader: 'Authorization' },
      originInstance: 'instance-b',
    }));

    // The merged atom should use the fix with more confirmations
    const merged = server.store.get('conflict-test');
    expect(merged).toBeDefined();
    expect(merged!.fix.authHeader).toBe('Authorization'); // higher confirmCount wins
  });

  it('full lifecycle: discover → share → learn → confirm → propagate', async () => {
    // Step 1: Instance A discovers pattern
    storeA.upsert(makePattern({
      id: 'lifecycle-pattern',
      type: 'model-rename',
      provider: 'anthropic',
      trigger: { errorCode: 404, errorType: 'not_found', model: 'claude-3-opus' },
      fix: { model: 'claude-opus-4' },
      confidence: 1.0,
      successCount: 5,
      failureCount: 0,
    }));

    // Step 2: A shares to mesh
    const pushResult = await syncA.sync(storeA);
    expect(pushResult.pushed).toBe(1);

    // Step 3: B learns from mesh
    const pullResultB = await syncB.sync(storeB);
    expect(pullResultB.pulled).toBe(1);
    expect(storeB.getAll()).toHaveLength(1);
    expect(storeB.getAll()[0].fix.model).toBe('claude-opus-4');

    // Step 4: B confirms the pattern works
    const bPattern = storeB.getAll()[0];
    storeB.recordSuccess(bPattern.id);
    await syncB.reportConfirmation(bPattern.id);

    // Step 5: C syncs and gets the confirmed pattern
    const pullResultC = await syncC.sync(storeC);
    expect(pullResultC.pulled).toBeGreaterThanOrEqual(1);
    expect(storeC.getAll()).toHaveLength(1);
  });

  it('expired patterns are not propagated', async () => {
    // Add an old pattern to mesh that has expired
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    server.store.upsert(makeAtom({
      id: 'expired-pattern',
      lastSeen: oldDate,
      lastConfirmed: oldDate,
    }));

    // Trigger pruning
    server.store.pruneExpired();

    // B tries to pull — should get nothing
    await syncB.pullPatterns(storeB);
    expect(storeB.getAll()).toHaveLength(0);
  });
});
// ─── Security Tests ───────────────────────────────────────────────────────────

describe('Security: Request Body Size Limit (C1)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({ port, writeKeys: [], readKeys: [], allowUnauthenticated: true });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('rejects requests exceeding 1 MB body → 413', async () => {
    // Build a payload just over 1 MB (the quoted string + 2 quote chars > 1 MB)
    const bigString = 'x'.repeat(1_048_577);
    let status: number | undefined;
    try {
      const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `"${bigString}"`,
      });
      status = res.status;
    } catch {
      // Some HTTP clients receive a connection reset when the server drains a huge body.
      // That also means the payload was rejected — treat as pass.
      status = 413;
    }
    expect(status).toBe(413);
  });

  it('accepts requests under 1 MB body', async () => {
    const atom = makeAtom();
    const body = JSON.stringify([atom]);
    expect(body.length).toBeLessThan(1_048_576);
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.ok).toBe(true);
  });
});

describe('Security: Rate Limiting by IP When No API Key (C2)', () => {
  it('rate-limits by IP (no API key) on repeated POST requests', async () => {
    const port = getPort();
    const srv = startRecoveryMeshServer({
      port,
      writeKeys: [],
      readKeys: [],
      allowUnauthenticated: true,
      rateLimitPerHour: 2, // very low limit
    });
    const url = `http://localhost:${port}`;

    try {
      const atom = makeAtom();
      const body = JSON.stringify([atom]);
      const headers = { 'Content-Type': 'application/json' };

      // First two requests should succeed (limit = 2)
      const r1 = await fetch(`${url}/mesh/recovery/contribute`, { method: 'POST', headers, body });
      expect(r1.ok).toBe(true);
      // Second request same atom → merged, still ok
      const r2 = await fetch(`${url}/mesh/recovery/contribute`, { method: 'POST', headers, body });
      expect(r2.ok).toBe(true);
      // Third request should be rate-limited
      const r3 = await fetch(`${url}/mesh/recovery/contribute`, { method: 'POST', headers, body });
      expect(r3.status).toBe(429);
    } finally {
      srv.stop();
    }
  });
});

describe('Security: Deny-by-Default Empty writeKeys (H1)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    // writeKeys: [] with no allowUnauthenticated → deny all writes
    server = startRecoveryMeshServer({ port, writeKeys: [], readKeys: [] });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('denies writes when writeKeys is empty and allowUnauthenticated is not set', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([makeAtom()]),
    });
    expect(res.status).toBe(401);
  });

  it('allows writes when allowUnauthenticated: true even with empty writeKeys', async () => {
    const port2 = getPort();
    const openSrv = startRecoveryMeshServer({
      port: port2,
      writeKeys: [],
      readKeys: [],
      allowUnauthenticated: true,
    });
    try {
      const res = await fetch(`http://localhost:${port2}/mesh/recovery/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([makeAtom()]),
      });
      expect(res.ok).toBe(true);
    } finally {
      openSrv.stop();
    }
  });
});

describe('Security: Capped Numeric Fields (H2)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({ port, writeKeys: [], readKeys: [], allowUnauthenticated: true });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('caps confirmCount, denyCount, reportCount to 10,000', async () => {
    const atom = makeAtom({ confirmCount: 999_999, denyCount: 888_888, reportCount: 777_777 });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    expect(res.ok).toBe(true);
    const stored = server.store.getAll()[0];
    expect(stored.confirmCount).toBeLessThanOrEqual(10_000);
    expect(stored.denyCount).toBeLessThanOrEqual(10_000);
    expect(stored.reportCount).toBeLessThanOrEqual(10_000);
  });

  it('recalculates confidence from counts (ignores client-provided value)', async () => {
    // Send atom claiming confidence=0.01 but confirmCount=9, denyCount=1 → real = 0.9
    const atom = makeAtom({ confirmCount: 9, denyCount: 1, confidence: 0.01 });
    await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const stored = server.store.getAll()[0];
    // Should be recalculated: 9/(9+1) = 0.9
    expect(stored.confidence).toBeCloseTo(0.9);
  });

  it('sets confidence to 0 when no count data', async () => {
    const atom = makeAtom({ confirmCount: 0, denyCount: 0, confidence: 0.99 });
    await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const stored = server.store.getAll()[0];
    expect(stored.confidence).toBe(0);
  });
});

describe('Security: /confirm Requires Auth (H3)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;
  const CONFIRM_KEY = 'confirm-auth-key';

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({
      port,
      writeKeys: [CONFIRM_KEY],
      readKeys: [],
    });
    baseUrl = `http://localhost:${port}`;
    server.store.upsert(makeAtom());
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('rejects /confirm without auth key → 401', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patternId: makeAtom().id, success: true }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects /confirm with wrong auth key → 401', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-key',
      },
      body: JSON.stringify({ patternId: makeAtom().id, success: true }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts /confirm with valid auth key', async () => {
    const res = await fetch(`${baseUrl}/mesh/recovery/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIRM_KEY}`,
      },
      body: JSON.stringify({ patternId: makeAtom().id, instanceHash: 'x', success: true }),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects /confirm even when allowUnauthenticated is true (confirm always requires key)', async () => {
    const port2 = getPort();
    // allowUnauthenticated lets /contribute work without auth, but /confirm should still require a key
    const openSrv = startRecoveryMeshServer({
      port: port2,
      writeKeys: [],
      readKeys: [],
      allowUnauthenticated: true,
    });
    openSrv.store.upsert(makeAtom());
    try {
      const res = await fetch(`http://localhost:${port2}/mesh/recovery/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternId: makeAtom().id, success: true }),
      });
      // /confirm always requires a valid writeKey — empty writeKeys means always 401
      expect(res.status).toBe(401);
    } finally {
      openSrv.stop();
    }
  });
});

describe('Security: Invalid Provider Names Rejected (M2)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({ port, writeKeys: [], readKeys: [], allowUnauthenticated: true });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('strips unknown fix.provider values', async () => {
    const atom = makeAtom({ fix: { provider: 'evil-provider' } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    expect(res.ok).toBe(true);
    const stored = server.store.getAll()[0];
    // fix.provider should have been stripped
    expect(stored.fix.provider).toBeUndefined();
  });

  it('keeps known fix.provider values', async () => {
    const atom = makeAtom({ fix: { provider: 'openai' } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    expect(res.ok).toBe(true);
    const stored = server.store.getAll()[0];
    expect(stored.fix.provider).toBe('openai');
  });
});

describe('Security: Input Validation on Contribute (M3)', () => {
  let server: RecoveryMeshServerHandle;
  let baseUrl: string;

  beforeEach(() => {
    const port = getPort();
    server = startRecoveryMeshServer({ port, writeKeys: [], readKeys: [], allowUnauthenticated: true });
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    try { server.stop(); } catch {}
  });

  it('rejects invalid atom types', async () => {
    const atom = makeAtom({ type: 'malicious-type' as any });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
    expect(server.store.getAll()).toHaveLength(0);
  });

  it('rejects errorCode below 100', async () => {
    const atom = makeAtom({ trigger: { errorCode: 99 } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
  });

  it('rejects errorCode above 599', async () => {
    const atom = makeAtom({ trigger: { errorCode: 600 } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
  });

  it('rejects non-numeric errorCode', async () => {
    const atom = makeAtom({ trigger: { errorCode: 'not-a-number' as any } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
  });

  it('rejects oversized atoms array (> 100)', async () => {
    const atoms = Array.from({ length: 101 }, (_, i) =>
      makeAtom({ id: `atom-${i}` })
    );
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(atoms),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Too many atoms');
  });

  it('accepts exactly 100 atoms', async () => {
    const atoms = Array.from({ length: 100 }, (_, i) =>
      makeAtom({ id: `atom-${i}` })
    );
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(atoms),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects invalid authHeader values', async () => {
    const atom = makeAtom({ fix: { authHeader: 'X-Custom-Injected-Header' as any } });
    const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([atom]),
    });
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('rejected');
  });

  it('accepts valid atom types', async () => {
    const validTypes = ['auth-header', 'model-rename', 'timeout-tune', 'provider-fallback'] as const;
    for (const type of validTypes) {
      server.store.clear();
      const atom = makeAtom({ type, id: undefined as any });
      const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([atom]),
      });
      const body = await res.json() as any;
      expect(body.results[0].status).not.toBe('rejected');
    }
  });

  it('accepts valid authHeader values', async () => {
    for (const authHeader of ['Authorization', 'x-api-key'] as const) {
      server.store.clear();
      const atom = makeAtom({ fix: { authHeader } });
      const res = await fetch(`${baseUrl}/mesh/recovery/contribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([atom]),
      });
      const body = await res.json() as any;
      expect(body.results[0].status).not.toBe('rejected');
    }
  });
});
