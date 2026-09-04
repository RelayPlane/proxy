/**
 * P0-4 (install test 2026-09-04, matrix rows 3g/3i/3j/3k/3l/3m, fix list #4/#5):
 * `relayplane cap set`, `budget.dailyCapUSD`, `RELAYPLANE_DAILY_CAP_USD`,
 * `relayplane kills`, the dashboard KILL button and `relayplane disable`
 * were all silent no-ops while only the README `budget.enabled` form blocked.
 * The working form also let the first request through after enabling.
 *
 * Contract: no silent no-ops in a cost-control tool. Every cap surface feeds
 * the one enforcing mechanism, the first over-cap request is blocked, blocks
 * are recorded as kills, the kill switch halts traffic, and `disable` says
 * out loud that traffic still flows.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetManager } from '../src/budget.js';
import {
  cliPath,
  packageRoot,
  makeHome,
  cleanEnv,
  spawnProxy,
  startMockUpstream,
  request,
  chatBody,
  type MockUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';

function runCli(home: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: cleanEnv(home, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('BudgetManager blocks the request that WOULD cross the cap (no fail-open first request)', () => {
  it('spend 0, cap $0.000001, projected cost above cap => blocked when onBreach=block', () => {
    const bm = new BudgetManager({ enabled: true, dailyUsd: 0.000001, hourlyUsd: 1000, onBreach: 'block' });
    const r = bm.checkBudget(undefined, { projectedCost: 0.00000345 });
    expect(r.allowed).toBe(false);
    expect(r.breached).toBe(true);
    expect(r.breachType).toBe('daily');
  });

  it('projected cost that stays under the cap is allowed', () => {
    const bm = new BudgetManager({ enabled: true, dailyUsd: 1, hourlyUsd: 1000, onBreach: 'block' });
    const r = bm.checkBudget(undefined, { projectedCost: 0.01 });
    expect(r.allowed).toBe(true);
  });
});

describe('relayplane cap set feeds the enforcing budget mechanism', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  it('cap set --day 5 writes budget.enabled=true, dailyUsd=5, onBreach=block', () => {
    const { home, configPath } = makeHome();
    homes.push(home);
    const res = runCli(home, ['cap', 'set', '--day', '5']);
    expect(res.status, res.stderr).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { budget?: Record<string, unknown> };
    expect(cfg.budget?.['enabled']).toBe(true);
    expect(cfg.budget?.['dailyUsd']).toBe(5);
    expect(cfg.budget?.['dailyCapUSD']).toBe(5);
    expect(cfg.budget?.['onBreach']).toBe('block');
  });

  it('cap set respects an explicit onBreach the user already chose', () => {
    const { home, configPath } = makeHome({ budget: { onBreach: 'downgrade' } });
    homes.push(home);
    const res = runCli(home, ['cap', 'set', '--day', '7']);
    expect(res.status).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { budget?: Record<string, unknown> };
    expect(cfg.budget?.['onBreach']).toBe('downgrade');
    expect(cfg.budget?.['enabled']).toBe(true);
  });
});

describe('relayplane disable is honest about what it does', () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  it('says traffic still flows, points at `relayplane kill`, and does not create ~/.openclaw', () => {
    const { home, configPath } = makeHome();
    homes.push(home);
    const res = runCli(home, ['disable']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/still flows|does not stop|passthrough/i);
    expect(res.stdout).toMatch(/relayplane kill/);
    expect(existsSync(join(home, '.openclaw'))).toBe(false);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { enabled?: boolean };
    expect(cfg.enabled).toBe(false);
  });
});

describe('end to end: caps, kills, kill switch on an OpenAI-only install', () => {
  let upstream: MockUpstream;
  let proxy: SpawnedProxy;

  beforeAll(async () => {
    upstream = await startMockUpstream();
    const { home } = makeHome({ config_version: 4, telemetry_enabled: false });
    proxy = await spawnProxy({
      home,
      env: {
        OPENAI_API_KEY: 'sk-dummy',
        RELAYPLANE_OPENAI_BASE_URL: upstream.url,
        RELAYPLANE_DAILY_CAP_USD: '0.000001',
      },
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('RELAYPLANE_DAILY_CAP_USD is honored: the very first request over the cap is a 429 budget_exceeded', async () => {
    expect(proxy.output()).toMatch(/RELAYPLANE_DAILY_CAP_USD/);
    const res = await request(proxy.port, '/v1/chat/completions', {
      body: chatBody('gpt-4o-mini'),
      headers: { 'x-relayplane-agent': 'qa-agent' },
    });
    expect(res.status, res.text).toBe(429);
    expect((res.json() as { type: string }).type).toBe('budget_exceeded');
    expect(upstream.calls.length).toBe(0);
  }, 15_000);

  it('the block is recorded as a kill: /control/kills lists a cap_exceeded event', async () => {
    const res = await request(proxy.port, '/control/kills');
    expect(res.status).toBe(200);
    const events = (res.json() as { events: Array<{ reason: string; agent: string }> }).events;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.reason).toBe('cap_exceeded');
    expect(events[0]!.agent).toBe('qa-agent');
  });

  it('`relayplane kills --last 1d` shows it', () => {
    const res = runCli(proxy.home, ['kills', '--last', '1d'], { RELAYPLANE_PORT: String(proxy.port) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/cap_exceeded/);
    expect(res.stdout).not.toMatch(/No kills recorded/);
  });

  it('`relayplane budget status` reads the running proxy, not a different world', () => {
    const res = runCli(proxy.home, ['budget', 'status'], { RELAYPLANE_PORT: String(proxy.port) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Enabled:\s+✅/);
    expect(res.stdout).toMatch(/0\.000001/);
    expect(res.stdout).toMatch(/block/);
  });

  it('kill switch: POST /control/kill {all:true} halts traffic with 503 kill_switch_active, /control/resume lifts it', async () => {
    // Lift the cap first so we can tell the kill switch apart from the budget block.
    const set = await request(proxy.port, '/control/budget/set', { body: { dailyUsd: 100 } });
    expect(set.status).toBe(200);

    const kill = await request(proxy.port, '/control/kill', { body: { all: true } });
    expect(kill.status).toBe(200);
    expect((kill.json() as { halted: boolean }).halted).toBe(true);

    const blocked = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini') });
    expect(blocked.status).toBe(503);
    expect((blocked.json() as { type: string }).type).toBe('kill_switch_active');

    const status = await request(proxy.port, '/control/status');
    expect((status.json() as { killSwitch: { active: boolean } }).killSwitch.active).toBe(true);

    const resume = await request(proxy.port, '/control/resume', { body: {} });
    expect(resume.status).toBe(200);

    const ok = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini') });
    expect(ok.status, ok.text).toBe(200);
  }, 20_000);

  it('`relayplane kill` / `relayplane resume` CLI drive the same switch', async () => {
    const k = runCli(proxy.home, ['kill'], { RELAYPLANE_PORT: String(proxy.port) });
    expect(k.status, k.stderr).toBe(0);
    expect(k.stdout).toMatch(/halted/i);
    const blocked = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini') });
    expect(blocked.status).toBe(503);
    const r = runCli(proxy.home, ['resume'], { RELAYPLANE_PORT: String(proxy.port) });
    expect(r.status, r.stderr).toBe(0);
    const ok = await request(proxy.port, '/v1/chat/completions', { body: chatBody('gpt-4o-mini') });
    expect(ok.status, ok.text).toBe(200);
  }, 20_000);
});
