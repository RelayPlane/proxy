/**
 * Osmosis wiring integration test.
 *
 * Verifies that captureAtom is called via the middleware route() path,
 * and that osmosis.db (or fallback JSONL) accumulates atoms correctly.
 *
 * SKIPPED: captureAtom is not yet wired into the middleware pipeline.
 * Re-enable when osmosis-phase1 branch is fully integrated.
 * See: origin/auto/2026-03-07-osmosis-phase1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { RelayPlaneMiddleware, type MiddlewareRequest, type MiddlewareResponse } from '../src/middleware.js';
import { _resetStore } from '../src/osmosis-store.js';

const PROXY_PORT = 14298;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

let testDir = '';
let testCounter = 0;

function makeReq(overrides?: Partial<MiddlewareRequest>): MiddlewareRequest {
  return {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [] }),
    ...overrides,
  };
}

function directSend(): Promise<MiddlewareResponse> {
  return Promise.resolve({
    status: 200,
    headers: {},
    body: JSON.stringify({ id: 'direct', usage: { input_tokens: 10, output_tokens: 5 } }),
    viaProxy: false,
  });
}

function countAtoms(testDir: string): number {
  const dir = path.join(testDir, '.relayplane');
  const dbPath = path.join(dir, 'osmosis.db');
  const jsonlPath = path.join(dir, 'osmosis.jsonl');

  if (fs.existsSync(dbPath)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_atoms').get() as { cnt: number };
    db.close();
    return row.cnt;
  }

  if (fs.existsSync(jsonlPath)) {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.length;
  }

  return 0;
}

describe.skip('Osmosis wiring — captureAtom via middleware', () => {
  let server: http.Server;
  let mw: RelayPlaneMiddleware;

  beforeEach(() => {
    testCounter++;
    testDir = path.join(os.tmpdir(), `rp-osmosis-wiring-${process.pid}-${testCounter}`);
    fs.mkdirSync(testDir, { recursive: true });
    process.env['RELAYPLANE_HOME_OVERRIDE'] = testDir;
    _resetStore();
  });

  afterEach(async () => {
    mw?.destroy();
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    _resetStore();
    delete process.env['RELAYPLANE_HOME_OVERRIDE'];
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('captures a success atom when request routes via proxy', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 20, output_tokens: 10 } }));
    });
    await new Promise<void>((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve));

    mw = new RelayPlaneMiddleware({ enabled: true, proxyUrl: PROXY_URL });
    await mw.route(makeReq(), directSend);

    expect(countAtoms(testDir)).toBe(1);

    // Verify it's a success atom with the right model
    const dir = path.join(testDir, '.relayplane');
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT * FROM knowledge_atoms LIMIT 1').get() as Record<string, unknown>;
      db.close();
      expect(row['type']).toBe('success');
      expect(row['model']).toBe('claude-3-haiku-20240307');
      expect(row['task_type']).toBe('chat');
    } else if (fs.existsSync(jsonlPath)) {
      const atom = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim()) as Record<string, unknown>;
      expect(atom['type']).toBe('success');
      expect(atom['model']).toBe('claude-3-haiku-20240307');
    }
  });

  it('captures a failure atom when proxy errors and falls back', async () => {
    // Server that always returns 500 → triggers proxy failure → fallback
    server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('error');
    });
    await new Promise<void>((resolve) => server.listen(PROXY_PORT + 1, '127.0.0.1', resolve));

    mw = new RelayPlaneMiddleware({
      enabled: true,
      proxyUrl: `http://127.0.0.1:${PROXY_PORT + 1}`,
      circuitBreaker: { failureThreshold: 10 }, // keep circuit closed so we get the error path
    });
    await mw.route(makeReq(), directSend);

    expect(countAtoms(testDir)).toBe(1);

    const dir = path.join(testDir, '.relayplane');
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT * FROM knowledge_atoms WHERE type = ?').get('failure') as Record<string, unknown>;
      db.close();
      expect(row).toBeTruthy();
      expect(row['fallback_taken']).toBe(1);
      expect(row['model']).toBe('claude-3-haiku-20240307');
    } else if (fs.existsSync(jsonlPath)) {
      const atom = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim()) as Record<string, unknown>;
      expect(atom['type']).toBe('failure');
      expect(atom['fallbackTaken']).toBe(true);
    }
  });

  it('accumulates N atoms for N requests', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 3 } }));
    });
    await new Promise<void>((resolve) => server.listen(PROXY_PORT + 2, '127.0.0.1', resolve));

    mw = new RelayPlaneMiddleware({ enabled: true, proxyUrl: `http://127.0.0.1:${PROXY_PORT + 2}` });

    const N = 5;
    for (let i = 0; i < N; i++) {
      await mw.route(makeReq(), directSend);
    }

    expect(countAtoms(testDir)).toBe(N);
  });

  it('captures success atom when proxy is disabled (direct path)', async () => {
    mw = new RelayPlaneMiddleware({ enabled: false });
    await mw.route(makeReq(), directSend);

    expect(countAtoms(testDir)).toBe(1);

    const dir = path.join(testDir, '.relayplane');
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT * FROM knowledge_atoms LIMIT 1').get() as Record<string, unknown>;
      db.close();
      expect(row['type']).toBe('success');
    } else if (fs.existsSync(jsonlPath)) {
      const atom = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim()) as Record<string, unknown>;
      expect(atom['type']).toBe('success');
    }
  });

  it('infers task type from request path', async () => {
    mw = new RelayPlaneMiddleware({ enabled: false });
    await mw.route(makeReq({ path: '/v1/messages' }), directSend);

    const dir = path.join(testDir, '.relayplane');
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT task_type FROM knowledge_atoms LIMIT 1').get() as Record<string, unknown>;
      db.close();
      expect(row['task_type']).toBe('chat');
    } else if (fs.existsSync(jsonlPath)) {
      const atom = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim()) as Record<string, unknown>;
      expect(atom['taskType']).toBe('chat');
    }
  });
});
