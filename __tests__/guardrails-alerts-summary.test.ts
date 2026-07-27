import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from '../src/budget.js';
import { KillAudit, getKillAudit } from '../src/kill-audit.js';

describe('Guardrails budget summary - alerts_fired_last_7d', () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
  });

  it('test_getGuardrailsSummary_includes_alerts_fired_last_7d', () => {
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('alerts_fired_last_7d');
    expect(typeof summary.alerts_fired_last_7d).toBe('number');
    expect(summary.alerts_fired_last_7d).toBeGreaterThanOrEqual(0);
  });

  it('test_getGuardrailsSummary_includes_per_session_cap_usd', () => {
    budget.applyGuardrailsPatch({ perSessionCapUsd: 7.5 });
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('per_session_cap_usd');
    expect(summary.per_session_cap_usd).toBe(7.5);
  });

  it('test_getGuardrailsSummary_includes_per_key_caps', () => {
    budget.applyGuardrailsPatch({
      perKeyCapUsd: { 'sk-ant-abc': 10.0 },
    });
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('per_key_caps');
    expect(summary.per_key_caps).toEqual({ 'sk-ant-abc': 10.0 });
  });

  it('test_getGuardrailsSummary_includes_ladder', () => {
    const ladder = [
      { from: 'claude-opus-4-6', to: 'claude-sonnet-4-6', triggerPct: 80 },
    ];
    budget.applyGuardrailsPatch({ ladder });
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('ladder');
    expect(summary.ladder).toHaveLength(1);
    expect(summary.ladder[0].from).toBe('claude-opus-4-6');
  });

  it('test_getGuardrailsSummary_includes_runaway', () => {
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('runaway');
    expect(summary.runaway).toEqual({ retries: 3, window_sec: 90 });
  });

  it('test_getGuardrailsSummary_includes_alerting', () => {
    budget.applyGuardrailsPatch({
      alerting: { telegram: true, telegramChatId: '12345' },
    });
    const summary = budget.getGuardrailsSummary();
    expect(summary).toHaveProperty('alerting');
    expect(summary.alerting.telegram).toBe(true);
    expect(summary.alerting.telegramChatId).toBe('12345');
  });
});

describe('KillAudit - countSince helper', () => {
  it('test_kill_audit_countSince_returns_count_after_date', () => {
    const audit = new KillAudit();
    audit.record({ timestamp: '2026-05-22T10:00:00.000Z', session_id: 's1', agent: 'a1', reason: 'manual', saved_usd: 0.5 });
    audit.record({ timestamp: '2026-05-28T10:00:00.000Z', session_id: 's2', agent: 'a2', reason: 'cap_exceeded', saved_usd: 1.0 });
    audit.record({ timestamp: '2026-05-29T10:00:00.000Z', session_id: 's3', agent: 'a3', reason: 'runaway_loop', saved_usd: 2.0 });
    const count = audit.countSince('2026-05-25T00:00:00.000Z');
    expect(count).toBe(2);
  });

  it('test_kill_audit_countSince_returns_zero_when_empty', () => {
    const audit = new KillAudit();
    const count = audit.countSince('2026-05-29T00:00:00.000Z');
    expect(count).toBe(0);
  });
});
