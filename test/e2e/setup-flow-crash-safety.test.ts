/**
 * Regression test for the verifier's "nondeterministic gating suite: verdict
 * changed between consecutive runs" failure on relayplane-deploy-path-cleanup-2026-09-05.
 *
 * That failure showed up as vitest reporting "Worker exited unexpectedly"
 * (a tinypool/fork crash, "Vitest caught 1 unhandled error during the test
 * run") with every individual assertion still green - the whole-suite
 * verdict flipped from pass to fail between two back-to-back runs of the
 * exact same code with no source changes.
 *
 * Root cause: the "relayplane start (crash-free)" test in
 * test/e2e/setup-flow.test.ts spawns a ChildProcess and registers listeners
 * for 'exit' and for stderr 'data', but never for 'error'. Per Node's
 * ChildProcess docs, if the underlying spawn itself fails (ENOENT, EMFILE
 * under file-descriptor pressure, transient resource exhaustion, etc.) the
 * emitted 'error' event has no listener, so Node throws it as an uncaught
 * exception. Since this suite runs with pool: 'forks' / singleFork: true
 * (see vitest.config.ts), every test file shares one process, so that throw
 * kills the whole run instead of failing just this one test - and only on
 * the runs where the spawn actually errors, which is exactly the kind of
 * run-to-run environmental variance that flips the gate verdict.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUP_FLOW_TEST_PATH = join(__dirname, 'setup-flow.test.ts');

function crashFreeSpawnBlock(): string {
  const source = readFileSync(SETUP_FLOW_TEST_PATH, 'utf8');
  const marker = "describe('relayplane start (crash-free)'";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find the "${marker}" block in setup-flow.test.ts`);
  }
  return source.slice(start);
}

describe('setup-flow.test.ts spawned child processes handle spawn errors safely', () => {
  it('the "relayplane start (crash-free)" spawn() registers an "error" listener so a failed spawn cannot crash the whole test worker', () => {
    const block = crashFreeSpawnBlock();
    expect(block).toContain("proc.on('error'");
  });
});
