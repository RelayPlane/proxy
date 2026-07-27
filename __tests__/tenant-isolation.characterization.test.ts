/**
 * Characterization tests for src/tenant-isolation.ts (TenantIsolator).
 *
 * These tests pin CURRENT behavior as observed by reading and executing the
 * code. They are not a spec of intended behavior. Notable pinned quirks:
 * - Unknown tenants are allowed by default (open proxy mode).
 * - A request with estimatedCostUsd 0 is allowed even when the tenant is
 *   already over its daily budget (only positive estimates can block).
 * - deleteTenant() removes the config but leaves dated spend records behind
 *   because spend keys are `${tenantId}:${date}` while the delete uses the
 *   bare tenant id.
 * - Header resolution only recognizes the lowercase 'x-tenant-id' key.
 *
 * Determinism: Date is frozen via vi.useFakeTimers (toFake: ['Date']) so
 * "today" and all ISO stamps are exact. Persistence goes to per-test temp
 * paths. Randomness in buildRequestContext is asserted by shape only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TenantIsolator,
  getTenantIsolator,
  resetTenantIsolator,
} from '../src/tenant-isolation.js';
import type { TenantIsolatorOptions } from '../src/tenant-isolation.js';

const T0 = '2026-01-15T12:00:00.000Z';
const T1 = '2026-01-15T15:45:00.000Z';

let testDir = '';
let opts: TenantIsolatorOptions = {};
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  testDir = path.join(os.tmpdir(), `rp-ti-char-${process.pid}-${testCounter}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env['RELAYPLANE_HOME_OVERRIDE'] = testDir;
  opts = {
    configPath: path.join(testDir, 'tenants.json'),
    spendStorePath: path.join(testDir, 'tenant-spend.json'),
  };
  resetTenantIsolator();
  vi.useFakeTimers({ now: new Date(T0), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  resetTenantIsolator();
  delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('TenantIsolator tenant CRUD (characterization)', () => {
  it('upsertTenant() stamps created_at/updated_at, stores tier and label verbatim, and preserves created_at on update', () => {
    const iso = new TenantIsolator(opts);
    const created = iso.upsertTenant('acme', { label: 'Acme Corp', tier: 'pro' });

    expect(created).toEqual({
      label: 'Acme Corp',
      tier: 'pro',
      created_at: T0,
      updated_at: T0,
    });

    vi.setSystemTime(new Date(T1));
    const updated = iso.upsertTenant('acme', { label: 'Acme Corp v2', tier: 'enterprise' });
    expect(updated.created_at).toBe(T0);
    expect(updated.updated_at).toBe(T1);
    expect(updated.tier).toBe('enterprise');
    expect(iso.getTenant('acme')).toEqual(updated);
  });

  it('getTenant() returns undefined and deleteTenant() returns false for unknown tenants', () => {
    const iso = new TenantIsolator(opts);
    expect(iso.getTenant('nope')).toBeUndefined();
    expect(iso.deleteTenant('nope')).toBe(false);
    expect(iso.listTenants()).toEqual([]);
  });

  it('deleteTenant() removes the config but leaves dated spend records behind (spend keys include the date)', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('leaky', { label: 'Leaky', tier: 'free' });
    iso.recordSpend('leaky', 4);
    expect(iso.getDailySpend('leaky')).toBe(4);

    expect(iso.deleteTenant('leaky')).toBe(true);
    expect(iso.getTenant('leaky')).toBeUndefined();
    // Quirk: spend survives deletion because the delete key lacks the date suffix
    expect(iso.getDailySpend('leaky')).toBe(4);
  });
});

describe('TenantIsolator.extractTenantId (characterization)', () => {
  it('the x-tenant-id header wins over an API key prefix match, and an array header uses its first element', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('keyed', {
      label: 'Keyed',
      tier: 'starter',
      tags: { api_key_prefix: 'sk-keyed-' },
    });

    expect(iso.extractTenantId({ 'x-tenant-id': 'header-tenant' }, 'sk-keyed-123')).toBe(
      'header-tenant'
    );
    expect(iso.extractTenantId({ 'x-tenant-id': ['first', 'second'] })).toBe('first');
  });

  it('with no header, a registered tags.api_key_prefix resolves the tenant from the API key', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('beta', {
      label: 'Beta',
      tier: 'max',
      tags: { api_key_prefix: 'sk-beta-' },
    });

    expect(iso.extractTenantId({}, 'sk-beta-abc123')).toBe('beta');
    expect(iso.extractTenantId({}, 'sk-other-abc123')).toBe('default');
  });

  it("falls back to 'default' when nothing matches; only the lowercase header key is recognized", () => {
    const iso = new TenantIsolator(opts);
    expect(iso.extractTenantId({})).toBe('default');
    expect(iso.extractTenantId({ 'X-Tenant-Id': 'acme' })).toBe('default');
    // Empty string header is falsy, so it also falls through to 'default'
    expect(iso.extractTenantId({ 'x-tenant-id': '' })).toBe('default');
  });
});

describe('TenantIsolator.checkRequest (characterization)', () => {
  it('an unknown tenant is allowed by default with a bare result (open proxy mode)', () => {
    const iso = new TenantIsolator(opts);
    expect(iso.checkRequest('ghost', 'any-model', 999)).toEqual({
      allowed: true,
      tenant_id: 'ghost',
    });
  });

  it('an active kill-switch blocks the request and takes precedence over model checks', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('killed', {
      label: 'Killed',
      tier: 'pro',
      kill_switch: true,
      denied_models: ['gpt-4'],
    });

    const result = iso.checkRequest('killed', 'gpt-4');
    expect(result).toEqual({
      allowed: false,
      tenant_id: 'killed',
      kill_switch_active: true,
      reason: 'Kill-switch is active for this tenant.',
    });
    // The kill-switch reason wins; model_denied is never set
    expect(result.model_denied).toBeUndefined();
  });

  it('a non-empty allowlist blocks unlisted models; an empty allowlist allows any model', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('listed', {
      label: 'Listed',
      tier: 'pro',
      allowed_models: ['claude-3'],
    });
    iso.upsertTenant('open', {
      label: 'Open',
      tier: 'pro',
      allowed_models: [],
    });

    const blocked = iso.checkRequest('listed', 'gpt-4');
    expect(blocked.allowed).toBe(false);
    expect(blocked.model_denied).toBe(true);
    expect(blocked.reason).toBe("Model 'gpt-4' is not in the allowlist for tenant 'listed'.");

    expect(iso.checkRequest('listed', 'claude-3').allowed).toBe(true);
    // No model given skips the model checks entirely
    expect(iso.checkRequest('listed').allowed).toBe(true);
    // Empty allowlist array is treated as "all models allowed"
    expect(iso.checkRequest('open', 'anything').allowed).toBe(true);
  });

  it('the denylist blocks a model even when it is also on the allowlist', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('conflicted', {
      label: 'Conflicted',
      tier: 'pro',
      allowed_models: ['m1', 'm2'],
      denied_models: ['m2'],
    });

    const result = iso.checkRequest('conflicted', 'm2');
    expect(result.allowed).toBe(false);
    expect(result.model_denied).toBe(true);
    expect(result.reason).toBe("Model 'm2' is denied for tenant 'conflicted'.");
  });

  it('daily budget boundary: spend + estimate equal to the cap is allowed, strictly over is blocked', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('budgeted', {
      label: 'Budgeted',
      tier: 'starter',
      budget_usd_per_day: 10,
    });
    iso.recordSpend('budgeted', 3);
    iso.recordSpend('budgeted', 2);
    expect(iso.getDailySpend('budgeted')).toBe(5);

    // 5 + 5 = 10, which is NOT > 10, so it is allowed
    expect(iso.checkRequest('budgeted', undefined, 5)).toEqual({
      allowed: true,
      tenant_id: 'budgeted',
      daily_spend_usd: 5,
      daily_budget_remaining_usd: 5,
    });

    // 5 + 5.5 = 10.5 > 10, blocked with budget fields populated
    expect(iso.checkRequest('budgeted', undefined, 5.5)).toEqual({
      allowed: false,
      tenant_id: 'budgeted',
      budget_exceeded: true,
      daily_spend_usd: 5,
      daily_budget_remaining_usd: 5,
      reason: "Daily budget of $10 exceeded for tenant 'budgeted'.",
    });
  });

  it('a zero estimated cost is allowed even when already over budget, and remaining is clamped to 0', () => {
    const iso = new TenantIsolator(opts);
    iso.upsertTenant('overspent', {
      label: 'Overspent',
      tier: 'free',
      budget_usd_per_day: 10,
    });
    iso.recordSpend('overspent', 12);

    // Only a positive estimatedCostUsd can trip the budget check
    expect(iso.checkRequest('overspent', undefined, 0)).toEqual({
      allowed: true,
      tenant_id: 'overspent',
      daily_spend_usd: 12,
      daily_budget_remaining_usd: 0,
    });

    const blocked = iso.checkRequest('overspent', undefined, 0.01);
    expect(blocked.allowed).toBe(false);
    expect(blocked.budget_exceeded).toBe(true);
    expect(blocked.daily_budget_remaining_usd).toBe(0);
  });
});

describe('TenantIsolator spend tracking (characterization)', () => {
  it('recordSpend() accumulates spend and request_count under a tenant:date key with the frozen clock', () => {
    const iso = new TenantIsolator(opts);
    iso.recordSpend('spender', 1.5);
    iso.recordSpend('spender', 2.5);

    expect(iso.getDailySpend('spender')).toBe(4);
    expect(iso.getDailySpend('someone-else')).toBe(0);

    const raw = JSON.parse(fs.readFileSync(opts.spendStorePath!, 'utf-8')) as Record<
      string,
      { spend_usd: number; request_count: number; date: string; last_request_at: string }
    >;
    const record = raw['spender:2026-01-15'];
    expect(record).toBeDefined();
    expect(record.spend_usd).toBe(4);
    expect(record.request_count).toBe(2);
    expect(record.date).toBe('2026-01-15');
    expect(record.last_request_at).toBe(T0);
  });

  it('a fresh isolator on the same paths restores tenants, kill-switch state, and spend (round trip)', () => {
    const first = new TenantIsolator(opts);
    first.upsertTenant('locked', {
      label: 'Locked Out',
      tier: 'enterprise',
      kill_switch: true,
      kill_switch_reason: 'incident',
    });
    first.recordSpend('locked', 2);

    const second = new TenantIsolator(opts);
    expect(second.getTenant('locked')?.tier).toBe('enterprise');
    expect(second.getTenant('locked')?.kill_switch_reason).toBe('incident');
    expect(second.getDailySpend('locked')).toBe(2);

    // The kill-switch cache is seeded from persisted config on load
    const check = second.checkRequest('locked');
    expect(check.allowed).toBe(false);
    expect(check.kill_switch_active).toBe(true);
  });
});

describe('TenantIsolator request context and singleton (characterization)', () => {
  it('buildRequestContext() emits trace_/req_ hex ids and the frozen timestamp', () => {
    const iso = new TenantIsolator(opts);
    const ctx = iso.buildRequestContext('acme');

    expect(ctx.tenant_id).toBe('acme');
    expect(ctx.trace_id).toMatch(/^trace_[0-9a-f]{16}$/);
    expect(ctx.request_id).toMatch(/^req_[0-9a-f]{12}$/);
    expect(ctx.timestamp).toBe(T0);

    // Ids are freshly generated per call
    const ctx2 = iso.buildRequestContext('acme');
    expect(ctx2.trace_id).not.toBe(ctx.trace_id);
  });

  it('getTenantIsolator() memoizes (later options are ignored); resetTenantIsolator() forces a new instance', () => {
    const a = getTenantIsolator(opts);
    const b = getTenantIsolator({ configPath: path.join(testDir, 'other.json') });
    expect(b).toBe(a);

    resetTenantIsolator();
    const c = getTenantIsolator(opts);
    expect(c).not.toBe(a);
  });
});
