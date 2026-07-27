/**
 * Phase 1 TDD: dashboard tier-split HTML shape tests.
 * These tests FAIL until the implementation is added.
 */
import { describe, it, expect } from 'vitest';
import { getDashboardHTML } from '../src/standalone-proxy.js';

describe('dashboard HTML: gated panels', () => {
  let html: string;

  // getDashboardHTML may be async or sync depending on implementation
  beforeAll(async () => {
    const result = getDashboardHTML();
    html = result instanceof Promise ? await result : result;
  });

  it('test_dashboard_html_contains_gated_panels: includes all five panel ids', () => {
    expect(html).toContain('id="panel-sessions"');
    expect(html).toContain('id="panel-mesh"');
    expect(html).toContain('id="panel-token-pool"');
    expect(html).toContain('id="panel-xprov"');
    expect(html).toContain('id="panel-learning"');
  });

  it('test_dashboard_html_contains_gated_badge_with_upgrade_link: includes gated-badge with pricing link', () => {
    expect(html).toContain('class="gated-badge"');
    expect(html).toContain('href="https://relayplane.com/pricing"');
  });

  it('test_dashboard_html_contains_gated_css_rule: style block has .gated opacity and .gated.mesh-on override', () => {
    expect(html).toMatch(/\.gated\s*\{[^}]*opacity\s*:/);
    expect(html).toContain('.gated.mesh-on');
  });

  it('test_dashboard_html_contains_applyTier_function: script defines applyTier and calls it at init', () => {
    expect(html).toContain('async function applyTier');
    expect(html).toContain('applyTier()');
  });

  it('test_dashboard_html_contains_panel_loaders: defines all four panel loader functions', () => {
    expect(html).toContain('loadMeshPanel');
    expect(html).toContain('loadTokenPoolPanel');
    expect(html).toContain('loadXProvPanel');
    expect(html).toContain('loadLearningPanel');
  });
});
