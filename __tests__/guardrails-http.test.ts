/**
 * Tests for the PATCH /control/budget and GET /control/kills HTTP endpoints,
 * plus guardrails response shape verification.
 *
 * The handler wiring in standalone-proxy.ts (PATCH /control/budget,
 * GET /control/kills, extended GET /control/budget response) is not yet done.
 * These tests verify that wiring exists and returns the correct shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from '../src/budget.js';
import { KillAudit } from '../src/kill-audit.js';

describe('PATCH /control/budget handler logic (unit layer)', () => {
  it('test_patch_budget_accepts_valid_guardrails_payload', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    const patch = {
      perSessionCapUsd: 10.0,
      perDayCapUsd: 50.0,
      ladder: [
        { from: 'claude-opus-4-6', to: 'claude-sonnet-4-6', triggerPct: 80 },
      ],
      runawayRetries: 4,
      runawayWindowSec: 120,
      alerting: { telegram: true, telegramChatId: '12345' },
    };
    const result = manager.applyGuardrailsPatch(patch);
    expect(result.ok).toBe(true);
    const cfg = manager.getConfig();
    expect(cfg.perSessionCapUsd).toBe(10.0);
    expect(cfg.perDayCapUsd).toBe(50.0);
    expect(cfg.ladder).toHaveLength(1);
    expect(cfg.runawayRetries).toBe(4);
    expect(cfg.runawayWindowSec).toBe(120);
    expect(cfg.alerting?.telegram).toBe(true);
    expect(cfg.alerting?.telegramChatId).toBe('12345');
  });

  it('test_patch_budget_rejects_per_key_cap_negative', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    const result = manager.applyGuardrailsPatch({
      perKeyCapUsd: { 'sk-ant-abc': -1.0 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('test_get_budget_response_includes_new_fields', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    manager.applyGuardrailsPatch({
      perSessionCapUsd: 7.5,
      ladder: [{ from: 'gpt-4o', to: 'gpt-4o-mini', triggerPct: 85 }],
      runawayRetries: 3,
      runawayWindowSec: 90,
    });
    const cfg = manager.getConfig();
    expect(cfg).toHaveProperty('perSessionCapUsd');
    expect(cfg).toHaveProperty('ladder');
    expect(cfg).toHaveProperty('runawayRetries');
    expect(cfg).toHaveProperty('runawayWindowSec');
    expect(cfg).toHaveProperty('alerting');
    expect(cfg).toHaveProperty('perKeyCapUsd');
  });
});

describe('GET /control/kills handler logic (unit layer)', () => {
  it('test_kills_list_returns_empty_on_fresh_audit', () => {
    const audit = new KillAudit();
    const events = audit.list({ limit: 50 });
    expect(events).toEqual([]);
  });

  it('test_kills_list_with_limit_and_since', () => {
    const audit = new KillAudit();
    const t1 = '2026-05-29T10:00:00.000Z';
    const t2 = '2026-05-29T11:00:00.000Z';
    const t3 = '2026-05-29T12:00:00.000Z';
    audit.record({ timestamp: t1, session_id: 'sess-001', agent: 'agentA', reason: 'manual', saved_usd: 0.10 });
    audit.record({ timestamp: t2, session_id: 'sess-002', agent: 'agentB', reason: 'cap_exceeded', saved_usd: 1.20 });
    audit.record({ timestamp: t3, session_id: 'sess-003', agent: 'agentC', reason: 'runaway_loop', saved_usd: 2.50 });

    const limited = audit.list({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].session_id).toBe('sess-003');

    const filtered = audit.list({ since: '2026-05-29T10:30:00.000Z' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every(e => e.timestamp >= '2026-05-29T10:30:00.000Z')).toBe(true);
  });

  it('test_kills_event_shape_matches_interface', () => {
    const audit = new KillAudit();
    audit.record({
      timestamp: '2026-05-29T10:00:00.000Z',
      session_id: 'sess-xyz-789abc',
      agent: 'testAgent',
      reason: 'cap_exceeded',
      saved_usd: 3.14,
    });
    const [ev] = audit.list({ limit: 1 });
    expect(ev).toHaveProperty('timestamp');
    expect(ev).toHaveProperty('session_id');
    expect(ev).toHaveProperty('agent');
    expect(ev).toHaveProperty('reason');
    expect(ev).toHaveProperty('saved_usd');
    expect(['cap_exceeded', 'runaway_loop', 'manual']).toContain(ev.reason);
    expect(typeof ev.saved_usd).toBe('number');
  });
});

describe('BudgetManager.applyGuardrailsPatch - per-key cap validation', () => {
  it('test_per_key_cap_accepts_valid_positive_values', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    const result = manager.applyGuardrailsPatch({
      perKeyCapUsd: {
        'sk-ant-abc123': 10.0,
        'sk-ant-def456': 25.5,
      },
    });
    expect(result.ok).toBe(true);
    expect(manager.getConfig().perKeyCapUsd?.['sk-ant-abc123']).toBe(10.0);
  });

  it('test_per_key_cap_rejects_zero_value', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    const result = manager.applyGuardrailsPatch({
      perKeyCapUsd: { 'sk-ant-abc': 0 },
    });
    expect(result.ok).toBe(false);
  });

  it('test_alerting_email_stores_address', () => {
    const manager = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
    const result = manager.applyGuardrailsPatch({
      alerting: {
        email: true,
        emailAddress: 'ops@example.com',
      },
    });
    expect(result.ok).toBe(true);
    expect(manager.getConfig().alerting?.emailAddress).toBe('ops@example.com');
  });
});

describe('standalone-proxy.ts guardrails HTTP handler wiring', () => {
  const proxySource = readFileSync(
    join(__dirname, '..', 'src', 'standalone-proxy.ts'),
    'utf8',
  );

  it('test_standalone_proxy_imports_kill_audit', () => {
    expect(proxySource).toContain("from './kill-audit");
  });

  it('test_standalone_proxy_has_patch_control_budget_handler', () => {
    expect(proxySource).toMatch(/req\.method\s*===?\s*['"]PATCH['"]\s*&&\s*pathname\s*===?\s*['"]\/control\/budget['"]/);
  });

  it('test_standalone_proxy_has_get_control_kills_handler', () => {
    expect(proxySource).toMatch(/req\.method\s*===?\s*['"]GET['"]\s*&&\s*pathname\s*===?\s*['"]\/control\/kills['"]/);
  });

  it('test_get_budget_response_includes_per_session_cap_usd', () => {
    const budgetGetBlock = proxySource.slice(
      proxySource.indexOf("req.method === 'GET' && pathname === '/control/budget'"),
    );
    const blockEnd = budgetGetBlock.indexOf('return;');
    const handlerBlock = budgetGetBlock.slice(0, blockEnd);
    expect(handlerBlock).toContain('per_session_cap_usd');
  });

  it('test_get_budget_response_includes_ladder', () => {
    const budgetGetBlock = proxySource.slice(
      proxySource.indexOf("req.method === 'GET' && pathname === '/control/budget'"),
    );
    const blockEnd = budgetGetBlock.indexOf('return;');
    const handlerBlock = budgetGetBlock.slice(0, blockEnd);
    expect(handlerBlock).toContain('ladder');
  });

  it('test_get_budget_response_includes_alerts_fired_last_7d', () => {
    const budgetGetBlock = proxySource.slice(
      proxySource.indexOf("req.method === 'GET' && pathname === '/control/budget'"),
    );
    const blockEnd = budgetGetBlock.indexOf('return;');
    const handlerBlock = budgetGetBlock.slice(0, blockEnd);
    expect(handlerBlock).toContain('alerts_fired_last_7d');
  });

  it('test_patch_handler_calls_applyGuardrailsPatch', () => {
    expect(proxySource).toContain('applyGuardrailsPatch');
  });

  it('test_kills_handler_calls_getKillAudit', () => {
    expect(proxySource).toContain('getKillAudit');
  });
});
