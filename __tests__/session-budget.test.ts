import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BudgetManager } from '../src/budget.js';

describe('Session Budget', () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({
      enabled: true,
      dailyUsd: 50,
      hourlyUsd: 10,
      perRequestUsd: 2,
      onBreach: 'block',
      downgradeTo: 'claude-sonnet-4-6',
      alertThresholds: [],
      sessionCapUsd: 1.00,
      modelLadder: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    });
    // Don't call init() — skip SQLite in tests, use memory-only
  });

  afterEach(() => {
    budget.close();
  });

  describe('checkSessionBudget', () => {
    it('allows request when session is under cap', () => {
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
      expect(result.model).toBe('claude-opus-4-5');
      expect(result.spent).toBe(0);
      expect(result.cap).toBe(1.00);
    });

    it('blocks request when session has exceeded cap', () => {
      budget.updateSessionBudget('session-1', 1.05, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('session_budget_exceeded');
      expect(result.spent).toBeGreaterThanOrEqual(1.00);
    });

    it('blocks when spend exactly equals cap', () => {
      budget.updateSessionBudget('session-1', 1.00, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(false);
    });

    it('downgrades model when >80% of cap is spent', () => {
      budget.updateSessionBudget('session-1', 0.85, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
      expect(result.model).toBe('claude-sonnet-4-5'); // next rung down
    });

    it('does not downgrade when under 80%', () => {
      budget.updateSessionBudget('session-1', 0.50, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
      expect(result.model).toBe('claude-opus-4-5'); // unchanged
    });

    it('stays at bottom of ladder when already there', () => {
      budget.updateSessionBudget('session-1', 0.85, 'claude-haiku-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-haiku-4-5');
      expect(result.allowed).toBe(true);
      expect(result.model).toBe('claude-haiku-4-5'); // can't go lower
    });

    it('does not change model when model is not in ladder', () => {
      budget.updateSessionBudget('session-1', 0.85, 'gpt-4o');
      const result = budget.checkSessionBudget('session-1', 'gpt-4o');
      expect(result.allowed).toBe(true);
      expect(result.model).toBe('gpt-4o'); // not in ladder, no change
    });

    it('creates separate budget for each session', () => {
      budget.updateSessionBudget('session-a', 0.90, 'claude-opus-4-5');
      budget.updateSessionBudget('session-b', 0.10, 'claude-opus-4-5');

      const a = budget.checkSessionBudget('session-a', 'claude-opus-4-5');
      const b = budget.checkSessionBudget('session-b', 'claude-opus-4-5');

      expect(a.allowed).toBe(true);
      expect(a.model).toBe('claude-sonnet-4-5'); // downgraded
      expect(b.allowed).toBe(true);
      expect(b.model).toBe('claude-opus-4-5'); // not downgraded
    });
  });

  describe('updateSessionBudget', () => {
    it('accumulates spend across calls', () => {
      budget.updateSessionBudget('session-1', 0.30, 'claude-sonnet-4-5');
      budget.updateSessionBudget('session-1', 0.25, 'claude-sonnet-4-5');
      const record = budget.getSessionBudget('session-1');
      expect(record).not.toBeNull();
      expect(record!.spentUsd).toBeCloseTo(0.55);
    });

    it('updates modelUsed', () => {
      budget.updateSessionBudget('session-1', 0.10, 'claude-opus-4-5');
      budget.updateSessionBudget('session-1', 0.05, 'claude-sonnet-4-5');
      const record = budget.getSessionBudget('session-1');
      expect(record!.modelUsed).toBe('claude-sonnet-4-5');
    });
  });

  describe('getSessionBudget', () => {
    it('returns null for unknown session', () => {
      const record = budget.getSessionBudget('nonexistent');
      expect(record).toBeNull();
    });

    it('returns record after spend is recorded', () => {
      budget.updateSessionBudget('session-xyz', 0.42, 'claude-opus-4-5');
      const record = budget.getSessionBudget('session-xyz');
      expect(record).not.toBeNull();
      expect(record!.sessionId).toBe('session-xyz');
      expect(record!.spentUsd).toBeCloseTo(0.42);
      expect(record!.capUsd).toBe(1.00);
    });
  });

  describe('listSessionBudgets', () => {
    it('returns empty list when no sessions', () => {
      const list = budget.listSessionBudgets();
      expect(list).toEqual([]);
    });

    it('returns all recorded sessions', () => {
      budget.updateSessionBudget('s1', 0.10, 'model-a');
      budget.updateSessionBudget('s2', 0.20, 'model-b');
      budget.updateSessionBudget('s3', 0.30, 'model-c');
      const list = budget.listSessionBudgets();
      expect(list.length).toBe(3);
      const ids = list.map(r => r.sessionId);
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids).toContain('s3');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        budget.updateSessionBudget(`session-${i}`, 0.01 * i, 'model');
      }
      const list = budget.listSessionBudgets(3);
      expect(list.length).toBe(3);
    });
  });

  describe('setSessionCap', () => {
    it('overrides the default cap for a session', () => {
      budget.setSessionCap('session-1', 5.00);
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.cap).toBe(5.00);
    });

    it('allows spend up to new cap', () => {
      budget.setSessionCap('session-1', 0.50);
      budget.updateSessionBudget('session-1', 0.49, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
    });

    it('blocks when new lower cap is exceeded', () => {
      budget.setSessionCap('session-1', 0.25);
      budget.updateSessionBudget('session-1', 0.30, 'claude-opus-4-5');
      const result = budget.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(false);
    });
  });

  describe('disabled mode', () => {
    it('allows session requests when enabled: false, even above $1 default cap', () => {
      const disabledMgr = new BudgetManager({ enabled: false });
      const result = disabledMgr.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
      expect(result.spent).toBe(0);
      expect(result.cap).toBe(0);
      disabledMgr.close();
    });

    it('allows session even after large spend accumulation when enabled: false', () => {
      const disabledMgr = new BudgetManager({ enabled: false });
      disabledMgr.updateSessionBudget('session-1', 5.00, 'claude-opus-4-5');
      const result = disabledMgr.checkSessionBudget('session-1', 'claude-opus-4-5');
      expect(result.allowed).toBe(true);
      disabledMgr.close();
    });
  });

  describe('config defaults', () => {
    it('uses sessionCapUsd from config', () => {
      const mgr = new BudgetManager({
        enabled: true,
        dailyUsd: 10,
        hourlyUsd: 5,
        perRequestUsd: 1,
        onBreach: 'block',
        downgradeTo: 'claude-haiku-4-5',
        alertThresholds: [],
        sessionCapUsd: 2.00,
        modelLadder: ['claude-opus-4-5', 'claude-haiku-4-5'],
      });
      const result = mgr.checkSessionBudget('test', 'claude-opus-4-5');
      expect(result.cap).toBe(2.00);
      mgr.close();
    });

    it('uses modelLadder from config for downgrade', () => {
      const mgr = new BudgetManager({
        enabled: true,
        dailyUsd: 10,
        hourlyUsd: 5,
        perRequestUsd: 1,
        onBreach: 'block',
        downgradeTo: 'claude-haiku-4-5',
        alertThresholds: [],
        sessionCapUsd: 1.00,
        modelLadder: ['model-a', 'model-b', 'model-c'],
      });
      mgr.updateSessionBudget('test', 0.85, 'model-a');
      const result = mgr.checkSessionBudget('test', 'model-a');
      expect(result.model).toBe('model-b');
      mgr.close();
    });
  });
});
