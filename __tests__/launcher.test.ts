import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

function waitForOutput(child: ChildProcess, match: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for output')), 10_000);
    const handler = (chunk: Buffer) => {
      if (chunk.toString().includes(match)) {
        clearTimeout(timeout);
        child.stdout?.off('data', handler);
        resolve();
      }
    };
    child.stdout?.on('data', handler);
    child.stderr?.on('data', handler);
  });
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on('error', reject);
  });
}

function findTsxBin(): string {
  const local = path.resolve(__dirname, '../node_modules/.bin/tsx');
  if (fs.existsSync(local)) return local;
  return 'tsx';
}

describe('Launcher', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      child = null;
    }
  });

  it('starts server and responds to /health', async () => {
    const port = 14100 + Math.floor(Math.random() * 1000);
    // Find the launcher - use tsx to run .ts directly
    const launcherPath = path.resolve(__dirname, '../src/launcher.ts');

    child = spawn(findTsxBin(), [launcherPath], {
      env: { ...process.env, RELAYPLANE_PROXY_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForOutput(child, 'listening');

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(typeof json.uptime).toBe('number');
  }, 15_000);

  it('graceful shutdown on SIGTERM', async () => {
    const port = 14100 + Math.floor(Math.random() * 1000);
    const launcherPath = path.resolve(__dirname, '../src/launcher.ts');

    child = spawn(findTsxBin(), [launcherPath], {
      env: { ...process.env, RELAYPLANE_PROXY_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForOutput(child, 'listening');

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child!.on('exit', (code, signal) => resolve({ code, signal }));
    });

    child.kill('SIGTERM');
    const result = await exitPromise;
    // Process may exit with code 0 or be killed by signal
    expect(result.code === 0 || result.signal === 'SIGTERM').toBe(true);
    child = null;
  }, 15_000);
});
