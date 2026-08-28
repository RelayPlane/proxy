import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const packageRoot = join(__dirname, '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

function runCli(args: string[] = []) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(packageRoot, '.test-home-cli'),
    },
  });
}

describe('CLI command surface', () => {
  it('has built CLI artifact', () => {
    expect(existsSync(cliPath)).toBe(true);
  });

  it('prints help with expected commands', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('init');
    expect(res.stdout).toContain('start');
    expect(res.stdout).toContain('budget');
    expect(res.stdout).toContain('alerts');
  });

  it('prints version', () => {
    const res = runCli(['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RelayPlane Proxy v');
  });

  it('init exits without starting server', () => {
    const res = runCli(['init']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RelayPlane initialized');
    expect(res.stdout).not.toContain('Proxy listening');
  });

  it('budget subcommand exits without starting server', () => {
    const res = runCli(['budget', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Budget Status');
    expect(res.stdout).not.toContain('Proxy listening');
  });

  it('alerts subcommand exits without starting server', () => {
    const res = runCli(['alerts', 'counts']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Alert Counts');
    expect(res.stdout).not.toContain('Proxy listening');
  });

  it('unknown command returns non-zero instead of falling through to start', () => {
    const res = runCli(['definitely-not-a-real-command']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown command');
    expect(res.stdout).not.toContain('Proxy listening');
  });

  it('prints help mentioning the cap and kills commands claimed on the marketing site', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('cap');
    expect(res.stdout).toContain('kills');
  });

  it('cap status is unset in a hermetic test HOME before this suite ever calls "cap set"', () => {
    // Regression test for the verifier's "nondeterministic gating suite: verdict
    // changed between consecutive runs" failure. The CLI test HOME
    // (.test-home-cli) must behave like a fresh install on every run. If a
    // prior run's ~/.relayplane/config.json is left on disk (e.g. committed,
    // or not cleaned up between runs) with a stale dailyCapUSD, this
    // assertion fails, and later tests in this file become order- and
    // run-history-dependent instead of deterministic.
    const res = runCli(['cap', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not set');
    expect(res.stdout).not.toContain('$50.00');
  });

  it('"cap set --day 50" (as documented on /pro and /docs/cost-caps) sets a real daily cap', () => {
    const res = runCli(['cap', 'set', '--day', '50']);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('Unknown command');
    expect(res.stdout).not.toContain('Proxy listening');
    expect(res.stdout).toMatch(/cap/i);

    // The cap must actually be wired into the real BudgetTracker (packages/proxy/src/budget.ts),
    // not just print a message, so a subsequent budget status reflects the $50 cap.
    const status = runCli(['budget', 'status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('$50.00');
  });

  it('"kills --last 7d" (as documented on /pro and /docs/cost-caps) exits cleanly without starting the server', () => {
    const res = runCli(['kills', '--last', '7d']);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('Unknown command');
    expect(res.stdout).not.toContain('Proxy listening');
    expect(res.stdout).toMatch(/kill/i);
  });

  it('"kills" queries RELAYPLANE_PORT / RELAYPLANE_PROXY_PORT instead of hardcoding the live proxy port 4100 (HARD RULE 2: never touch the live instance)', async () => {
    // The rest of the CLI (see `start`, launcher.ts) resolves its target port
    // from RELAYPLANE_PROXY_PORT / RELAYPLANE_PORT, defaulting to 4100. The
    // `kills` command must follow the same convention instead of hardcoding
    // 127.0.0.1:4100, otherwise every invocation (including this test suite)
    // silently queries whatever real proxy happens to be live on 4100 -
    // exactly the two-port rule this repo's CLAUDE.md forbids.
    const marker = `test-marker-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const events = [
      {
        timestamp: new Date(0).toISOString(),
        agent: 'test-agent',
        session_id: 'test-session',
        reason: marker,
        saved_usd: 1.23,
      },
    ];

    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith('/control/kills')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ events }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const res = spawnSync(process.execPath, [cliPath, 'kills', '--last', '7d'], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(packageRoot, '.test-home-cli'),
          RELAYPLANE_PORT: String(port),
        },
      });

      expect(res.status).toBe(0);
      // If the CLI honored RELAYPLANE_PORT, this stub (not the live 4100
      // proxy) answers the request and the marker shows up in stdout.
      expect(res.stdout).toContain(marker);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
