/**
 * Repro for the 1.9.55 undercount: "a run with 2 calls sharing one
 * X-RelayPlane-Run id recorded request_count=1 (cost attributed but call
 * count undercounts)".
 *
 * RunStore.upsertRequest (src/run-store.ts) maintains `runs.request_count`
 * with a JS-side read-modify-write: `getRun()` -> increment in JS ->
 * `putRun()` (INSERT OR REPLACE of the whole row), with no busy_timeout set
 * on the underlying better-sqlite3 connection (see `initSqlite`). That is
 * race-free for a single proxy process, since Node has no yield point
 * inside one call. It is NOT race-free across two independent connections
 * to the same ~/.relayplane/runs.db writing the same run id concurrently,
 * which is exactly what two agents/processes tagging calls with the same
 * run id produce: one connection's SELECT can be snapshotted before the
 * other's COMMIT, so the later write either clobbers the earlier increment
 * (lost update) or throws SQLITE_BUSY, which `recordRunRequest` swallows
 * ("attribution never breaks a request"), silently dropping the request
 * row. Either way, request_count undercounts real traffic.
 *
 * This test drives two independent `RunStore` connections (main thread +
 * a worker thread, real OS-thread parallelism so the two connections can
 * genuinely interleave, unlike two calls in one synchronous JS process)
 * against one shared runs.db and one shared run id, released together via
 * a barrier so their upsertRequest calls land as close together as
 * possible, repeated over many rounds to make at least one collision
 * overwhelmingly likely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';

import {
  getRunStore,
  _forceMemoryForTests,
  _resetRunStore,
  type RunRequestRow,
} from '../src/run-store.js';

const RUN_STORE_DIST = join(__dirname, '..', 'dist', 'run-store.js');

let home = '';
let savedOverride: string | undefined;

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-run-count-race-'));
}

function baseRequestRow(over: Partial<RunRequestRow> & Pick<RunRequestRow, 'trace_id' | 'run_id'>): RunRequestRow {
  return {
    agent_label: 'coder',
    thread_id: 'thread-1',
    history_id: null,
    ts: Date.now(),
    model: 'claude-sonnet-4-6',
    requested_model: null,
    provider: 'anthropic',
    attempt: 1,
    is_retry: 0,
    retry_reason: null,
    cache_state: 'cold',
    tokens_in: 10,
    tokens_out: 5,
    cache_read: 0,
    cache_creation: 0,
    cost_usd: 0.001,
    cost_estimated: 0,
    latency_ms: 5,
    success: 1,
    status_code: 200,
    complexity: null,
    task_type: null,
    ...over,
  };
}

/**
 * Runs entirely in a fresh worker thread: its own module registry means
 * `getRunStore()` opens its own better-sqlite3 connection, separate from
 * the main thread's, exactly like a second proxy process would.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
process.env.RELAYPLANE_HOME_OVERRIDE = workerData.home;
const { getRunStore } = require(workerData.runStorePath);
const store = getRunStore();

parentPort.on('message', (msg) => {
  if (msg.type !== 'upsert') return;
  try {
    store.upsertRequest(msg.row, { agent_source: 'inferred' });
    parentPort.postMessage({ type: 'done', traceId: msg.row.trace_id, ok: true });
  } catch (err) {
    parentPort.postMessage({ type: 'done', traceId: msg.row.trace_id, ok: false, error: String(err) });
  }
});
`;

function spawnWorker(homeDir: string): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { home: homeDir, runStorePath: RUN_STORE_DIST },
  });
}

function waitForDone(worker: Worker, traceId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: { type: string; traceId: string; ok: boolean; error?: string }): void => {
      if (msg.type !== 'done' || msg.traceId !== traceId) return;
      worker.off('message', onMessage);
      resolve({ ok: msg.ok, error: msg.error });
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
}

beforeEach(() => {
  savedOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  home = makeHome();
  process.env['RELAYPLANE_HOME_OVERRIDE'] = home;
  _forceMemoryForTests(false);
  _resetRunStore();
});

afterEach(() => {
  _forceMemoryForTests(false);
  _resetRunStore();
  if (savedOverride === undefined) delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  else process.env['RELAYPLANE_HOME_OVERRIDE'] = savedOverride;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('RunStore request_count under real cross-connection concurrency', () => {
  it('never loses a request_count increment when two RunStore connections race on one run id', async () => {
    expect(fs.existsSync(RUN_STORE_DIST), `${RUN_STORE_DIST} missing, run "pnpm --filter @relayplane/proxy build" (or tsc) first`).toBe(true);

    const store = getRunStore();
    store.openRun({ run_id: 'shared-run', run_source: 'header', now: Date.now() });

    const worker = spawnWorker(home);

    const ROUNDS = 40;
    let expectedCount = 0;
    const failures: string[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const traceMain = `main-${i}`;
      const traceWorker = `worker-${i}`;

      const workerDone = waitForDone(worker, traceWorker);
      worker.postMessage({
        type: 'upsert',
        row: baseRequestRow({ trace_id: traceWorker, run_id: 'shared-run', ts: Date.now() }),
      });

      // Fire the main thread's own write for this round in the same instant
      // the worker's message is being handled on its own OS thread.
      let mainOk = true;
      try {
        store.upsertRequest(
          baseRequestRow({ trace_id: traceMain, run_id: 'shared-run', ts: Date.now() }),
          { agent_source: 'inferred' },
        );
      } catch (err) {
        mainOk = false;
        failures.push(`main-${i}: ${String(err)}`);
      }

      const workerResult = await workerDone;
      if (!workerResult.ok) failures.push(`worker-${i}: ${workerResult.error ?? 'unknown error'}`);

      if (mainOk) expectedCount += 1;
      if (workerResult.ok) expectedCount += 1;
    }

    await worker.terminate();

    const run = store.getRun('shared-run');
    expect(run, 'run row disappeared').toBeTruthy();

    // Either symptom proves the bug: dropped writes (failures non-empty) or
    // a lost increment (request_count under the number of successful calls).
    expect(failures, `${failures.length} upsertRequest call(s) failed under contention:\n${failures.join('\n')}`).toEqual([]);
    expect(run!.request_count).toBe(expectedCount);
  }, 30_000);
});
