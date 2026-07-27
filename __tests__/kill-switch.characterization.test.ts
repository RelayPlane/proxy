/**
 * Characterization tests for src/kill-switch.ts (KillSwitchManager).
 *
 * These tests pin CURRENT behavior as observed by reading and executing the
 * code. They are not a spec of what the module "should" do. If one of these
 * fails after a source change, the behavior changed, decide deliberately
 * whether that change was intended before touching the test.
 *
 * Determinism: Date is frozen via vi.useFakeTimers (toFake: ['Date']) so
 * every ISO timestamp the module stamps is exact and assertable.
 * All persistence goes to a per-test temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  KillSwitchManager,
  getKillSwitchManager,
  resetKillSwitchManager,
} from '../src/kill-switch.js';
import type { KillSwitchStore } from '../src/kill-switch.js';

const T0 = '2026-01-15T12:00:00.000Z';
const T1 = '2026-01-15T13:30:00.000Z';

let testDir = '';
let storePath = '';
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  testDir = path.join(os.tmpdir(), `rp-ks-char-${process.pid}-${testCounter}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env['RELAYPLANE_HOME_OVERRIDE'] = testDir;
  storePath = path.join(testDir, 'kill-switches.json');
  resetKillSwitchManager();
  vi.useFakeTimers({ now: new Date(T0), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  resetKillSwitchManager();
  delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('KillSwitchManager activation (characterization)', () => {
  it('activate() returns a full entry stamped with the current clock and flips isActive to true', () => {
    const mgr = new KillSwitchManager(storePath);
    expect(mgr.isActive('tenant-a')).toBe(false);

    const entry = mgr.activate('tenant-a', { reason: 'runaway loop', activated_by: 'ops' });

    expect(entry).toEqual({
      tenant_id: 'tenant-a',
      active: true,
      reason: 'runaway loop',
      activated_at: T0,
      activated_by: 'ops',
    });
    expect(mgr.isActive('tenant-a')).toBe(true);
    expect(mgr.getEntry('tenant-a')).toEqual(entry);
  });

  it('activate() with no options leaves reason and activated_by undefined', () => {
    const mgr = new KillSwitchManager(storePath);
    const entry = mgr.activate('tenant-bare');
    expect(entry.reason).toBeUndefined();
    expect(entry.activated_by).toBeUndefined();
    expect(entry.active).toBe(true);
  });

  it('isActive() and getEntry() report false/undefined for tenants never seen', () => {
    const mgr = new KillSwitchManager(storePath);
    expect(mgr.isActive('never-seen')).toBe(false);
    expect(mgr.getEntry('never-seen')).toBeUndefined();
  });
});

describe('KillSwitchManager lift (characterization)', () => {
  it('lift() returns false when no kill-switch is active for the tenant', () => {
    const mgr = new KillSwitchManager(storePath);
    expect(mgr.lift('nobody')).toBe(false);
    // Lifting an unknown tenant leaves no entry behind
    expect(mgr.getEntry('nobody')).toBeUndefined();
  });

  it('lift() deactivates, preserves activation metadata, and stamps lifted fields', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('tenant-b', { reason: 'billing spike', activated_by: 'anomaly-bot' });

    vi.setSystemTime(new Date(T1));
    const result = mgr.lift('tenant-b', { lifted_by: 'matt' });

    expect(result).toBe(true);
    expect(mgr.isActive('tenant-b')).toBe(false);
    expect(mgr.getEntry('tenant-b')).toEqual({
      tenant_id: 'tenant-b',
      active: false,
      reason: 'billing spike',
      activated_at: T0,
      activated_by: 'anomaly-bot',
      lifted_at: T1,
      lifted_by: 'matt',
    });
  });

  it('lift() on an already-lifted tenant returns false and does not restamp', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('tenant-c');
    expect(mgr.lift('tenant-c')).toBe(true);

    vi.setSystemTime(new Date(T1));
    expect(mgr.lift('tenant-c')).toBe(false);
    expect(mgr.getEntry('tenant-c')?.lifted_at).toBe(T0);
  });

  it('re-activating after a lift replaces the entry and drops the lifted_at/lifted_by fields', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('tenant-d', { reason: 'first' });
    mgr.lift('tenant-d', { lifted_by: 'someone' });

    vi.setSystemTime(new Date(T1));
    const entry = mgr.activate('tenant-d', { reason: 'second' });

    expect(entry.active).toBe(true);
    expect(entry.reason).toBe('second');
    expect(entry.activated_at).toBe(T1);
    expect(entry).not.toHaveProperty('lifted_at');
    expect(entry).not.toHaveProperty('lifted_by');
  });
});

describe('KillSwitchManager listing (characterization)', () => {
  it('listAll() includes lifted entries while listActive() filters to active only', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('alive');
    mgr.activate('dead');
    mgr.lift('dead');

    const allIds = mgr.listAll().map(e => e.tenant_id).sort();
    expect(allIds).toEqual(['alive', 'dead']);

    const active = mgr.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].tenant_id).toBe('alive');
    expect(active[0].active).toBe(true);
  });
});

describe('KillSwitchManager blocked response payload (characterization)', () => {
  it('buildBlockedResponse() for an active tenant echoes reason and activation time', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('tenant-e', { reason: 'security incident' });

    expect(mgr.buildBlockedResponse('tenant-e')).toEqual({
      error: {
        type: 'kill_switch_active',
        message: "All traffic for tenant 'tenant-e' has been suspended.",
        tenant_id: 'tenant-e',
        activated_at: T0,
        reason: 'security incident',
        contact: 'Contact your RelayPlane administrator to lift the kill-switch.',
      },
    });
  });

  it('buildBlockedResponse() for an unknown tenant still builds a payload with a default reason', () => {
    const mgr = new KillSwitchManager(storePath);
    const payload = mgr.buildBlockedResponse('ghost') as {
      error: { reason: string; activated_at?: string; tenant_id: string };
    };
    expect(payload.error.reason).toBe('No reason provided.');
    expect(payload.error.activated_at).toBeUndefined();
    expect(payload.error.tenant_id).toBe('ghost');
  });
});

describe('KillSwitchManager persistence (characterization)', () => {
  it('activate() writes the store atomically: final file present, no .tmp left behind, updated_at stamped', () => {
    const mgr = new KillSwitchManager(storePath);
    mgr.activate('tenant-f', { reason: 'persist me' });

    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(storePath + '.tmp')).toBe(false);

    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as KillSwitchStore;
    expect(store.updated_at).toBe(T0);
    expect(store.entries['tenant-f']).toEqual({
      tenant_id: 'tenant-f',
      active: true,
      reason: 'persist me',
      activated_at: T0,
    });
  });

  it('a fresh manager on the same store path restores active state and entries (round trip)', () => {
    const first = new KillSwitchManager(storePath);
    first.activate('survivor', { reason: 'restart me', activated_by: 'ops' });

    const second = new KillSwitchManager(storePath);
    expect(second.isActive('survivor')).toBe(true);
    expect(second.getEntry('survivor')).toEqual({
      tenant_id: 'survivor',
      active: true,
      reason: 'restart me',
      activated_at: T0,
      activated_by: 'ops',
    });
    expect(second.listActive().map(e => e.tenant_id)).toEqual(['survivor']);
  });

  it('a lifted entry round-trips as inactive history, not as an active switch', () => {
    const first = new KillSwitchManager(storePath);
    first.activate('was-killed');
    first.lift('was-killed', { lifted_by: 'admin' });

    const second = new KillSwitchManager(storePath);
    expect(second.isActive('was-killed')).toBe(false);
    expect(second.listActive()).toEqual([]);
    expect(second.getEntry('was-killed')?.active).toBe(false);
    expect(second.getEntry('was-killed')?.lifted_by).toBe('admin');
  });

  it('a corrupt store file is ignored: the manager starts empty without throwing', () => {
    fs.writeFileSync(storePath, 'this is {{ not json');

    let mgr: KillSwitchManager | undefined;
    expect(() => {
      mgr = new KillSwitchManager(storePath);
    }).not.toThrow();
    expect(mgr!.listAll()).toEqual([]);
    expect(mgr!.isActive('anyone')).toBe(false);
  });
});

describe('kill-switch singleton (characterization)', () => {
  it('getKillSwitchManager() memoizes; resetKillSwitchManager() forces a new instance', () => {
    const a = getKillSwitchManager(storePath);
    const b = getKillSwitchManager(path.join(testDir, 'other.json'));
    // Second call ignores its storePath argument and returns the cached instance
    expect(b).toBe(a);

    resetKillSwitchManager();
    const c = getKillSwitchManager(storePath);
    expect(c).not.toBe(a);
  });
});
