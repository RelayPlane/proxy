import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureAtom, _resetStore } from '../src/osmosis-store.js';

let testDir = '';
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  testDir = path.join(os.tmpdir(), `rp-osmosis-${process.pid}-${testCounter}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env['RELAYPLANE_HOME_OVERRIDE'] = testDir;
  _resetStore();
});

afterEach(() => {
  _resetStore();
  delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getOsmosisDir() {
  return path.join(testDir, '.relayplane');
}

describe('captureAtom — success atom', () => {
  it('writes a success atom without throwing', () => {
    expect(() => captureAtom({
      type: 'success',
      model: 'claude-3-haiku-20240307',
      taskType: 'chat',
      latencyMs: 250,
      inputTokens: 100,
      outputTokens: 50,
      timestamp: Date.now(),
    })).not.toThrow();
  });

  it('persists success atom to SQLite or JSONL', () => {
    captureAtom({
      type: 'success',
      model: 'gpt-4o',
      taskType: 'code',
      latencyMs: 300,
      inputTokens: 200,
      outputTokens: 75,
      timestamp: Date.now(),
    });

    const dir = getOsmosisDir();
    const hasSqlite = fs.existsSync(path.join(dir, 'osmosis.db'));
    const hasJsonl = fs.existsSync(path.join(dir, 'osmosis.jsonl'));
    expect(hasSqlite || hasJsonl).toBe(true);

    if (hasJsonl && !hasSqlite) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'osmosis.jsonl'), 'utf-8').trim());
      expect(parsed.type).toBe('success');
      expect(parsed.model).toBe('gpt-4o');
    }
  });

  it('stores multiple success atoms', () => {
    for (let i = 0; i < 5; i++) {
      captureAtom({
        type: 'success',
        model: `model-${i}`,
        taskType: 'chat',
        latencyMs: 100 + i,
        inputTokens: 50,
        outputTokens: 25,
        timestamp: Date.now() + i,
      });
    }

    const dir = getOsmosisDir();
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_atoms').get() as { cnt: number };
      db.close();
      expect(row.cnt).toBe(5);
    } else if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(5);
    }
  });
});

describe('captureAtom — failure atom', () => {
  it('writes a failure atom without throwing', () => {
    expect(() => captureAtom({
      type: 'failure',
      errorType: 'timeout',
      model: 'claude-3-5-sonnet-20241022',
      fallbackTaken: true,
      timestamp: Date.now(),
    })).not.toThrow();
  });

  it('persists failure atom with correct fields', () => {
    const ts = Date.now();
    captureAtom({
      type: 'failure',
      errorType: 'rate_limit',
      model: 'gpt-4o-mini',
      fallbackTaken: false,
      timestamp: ts,
    });

    const dir = getOsmosisDir();
    const dbPath = path.join(dir, 'osmosis.db');
    const jsonlPath = path.join(dir, 'osmosis.jsonl');

    if (fs.existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const row = db.prepare('SELECT * FROM knowledge_atoms WHERE type = ?').get('failure') as Record<string, unknown>;
      db.close();
      expect(row).toBeTruthy();
      expect(row['error_type']).toBe('rate_limit');
      expect(row['model']).toBe('gpt-4o-mini');
      expect(row['fallback_taken']).toBe(0);
      expect(row['timestamp']).toBe(ts);
    } else if (fs.existsSync(jsonlPath)) {
      const parsed = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim());
      expect(parsed.type).toBe('failure');
      expect(parsed.errorType).toBe('rate_limit');
    }
  });
});

describe('captureAtom — schema validation', () => {
  it('creates knowledge_atoms table with correct columns', () => {
    captureAtom({
      type: 'success',
      model: 'test-model',
      taskType: 'test',
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      timestamp: Date.now(),
    });

    const dbPath = path.join(getOsmosisDir(), 'osmosis.db');
    if (!fs.existsSync(dbPath)) return; // JSONL fallback — skip schema check

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const cols = db.prepare('PRAGMA table_info(knowledge_atoms)').all() as Array<{ name: string }>;
    db.close();

    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'id', 'type', 'model', 'task_type', 'latency_ms',
      'input_tokens', 'output_tokens', 'error_type', 'fallback_taken', 'timestamp',
    ]) {
      expect(colNames).toContain(expected);
    }
  });
});
