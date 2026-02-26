import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
});
