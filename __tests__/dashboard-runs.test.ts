/**
 * PR4: dashboard Runs tab, run detail, attribution guardrails.
 *
 * Source-level assertions in the `dashboard-tier.test.ts` style: the dashboard
 * is a plain-JSX Vite SPA with no test renderer wired up, so the contract we
 * can actually pin is the source shape plus a real `vite build`. The build
 * guard at the bottom is the one that proves the tab compiles and ships.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const packageRoot = join(__dirname, '..');
const srcDir = join(packageRoot, 'dashboard', 'src');
const read = (file: string): string => readFileSync(join(srcDir, file), 'utf-8');

const NEW_FILES = ['Runs.jsx', 'RunDetail.jsx', 'useLiveRuns.js', 'useRunDetail.js', 'useRunAlerts.js'];

describe('PR4 dashboard: App wiring', () => {
  const app = read('App.jsx');

  it('TABS includes runs immediately after overview', () => {
    const match = /const TABS = \[([^\]]+)\]/.exec(app);
    expect(match, 'TABS array not found in App.jsx').toBeTruthy();
    const tabs = (match as RegExpExecArray)[1]
      .split(',')
      .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(tabs).toContain('runs');
    expect(tabs.indexOf('runs')).toBe(tabs.indexOf('overview') + 1);
  });

  it('imports and renders Runs', () => {
    expect(app).toMatch(/import \{ Runs \} from '\.\/Runs'/);
    expect(app).toContain('<Runs ');
    expect(app).toContain("activeTab === 'runs'");
  });

  it('imports and renders RunDetail for a selected run', () => {
    expect(app).toMatch(/import \{ RunDetail \} from '\.\/RunDetail'/);
    expect(app).toContain('<RunDetail ');
  });

  it('handles the #run= deep link on mount and on hashchange', () => {
    expect(app).toContain('#run=');
    expect(app).toContain("addEventListener('hashchange'");
    expect(app).toContain('parseRunHash');
  });

  it('drives the hero fourth line and the critical alert strip off the run hooks', () => {
    expect(app).toMatch(/useLiveRuns\(\{[^}]*active: true/);
    expect(app).toContain('useRunAlerts');
    expect(app).toContain('RunsInFlight');
    expect(app).toMatch(/\brun' : 'runs'\} active/);
    expect(app).toContain('in flight');
    expect(app).toContain('runband');
    // The strip is a sibling of the kill banner, it does not replace it.
    expect(app).toContain('killband');
    expect(app).toContain("severity !== 'critical'");
  });
});

describe('PR4 dashboard: new files exist and stay ungated', () => {
  it.each(NEW_FILES)('%s exists', (file) => {
    expect(existsSync(join(srcDir, file)), `${file} is missing`).toBe(true);
  });

  it.each([...NEW_FILES, 'Guardrails.jsx'])('%s has no tier, plan or pricing gate', (file) => {
    const src = read(file);
    expect(src, `${file} imports useTier`).not.toMatch(/useTier/);
    expect(src, `${file} references GatedPanel`).not.toMatch(/GatedPanel/);
    expect(src, `${file} references pricing`).not.toMatch(/pricing/i);
    expect(src, `${file} references a plan check`).not.toMatch(/\bplans?\b/i);
  });

  it.each([...NEW_FILES, 'Guardrails.jsx', 'App.jsx', 'panels.jsx', 'dashboard.css'])(
    '%s contains no em dash',
    (file) => {
      const emDash = String.fromCharCode(0x2014);
      expect(read(file).includes(emDash), `${file} contains U+2014`).toBe(false);
    },
  );
});

describe('PR4 dashboard: run hooks call the PR2 API', () => {
  it('useLiveRuns polls both the active and the list endpoints', () => {
    const src = read('useLiveRuns.js');
    expect(src).toContain('/v1/runs/active');
    expect(src).toContain('/v1/runs?');
    expect(src).toContain('startedLabel');
    expect(src).toContain('durLabel');
    expect(src).toContain('topAgent');
  });

  it('useRunDetail reads a run, its requests, and posts an export', () => {
    const src = read('useRunDetail.js');
    expect(src).toContain('/v1/runs/');
    expect(src).toContain('/v1/runs/export');
    expect(src).toContain('/requests?limit=');
    expect(src).toContain('/end');
    expect(src).toContain('createObjectURL');
    for (const action of ['rename', 'end', 'setCap', 'exportRun']) {
      expect(src, `useRunDetail is missing the ${action} action`).toContain(action);
    }
  });

  it('useRunAlerts polls /v1/runs/alerts', () => {
    const src = read('useRunAlerts.js');
    expect(src).toContain('/v1/runs/alerts');
    expect(src).toContain('since');
  });
});

describe('PR4 dashboard: Runs and RunDetail surfaces', () => {
  const runs = read('Runs.jsx');
  const detail = read('RunDetail.jsx');

  it('Runs renders every contracted column and filter', () => {
    for (const token of ['runpill', 'runsrc', 'band', 'rate_limit_wave', 'retry_cost_usd', 'topAgent']) {
      expect(runs, `Runs.jsx is missing ${token}`).toContain(token);
    }
    for (const source of ['header', 'inferred_cc', 'inferred_gap']) {
      expect(runs).toContain(source);
    }
    expect(runs).toContain('inferred from Claude Code session');
    expect(runs).toContain('inferred from idle gap');
  });

  it('Runs empty state teaches both ways to get a run, each copyable', () => {
    expect(runs).toContain('relayplane run');
    expect(runs).toContain('X-RelayPlane-Run');
    expect(runs).toContain('CopyButton');
  });

  it('RunDetail shows the money line, band bar, retries and the run header copy', () => {
    expect(detail).toContain('X-RelayPlane-Run: ');
    expect(detail).toContain('idleCloseSeconds');
    expect(detail).toContain('cost_per_minute');
    expect(detail).toContain('baseline_usd');
    expect(detail).toContain('rdband');
    expect(detail).toContain('in retries');
    expect(detail).toContain('by_model');
    expect(detail).toContain('children');
    // No sparkline and no tree, per the spec.
    expect(detail).not.toMatch(/Sparkline/);
  });
});

describe('PR4 dashboard: Guardrails attribution card', () => {
  const src = read('Guardrails.jsx');

  it('posts an attribution merge patch to /control/config', () => {
    expect(src).toContain('/control/config');
    expect(src).toMatch(/attribution:\s*\{/);
  });

  it('renders all seven attribution fields', () => {
    for (const field of [
      'idleCloseSeconds',
      'defaultRunCapUsd',
      'runCapAction',
      'runCostUsd',
      'webhookUrl',
      'overBand',
      'modelDrift',
    ]) {
      expect(src, `Guardrails.jsx is missing ${field}`).toContain(field);
    }
  });
});

describe('PR4 dashboard: validateAttributionPayload', () => {
  const base = {
    idleCloseSeconds: 600,
    defaultRunCapUsd: null,
    runCapAction: 'block',
    runCostUsd: null,
    webhookUrl: '',
    overBand: true,
    modelDrift: true,
  };
  const load = async () => {
    const mod = await import('../dashboard/src/Guardrails.jsx');
    return mod.validateAttributionPayload as (p: unknown) => { ok: boolean; error?: string };
  };

  it('accepts the defaults', async () => {
    const validate = await load();
    expect(validate(base)).toEqual({ ok: true });
  });

  it('accepts positive caps and an https webhook', async () => {
    const validate = await load();
    expect(validate({
      ...base,
      idleCloseSeconds: 30,
      defaultRunCapUsd: 5,
      runCostUsd: 2.5,
      runCapAction: 'warn',
      webhookUrl: 'https://hooks.example.com/rp',
    })).toEqual({ ok: true });
  });

  it('rejects an idle close under 30 seconds', async () => {
    const validate = await load();
    expect(validate({ ...base, idleCloseSeconds: 29 })).toEqual({ ok: false, error: 'invalid_idle_close' });
    expect(validate({ ...base, idleCloseSeconds: 0 })).toEqual({ ok: false, error: 'invalid_idle_close' });
  });

  it('rejects a non-positive cap but allows null for none', async () => {
    const validate = await load();
    expect(validate({ ...base, defaultRunCapUsd: 0 })).toEqual({ ok: false, error: 'invalid_cap' });
    expect(validate({ ...base, defaultRunCapUsd: -1 })).toEqual({ ok: false, error: 'invalid_cap' });
    expect(validate({ ...base, runCostUsd: 0 })).toEqual({ ok: false, error: 'invalid_cap' });
    expect(validate({ ...base, defaultRunCapUsd: null, runCostUsd: null })).toEqual({ ok: true });
  });

  it('rejects a webhook that is not http or https, allows empty', async () => {
    const validate = await load();
    expect(validate({ ...base, webhookUrl: 'ftp://example.com' })).toEqual({ ok: false, error: 'invalid_webhook' });
    expect(validate({ ...base, webhookUrl: 'example.com' })).toEqual({ ok: false, error: 'invalid_webhook' });
    expect(validate({ ...base, webhookUrl: '' })).toEqual({ ok: true });
    expect(validate({ ...base, webhookUrl: 'http://localhost:9000/hook' })).toEqual({ ok: true });
  });

  it('rejects an unknown cap action', async () => {
    const validate = await load();
    expect(validate({ ...base, runCapAction: 'downgrade' })).toEqual({ ok: false, error: 'invalid_cap_action' });
  });
});

describe('PR4 dashboard: request stream run chip', () => {
  it('useLiveRequests carries run_id and agent_label off the episodic row', () => {
    const src = read('useLiveRequests.js');
    expect(src).toContain('run_id');
    expect(src).toContain('agent_label');
  });

  it('panels.jsx renders a run chip that writes the #run= hash', () => {
    const src = read('panels.jsx');
    expect(src).toContain('runchip');
    expect(src).toContain('#run=');
    expect(src).toMatch(/RunChip/);
  });
});

describe('PR4 dashboard: build guard', () => {
  const distDir = join(packageRoot, 'dist', 'dashboard');

  beforeAll(() => {
    execSync('pnpm build:dashboard', { cwd: packageRoot, stdio: 'pipe', timeout: 110_000 });
  }, 120_000);

  it('emits dist/dashboard/index.html', () => {
    expect(existsSync(join(distDir, 'index.html'))).toBe(true);
  });

  it('compiles the runs tab into the bundle', () => {
    const assetsDir = join(distDir, 'assets');
    expect(existsSync(assetsDir)).toBe(true);
    const bundles = readdirSync(assetsDir).filter(f => f.endsWith('.js'));
    expect(bundles.length).toBeGreaterThan(0);
    const js = bundles.map(f => readFileSync(join(assetsDir, f), 'utf-8')).join('\n');
    expect(js).toContain('runpill');
    expect(js).toContain('/v1/runs/active');
  });

  it('ships the runs styles in the emitted css', () => {
    const assetsDir = join(distDir, 'assets');
    const sheets = readdirSync(assetsDir).filter(f => f.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    const css = sheets.map(f => readFileSync(join(assetsDir, f), 'utf-8')).join('\n');
    expect(css).toContain('.runpill');
    expect(css).toContain('.runchip');
  });
});
