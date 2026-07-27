import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from '../src/budget.js';

describe('Guardrails config - applyGuardrailsPatch', () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({ ...DEFAULT_BUDGET_CONFIG });
  });

  it('test_applyGuardrailsPatch_persists_per_session_cap', () => {
    const result = budget.applyGuardrailsPatch({ perSessionCapUsd: 5.0 });
    expect(result.ok).toBe(true);
    expect(budget.getConfig().perSessionCapUsd).toBe(5.0);
  });

  it('test_applyGuardrailsPatch_persists_ladder', () => {
    const ladder = [
      { from: 'claude-opus-4-6', to: 'claude-sonnet-4-6', triggerPct: 80 },
      { from: 'claude-sonnet-4-6', to: 'claude-haiku-4-5', triggerPct: 90 },
      { from: 'gpt-4o', to: 'gpt-4o-mini', triggerPct: 80 },
    ];
    const result = budget.applyGuardrailsPatch({ ladder });
    expect(result.ok).toBe(true);
    const config = budget.getConfig();
    expect(config.ladder).toHaveLength(3);
    expect(config.ladder![0].from).toBe('claude-opus-4-6');
    expect(config.ladder![1].to).toBe('claude-haiku-4-5');
    expect(config.ladder![2].triggerPct).toBe(80);
  });

  it('test_applyGuardrailsPatch_rejects_negative_cap', () => {
    const before = budget.getConfig();
    const result = budget.applyGuardrailsPatch({ perDayCapUsd: -5 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_cap');
    expect(budget.getConfig().perDayCapUsd).toBe(before.perDayCapUsd);
  });

  it('test_applyGuardrailsPatch_rejects_triggerPct_out_of_range', () => {
    const before = budget.getConfig();
    const result = budget.applyGuardrailsPatch({
      ladder: [{ from: 'gpt-4o', to: 'gpt-4o-mini', triggerPct: 100 }],
    });
    expect(result.ok).toBe(false);
    expect(budget.getConfig().ladder).toEqual(before.ladder);
  });

  it('test_applyGuardrailsPatch_rejects_empty_ladder_row_from', () => {
    const result = budget.applyGuardrailsPatch({
      ladder: [{ from: '', to: 'gpt-4o-mini', triggerPct: 80 }],
    });
    expect(result.ok).toBe(false);
  });

  it('test_alerting_config_pro_only_telegram_email', () => {
    const result = budget.applyGuardrailsPatch({
      alerting: { slack: true, slackWebhookUrl: 'https://hooks.slack.com/test' },
    });
    expect(result.ok).toBe(true);
    expect(budget.getConfig().alerting?.slack).toBe(true);
  });

  it('test_applyGuardrailsPatch_rejects_ladder_self_loop', () => {
    const result = budget.applyGuardrailsPatch({
      ladder: [{ from: 'claude-opus-4-6', to: 'claude-opus-4-6', triggerPct: 80 }],
    });
    expect(result.ok).toBe(false);
    expect(budget.getConfig().ladder).toEqual([]);
  });
});

describe('Guardrails surface-sync checks', () => {
  it('test_root_readme_includes_cost_guardrails_section', () => {
    const readmePath = join(__dirname, '..', '..', '..', 'README.md');
    const content = readFileSync(readmePath, 'utf8');
    expect(content).toContain('Cost Guardrails');
  });

  it('test_proxy_readme_includes_cost_guardrails_section', () => {
    const readmePath = join(__dirname, '..', 'README.md');
    const content = readFileSync(readmePath, 'utf8');
    expect(content).toContain('Cost Guardrails');
  });

  it('test_guardrails_css_file_exists', () => {
    const cssPath = join(__dirname, '..', 'dashboard', 'src', 'guardrails.css');
    expect(existsSync(cssPath)).toBe(true);
  });

  it('test_guardrails_jsx_component_exists', () => {
    const jsxPath = join(__dirname, '..', 'dashboard', 'src', 'Guardrails.jsx');
    expect(existsSync(jsxPath)).toBe(true);
  });

  it('test_app_jsx_has_guardrails_tab', () => {
    const appPath = join(__dirname, '..', 'dashboard', 'src', 'App.jsx');
    expect(existsSync(appPath)).toBe(true);
    if (existsSync(appPath)) {
      const content = readFileSync(appPath, 'utf8');
      // The dashboard renders <Guardrails /> under the 'config' tab (no
      // separate lowercase 'guardrails' tab id, that was the discarded
      // placeholder mockup's naming; the real feature lives on 'config').
      expect(content).toContain('Guardrails');
      expect(content).toContain("activeTab === 'config'");
    }
  });

  it('test_docs_cost_caps_page_exists', () => {
    const docsPath = join(__dirname, '..', '..', '..', 'apps', 'marketing-site', 'src', 'app', 'docs', 'cost-caps', 'page.tsx');
    expect(existsSync(docsPath)).toBe(true);
  });

  it('test_main_tsx_imports_guardrails_css', () => {
    const mainPath = join(__dirname, '..', 'dashboard', 'src', 'main.tsx');
    expect(existsSync(mainPath)).toBe(true);
    if (existsSync(mainPath)) {
      const content = readFileSync(mainPath, 'utf8');
      expect(content).toContain('guardrails.css');
    }
  });

  it('test_plans_config_has_no_paid_tier_everything_is_free', () => {
    // RelayPlane is fully free and open source (MIT). No Pro tier, no
    // gated guardrails limits, everything ships in the single free plan.
    const plansPath = join(__dirname, '..', '..', '..', 'plans.config.json');
    const plans = JSON.parse(readFileSync(plansPath, 'utf8'));
    expect(plans.plans).toHaveProperty('free');
    expect(plans.plans).not.toHaveProperty('pro');
    expect(plans.plans.free.price_monthly).toBe(0);
    expect(plans.plans.free.description.toLowerCase()).toContain('free and open source');
  });
});

// The Guardrails page must reject an invalid patch client-side, before it
// ever reaches PATCH /control/budget, using the same rules the server
// enforces (non-negative numbers, ladder rows need non-empty from/to,
// triggerPct in [1, 99], retries >= 1, windowSec >= 5). This helper does not
// exist on the component yet.
describe('Guardrails.jsx - validateGuardrailsPayload (client-side pre-PATCH validation)', () => {
  it('test_validateGuardrailsPayload_accepts_a_well_formed_payload', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: 5,
      perDayUsd: 50,
      ladder: [{ from: 'claude-opus-4-6', to: 'claude-sonnet-4-6', triggerPct: 80 }],
      retries: 3,
      windowSec: 90,
    });
    expect(result.ok).toBe(true);
  });

  it('test_validateGuardrailsPayload_rejects_negative_cap', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: -1,
      perDayUsd: 50,
      ladder: [],
      retries: 3,
      windowSec: 90,
    });
    expect(result.ok).toBe(false);
  });

  it('test_validateGuardrailsPayload_rejects_ladder_row_with_empty_from', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: 5,
      perDayUsd: 50,
      ladder: [{ from: '', to: 'claude-sonnet-4-6', triggerPct: 80 }],
      retries: 3,
      windowSec: 90,
    });
    expect(result.ok).toBe(false);
  });

  it('test_validateGuardrailsPayload_rejects_triggerPct_out_of_range', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: 5,
      perDayUsd: 50,
      ladder: [{ from: 'gpt-4o', to: 'gpt-4o-mini', triggerPct: 0 }],
      retries: 3,
      windowSec: 90,
    });
    expect(result.ok).toBe(false);
  });

  it('test_validateGuardrailsPayload_rejects_retries_below_one', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: 5,
      perDayUsd: 50,
      ladder: [],
      retries: 0,
      windowSec: 90,
    });
    expect(result.ok).toBe(false);
  });

  it('test_validateGuardrailsPayload_rejects_windowSec_below_five', async () => {
    const { validateGuardrailsPayload } = await import('../dashboard/src/Guardrails.jsx');
    const result = validateGuardrailsPayload({
      perSessionUsd: 5,
      perDayUsd: 50,
      ladder: [],
      retries: 3,
      windowSec: 4,
    });
    expect(result.ok).toBe(false);
  });
});
