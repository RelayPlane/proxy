import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from '../src/budget.js';

describe('Runaway loop config', () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
  });

  it('test_runaway_config_defaults', () => {
    const cfg = budget.getConfig();
    expect(cfg.runawayRetries).toBe(3);
    expect(cfg.runawayWindowSec).toBe(90);
  });

  it('test_runaway_config_patch_round_trip', () => {
    const result = budget.applyGuardrailsPatch({
      runawayRetries: 5,
      runawayWindowSec: 60,
    });
    expect(result.ok).toBe(true);
    const cfg = budget.getConfig();
    expect(cfg.runawayRetries).toBe(5);
    expect(cfg.runawayWindowSec).toBe(60);
  });

  it('test_runaway_config_rejects_zero_retries', () => {
    const result = budget.applyGuardrailsPatch({ runawayRetries: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_runaway');
    expect(budget.getConfig().runawayRetries).toBe(3);
  });

  it('test_runaway_config_rejects_short_window', () => {
    const result = budget.applyGuardrailsPatch({ runawayWindowSec: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_runaway');
    expect(budget.getConfig().runawayWindowSec).toBe(90);
  });
});
