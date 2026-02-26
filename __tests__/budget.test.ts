import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BudgetManager, getDailyWindow, getHourlyWindow, DEFAULT_BUDGET_CONFIG } from '../src/budget.js';

describe('Budget Enforcement', () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({
      enabled: true,
      dailyUsd: 50,
      hourlyUsd: 10,
      perRequestUsd: 2,
      onBreach: 'block',
      downgradeTo: 'claude-sonnet-4-6',
      alertThresholds: [50, 80, 95],
    });
    // Don't init() — skip SQLite in tests, use memory-only
  });

  afterEach(() => {
    budget.close();
  });

  describe('Window helpers', () => {
    it('getDailyWindow returns YYYY-MM-DD', () => {
      const w = getDailyWindow();
      expect(w).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('getHourlyWindow returns YYYY-MM-DDTHH', () => {
      const w = getHourlyWindow();
      expect(w).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    });

    it('getDailyWindow with timestamp', () => {
      const ts = new Date('2026-01-15T14:30:00Z').getTime();
      expect(getDailyWindow(ts)).toBe('2026-01-15');
    });

    it('getHourlyWindow with timestamp', () => {
      const ts = new Date('2026-01-15T14:30:00Z').getTime();
      expect(getHourlyWindow(ts)).toBe('2026-01-15T14');
    });
  });

  describe('checkBudget', () => {
    it('allows when under limits', () => {
      const result = budget.checkBudget();
      expect(result.allowed).toBe(true);
      expect(result.breached).toBe(false);
      expect(result.action).toBe('allow');
    });

    it('returns allowed when disabled', () => {
      const disabled = new BudgetManager({ enabled: false });
      const result = disabled.checkBudget();
      expect(result.allowed).toBe(true);
      disabled.close();
    });

    it('blocks when per-request limit exceeded', () => {
      const result = budget.checkBudget(5.0);
      expect(result.allowed).toBe(false);
      expect(result.breached).toBe(true);
      expect(result.breachType).toBe('per-request');
      expect(result.action).toBe('block');
    });

    it('blocks when hourly limit exceeded', () => {
      // Record spend up to the hourly limit
      for (let i = 0; i < 10; i++) {
        budget.recordSpend(1.0, 'claude-sonnet-4-6');
      }
      const result = budget.checkBudget();
      expect(result.breached).toBe(true);
      expect(result.breachType).toBe('hourly');
      expect(result.allowed).toBe(false);
    });

    it('blocks when daily limit exceeded', () => {
      // Set hourly higher so daily triggers first
      budget.updateConfig({ hourlyUsd: 100 });
      for (let i = 0; i < 50; i++) {
        budget.recordSpend(1.0, 'claude-sonnet-4-6');
      }
      const result = budget.checkBudget();
      expect(result.breached).toBe(true);
      expect(result.breachType).toBe('daily');
    });

    it('returns thresholds crossed', () => {
      budget.updateConfig({ hourlyUsd: 100 });
      // Spend 60% of daily
      for (let i = 0; i < 30; i++) {
        budget.recordSpend(1.0, 'claude-sonnet-4-6');
      }
      const result = budget.checkBudget();
      expect(result.thresholdsCrossed).toContain(50);
      expect(result.thresholdsCrossed).not.toContain(80);
    });
  });

  describe('recordSpend', () => {
    it('updates in-memory cache immediately', () => {
      budget.recordSpend(1.5, 'claude-opus-4-6');
      const status = budget.getStatus();
      expect(status.dailySpend).toBe(1.5);
      expect(status.hourlySpend).toBe(1.5);
    });

    it('accumulates spend', () => {
      budget.recordSpend(1.0, 'claude-opus-4-6');
      budget.recordSpend(2.0, 'claude-sonnet-4-6');
      const status = budget.getStatus();
      expect(status.dailySpend).toBe(3.0);
    });

    it('is a no-op when disabled', () => {
      const disabled = new BudgetManager({ enabled: false });
      disabled.recordSpend(100, 'test');
      // Should not throw
      disabled.close();
    });
  });

  describe('getStatus', () => {
    it('returns correct percentages', () => {
      budget.recordSpend(25, 'claude-opus-4-6');
      const status = budget.getStatus();
      expect(status.dailyPercent).toBe(50);
      expect(status.dailyLimit).toBe(50);
    });

    it('detects breach state', () => {
      for (let i = 0; i < 11; i++) {
        budget.recordSpend(1.0, 'test');
      }
      const status = budget.getStatus();
      expect(status.breached).toBe(true);
      expect(status.breachType).toBe('hourly');
    });
  });

  describe('reset', () => {
    it('clears spend cache', () => {
      budget.recordSpend(5.0, 'test');
      budget.reset();
      const status = budget.getStatus();
      expect(status.dailySpend).toBe(0);
      expect(status.hourlySpend).toBe(0);
    });
  });

  describe('setLimits', () => {
    it('updates limits', () => {
      budget.setLimits({ dailyUsd: 100, hourlyUsd: 20 });
      const config = budget.getConfig();
      expect(config.dailyUsd).toBe(100);
      expect(config.hourlyUsd).toBe(20);
    });
  });

  describe('onBreach modes', () => {
    it('downgrade mode allows but flags', () => {
      const mgr = new BudgetManager({
        enabled: true, dailyUsd: 5, hourlyUsd: 5, perRequestUsd: 2,
        onBreach: 'downgrade', downgradeTo: 'claude-sonnet-4-6',
        alertThresholds: [],
      });
      mgr.recordSpend(6, 'test');
      const result = mgr.checkBudget();
      expect(result.allowed).toBe(true);
      expect(result.breached).toBe(true);
      expect(result.action).toBe('downgrade');
      mgr.close();
    });

    it('warn mode allows but flags', () => {
      const mgr = new BudgetManager({
        enabled: true, dailyUsd: 5, hourlyUsd: 5, perRequestUsd: 2,
        onBreach: 'warn', downgradeTo: 'claude-sonnet-4-6',
        alertThresholds: [],
      });
      mgr.recordSpend(6, 'test');
      const result = mgr.checkBudget();
      expect(result.allowed).toBe(true);
      expect(result.action).toBe('warn');
      mgr.close();
    });
  });

  describe('threshold deduplication', () => {
    it('does not re-fire after markThresholdFired', () => {
      budget.updateConfig({ hourlyUsd: 100 });
      budget.recordSpend(30, 'test');
      const first = budget.checkBudget();
      expect(first.thresholdsCrossed).toContain(50);

      budget.markThresholdFired(50);
      const second = budget.checkBudget();
      expect(second.thresholdsCrossed).not.toContain(50);
    });
  });

  describe('DEFAULT_BUDGET_CONFIG', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_BUDGET_CONFIG.enabled).toBe(false);
      expect(DEFAULT_BUDGET_CONFIG.dailyUsd).toBe(50);
      expect(DEFAULT_BUDGET_CONFIG.hourlyUsd).toBe(10);
      expect(DEFAULT_BUDGET_CONFIG.perRequestUsd).toBe(2);
      expect(DEFAULT_BUDGET_CONFIG.onBreach).toBe('downgrade');
    });
  });

  describe('performance', () => {
    it('checkBudget completes in <5ms', () => {
      // Warm up
      budget.checkBudget();
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        budget.checkBudget();
      }
      const elapsed = performance.now() - start;
      const perCheck = elapsed / 1000;
      expect(perCheck).toBeLessThan(5);
    });
  });
});
