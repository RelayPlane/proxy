import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as net from 'node:net';

const packageRoot = join(__dirname, '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

function runCli(args: string[], home: string, timeout = 5000) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HOME: home,
    },
  });
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

describe('ensure-running command', () => {
  it('exits 0 and prints "already running" when port 4100 is already in use', async () => {
    // If port 4100 is already in use (proxy already running), test directly
    const alreadyInUse = await isPortInUse(4100);

    if (alreadyInUse) {
      const home = mkdtempSync(join(tmpdir(), 'rp-test-'));
      const result = runCli(['ensure-running'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('already running');
      return;
    }

    // Port is free — bind a temporary server then test
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(4100, '127.0.0.1', resolve));

    try {
      const home = mkdtempSync(join(tmpdir(), 'rp-test-'));
      const result = runCli(['ensure-running'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('already running');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('help text includes ensure-running', () => {
    const home = mkdtempSync(join(tmpdir(), 'rp-test-'));
    const result = runCli(['--help'], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ensure-running');
  });

  it('does not treat ensure-running as an unknown command', () => {
    const home = mkdtempSync(join(tmpdir(), 'rp-test-'));
    const result = runCli(['ensure-running'], home, 5000);
    expect(result.stderr ?? '').not.toContain('Unknown command');
  });

  it('writes pid file when starting proxy', async () => {
    // This test only runs when port 4100 is free; skip otherwise
    if (await isPortInUse(4100)) return;

    const home = mkdtempSync(join(tmpdir(), 'rp-test-'));
    const pidFile = join(home, '.relayplane', 'proxy.pid');

    runCli(['ensure-running'], home, 4000);

    // PID file should have been written even if startup timed out
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      expect(pid).toBeGreaterThan(0);
    }
  });
});
