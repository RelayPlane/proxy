/**
 * TDD Phase 1 — failing tests for per-tenant cost partitioning
 *
 * Task: rp-tenant-cost-partition
 * Acceptance:
 *   - CostLedger stores rows tagged with tenant_id
 *   - queryCost(tenantId, range) returns only that tenant's costs
 *   - byModel breakdown sums correctly per tenant
 *   - byDay breakdown matches actual call timestamps
 *   - Two tenants A and B have fully isolated cost views
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// This module does not exist yet — importing it will fail the test suite.
import {
  CostLedger,
  type CostRecord,
  type CostQueryResult,
} from '../src/cost-ledger.js';

let testDir = '';
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  testDir = path.join(os.tmpdir(), `rp-cost-ledger-${process.pid}-${testCounter}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env['RELAYPLANE_HOME_OVERRIDE'] = testDir;
});

afterEach(() => {
  delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('CostLedger — per-tenant isolation', () => {
  it('records a cost row tagged with tenant_id', () => {
    const ledger = new CostLedger();

    ledger.record({
      tenantId: 'tenant-a',
      model: 'claude-sonnet-4-6',
      costUsd: 0.001234,
      requestCount: 1,
      timestamp: new Date('2026-04-26T10:00:00Z'),
    });

    const result = ledger.query('tenant-a', 'all');
    expect(result.totalUsd).toBeCloseTo(0.001234, 6);
    expect(result.requestCount).toBe(1);
  });

  it('tenant A and tenant B have isolated cost views', () => {
    const ledger = new CostLedger();

    ledger.record({
      tenantId: 'tenant-a',
      model: 'claude-sonnet-4-6',
      costUsd: 0.01,
      requestCount: 1,
      timestamp: new Date('2026-04-26T10:00:00Z'),
    });
    ledger.record({
      tenantId: 'tenant-b',
      model: 'claude-opus-4-7',
      costUsd: 0.05,
      requestCount: 1,
      timestamp: new Date('2026-04-26T10:01:00Z'),
    });
    ledger.record({
      tenantId: 'tenant-a',
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.002,
      requestCount: 2,
      timestamp: new Date('2026-04-26T10:02:00Z'),
    });

    const resultA = ledger.query('tenant-a', 'all');
    const resultB = ledger.query('tenant-b', 'all');

    // Tenant A: 0.01 + 0.002 = 0.012; 3 requests
    expect(resultA.totalUsd).toBeCloseTo(0.012, 6);
    expect(resultA.requestCount).toBe(3);

    // Tenant B: 0.05; 1 request
    expect(resultB.totalUsd).toBeCloseTo(0.05, 6);
    expect(resultB.requestCount).toBe(1);
  });

  it('byModel breakdown is accurate and isolated per tenant', () => {
    const ledger = new CostLedger();

    ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.01, requestCount: 1, timestamp: new Date('2026-04-26T10:00:00Z') });
    ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.02, requestCount: 1, timestamp: new Date('2026-04-26T10:01:00Z') });
    ledger.record({ tenantId: 'tenant-a', model: 'claude-opus-4-7', costUsd: 0.1, requestCount: 1, timestamp: new Date('2026-04-26T10:02:00Z') });
    ledger.record({ tenantId: 'tenant-b', model: 'claude-sonnet-4-6', costUsd: 0.99, requestCount: 5, timestamp: new Date('2026-04-26T10:03:00Z') });

    const resultA = ledger.query('tenant-a', 'all');

    expect(resultA.byModel['claude-sonnet-4-6']).toBeCloseTo(0.03, 6);
    expect(resultA.byModel['claude-opus-4-7']).toBeCloseTo(0.1, 6);
    // tenant-b's sonnet costs must NOT appear in tenant-a's result
    expect(resultA.byModel['claude-sonnet-4-6']).not.toBeCloseTo(0.99 + 0.03, 1);
  });

  it('byDay breakdown matches actual call timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));
    try {
      const ledger = new CostLedger();

      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.01, requestCount: 1, timestamp: new Date('2026-04-24T09:00:00Z') });
      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.02, requestCount: 1, timestamp: new Date('2026-04-25T12:00:00Z') });
      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.03, requestCount: 1, timestamp: new Date('2026-04-26T08:00:00Z') });

      const result = ledger.query('tenant-a', '7d');

      expect(result.byDay['2026-04-24']).toBeCloseTo(0.01, 6);
      expect(result.byDay['2026-04-25']).toBeCloseTo(0.02, 6);
      expect(result.byDay['2026-04-26']).toBeCloseTo(0.03, 6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('range=7d excludes records older than 7 days', () => {
    const now = new Date('2026-04-26T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const ledger = new CostLedger();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.5, requestCount: 1, timestamp: eightDaysAgo });
      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.1, requestCount: 1, timestamp: threeDaysAgo });

      const result = ledger.query('tenant-a', '7d');

      expect(result.totalUsd).toBeCloseTo(0.1, 6);
      expect(result.requestCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('range=30d excludes records older than 30 days', () => {
    const now = new Date('2026-04-26T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const ledger = new CostLedger();
      const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);

      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.5, requestCount: 1, timestamp: thirtyOneDaysAgo });
      ledger.record({ tenantId: 'tenant-a', model: 'claude-sonnet-4-6', costUsd: 0.2, requestCount: 1, timestamp: fifteenDaysAgo });

      const result = ledger.query('tenant-a', '30d');

      expect(result.totalUsd).toBeCloseTo(0.2, 6);
      expect(result.requestCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unknown tenant returns zeroed result', () => {
    const ledger = new CostLedger();

    const result = ledger.query('nonexistent-tenant', 'all');

    expect(result.totalUsd).toBe(0);
    expect(result.requestCount).toBe(0);
    expect(result.byModel).toEqual({});
    expect(result.byDay).toEqual({});
  });

  it('persists records across CostLedger instances', () => {
    const ledger1 = new CostLedger();
    ledger1.record({
      tenantId: 'tenant-a',
      model: 'claude-sonnet-4-6',
      costUsd: 0.0042,
      requestCount: 1,
      timestamp: new Date('2026-04-26T10:00:00Z'),
    });

    // New instance — should load from disk
    const ledger2 = new CostLedger();
    const result = ledger2.query('tenant-a', 'all');

    expect(result.totalUsd).toBeCloseTo(0.0042, 6);
  });
});

describe('CostLedger — CostRecord and CostQueryResult types', () => {
  it('CostRecord has required fields', () => {
    const record: CostRecord = {
      tenantId: 'tenant-a',
      model: 'claude-sonnet-4-6',
      costUsd: 0.001,
      requestCount: 1,
      timestamp: new Date(),
    };
    expect(record.tenantId).toBeDefined();
    expect(record.model).toBeDefined();
    expect(record.costUsd).toBeDefined();
    expect(record.requestCount).toBeDefined();
    expect(record.timestamp).toBeDefined();
  });

  it('CostQueryResult has required fields', () => {
    const ledger = new CostLedger();
    const result: CostQueryResult = ledger.query('any-tenant', 'all');

    expect(typeof result.totalUsd).toBe('number');
    expect(typeof result.requestCount).toBe('number');
    expect(typeof result.byModel).toBe('object');
    expect(typeof result.byDay).toBe('object');
  });
});
