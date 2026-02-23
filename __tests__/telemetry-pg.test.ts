import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pg module before importing the module under test
const mockQuery = vi.fn();
const mockEnd = vi.fn();
const MockPool = vi.fn(() => ({
  query: mockQuery,
  end: mockEnd,
}));

vi.mock('pg', () => ({
  default: { Pool: MockPool },
  Pool: MockPool,
}));

// Must import AFTER mock setup
import {
  initPgBackend,
  isPgActive,
  recordHistoryPg,
  updateHistoryPg,
  getHistoryPg,
  getStatsPg,
  getHistoryCountPg,
  closePg,
} from '../src/telemetry-pg.js';

describe('telemetry-pg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by closing any existing pool
    // Note: closePg sets pool=null and initialized=false
  });

  afterEach(async () => {
    await closePg();
    delete process.env['RELAYPLANE_TELEMETRY_DB'];
  });

  describe('initPgBackend', () => {
    it('returns false when RELAYPLANE_TELEMETRY_DB is not set', async () => {
      delete process.env['RELAYPLANE_TELEMETRY_DB'];
      const result = await initPgBackend();
      expect(result).toBe(false);
      expect(isPgActive()).toBe(false);
    });

    it('creates pool and table when env var is set', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValueOnce({}); // CREATE TABLE
      const result = await initPgBackend();
      expect(result).toBe(true);
      expect(isPgActive()).toBe(true);
      expect(MockPool).toHaveBeenCalledWith({
        connectionString: 'postgresql://localhost/test',
        max: 5,
      });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS request_history'));
    });

    it('handles connection failure gracefully', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://bad-host/test';
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await initPgBackend();
      expect(result).toBe(false);
      expect(isPgActive()).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('recordHistoryPg', () => {
    it('inserts with correct SQL and params', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValue({});
      await initPgBackend();

      const entry = {
        requestId: 'req-1',
        consumer: 'claude-code',
        originalModel: 'claude-opus-4-20250514',
        targetModel: 'claude-3-5-haiku-20241022',
        provider: 'anthropic',
        latencyMs: 250,
        success: true,
        mode: 'complexity',
        escalated: false,
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.001,
        taskType: 'quick_task',
        complexity: 'simple',
        timestamp: '2025-01-01T00:00:00.000Z',
      };

      recordHistoryPg(entry);

      // The INSERT query is async fire-and-forget — give it a tick
      await new Promise(r => setTimeout(r, 10));

      // Find the INSERT call (skip the CREATE TABLE call from init)
      const insertCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO request_history'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toEqual([
        'req-1',
        'claude-code',
        'claude-opus-4-20250514',
        'claude-3-5-haiku-20241022',
        'anthropic',
        250,
        true,
        'complexity',
        false,
        100,
        200,
        0.001,
        'quick_task',
        'simple',
        '2025-01-01T00:00:00.000Z',
      ]);
    });

    it('does nothing when pool is not active', () => {
      // No init — pool is null
      recordHistoryPg({
        requestId: 'req-1',
        consumer: 'test',
        originalModel: 'test',
        targetModel: 'test',
        provider: 'test',
        latencyMs: 0,
        success: true,
        mode: 'test',
        escalated: false,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        taskType: 'general',
        complexity: 'simple',
        timestamp: new Date().toISOString(),
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('updateHistoryPg', () => {
    it('updates tokens and cost for a request_id', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValue({});
      await initPgBackend();

      updateHistoryPg('req-42', 500, 1000, 0.05);

      await new Promise(r => setTimeout(r, 10));

      const updateCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE request_history'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual([500, 1000, 0.05, 'req-42']);
    });
  });

  describe('getHistoryPg', () => {
    it('returns parsed entries', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValueOnce({}); // CREATE TABLE
      await initPgBackend();

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            request_id: 'req-1',
            consumer: 'test-app',
            original_model: 'claude-opus-4-20250514',
            target_model: 'claude-3-5-haiku-20241022',
            provider: 'anthropic',
            latency_ms: 200,
            success: true,
            mode: 'complexity',
            escalated: false,
            tokens_in: 100,
            tokens_out: 300,
            cost_usd: '0.002',
            task_type: 'quick_task',
            complexity: 'simple',
            timestamp: new Date('2025-01-01T00:00:00Z'),
          },
        ],
      });

      const entries = await getHistoryPg(10, 0);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        requestId: 'req-1',
        consumer: 'test-app',
        originalModel: 'claude-opus-4-20250514',
        targetModel: 'claude-3-5-haiku-20241022',
        provider: 'anthropic',
        latencyMs: 200,
        success: true,
        mode: 'complexity',
        escalated: false,
        tokensIn: 100,
        tokensOut: 300,
        costUsd: 0.002,
        taskType: 'quick_task',
        complexity: 'simple',
        timestamp: '2025-01-01T00:00:00.000Z',
      });
    });

    it('returns empty array when pool is not active', async () => {
      const entries = await getHistoryPg();
      expect(entries).toEqual([]);
    });
  });

  describe('getStatsPg', () => {
    it('returns aggregated stats', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValueOnce({}); // CREATE TABLE
      await initPgBackend();

      // Summary query
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 50, cost: '1.25', avg_lat: 300, success_rate: '0.96' }],
      });
      // By model query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { model: 'claude-3-5-haiku-20241022', count: 40, cost: '0.5' },
          { model: 'claude-sonnet-4-20250514', count: 10, cost: '0.75' },
        ],
      });
      // By consumer query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { consumer: 'claude-code', count: 30, cost: '0.8' },
          { consumer: 'openclaw', count: 20, cost: '0.45' },
        ],
      });

      const stats = await getStatsPg(7);
      expect(stats.totalEvents).toBe(50);
      expect(stats.totalCostUsd).toBe(1.25);
      expect(stats.avgLatencyMs).toBe(300);
      expect(stats.successRate).toBe(0.96);
      expect(stats.byModel).toHaveLength(2);
      expect(stats.byModel[0]!.model).toBe('claude-3-5-haiku-20241022');
      expect(stats.byConsumer).toHaveLength(2);
      expect(stats.byConsumer[0]!.consumer).toBe('claude-code');
    });

    it('returns empty stats when pool is not active', async () => {
      const stats = await getStatsPg();
      expect(stats.totalEvents).toBe(0);
      expect(stats.byModel).toEqual([]);
    });
  });

  describe('getHistoryCountPg', () => {
    it('returns total row count', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValueOnce({}); // CREATE TABLE
      await initPgBackend();

      mockQuery.mockResolvedValueOnce({ rows: [{ count: 123 }] });
      const count = await getHistoryCountPg();
      expect(count).toBe(123);
    });
  });

  describe('closePg', () => {
    it('closes the pool and resets state', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValueOnce({});
      await initPgBackend();
      expect(isPgActive()).toBe(true);

      await closePg();
      expect(isPgActive()).toBe(false);
      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe('consumer field', () => {
    it('stores and retrieves consumer in records', async () => {
      process.env['RELAYPLANE_TELEMETRY_DB'] = 'postgresql://localhost/test';
      mockQuery.mockResolvedValue({});
      await initPgBackend();

      recordHistoryPg({
        requestId: 'req-1',
        consumer: 'my-special-consumer',
        originalModel: 'test',
        targetModel: 'test',
        provider: 'test',
        latencyMs: 100,
        success: true,
        mode: 'test',
        escalated: false,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.001,
        taskType: 'general',
        complexity: 'simple',
        timestamp: new Date().toISOString(),
      });

      await new Promise(r => setTimeout(r, 10));

      const insertCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO request_history'),
      );
      expect(insertCall).toBeDefined();
      // Consumer is the 2nd param
      expect(insertCall![1][1]).toBe('my-special-consumer');
    });
  });
});
