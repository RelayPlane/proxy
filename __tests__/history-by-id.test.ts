/**
 * PR1, run attribution: the history entry a response updates must be the one
 * that request created, not "the last row in the array".
 *
 * `updateLastHistoryEntry` mutates `requestHistory[length - 1]`. That is safe
 * only while requests are serial. The moment two agents fan out through the
 * same proxy, request B's row is appended before request A's upstream call
 * returns, so A's tokens and cost land on B's row: A reads $0 and B reads
 * double. Every fan-out ledger number is wrong, and the run rollups built on
 * top of history inherit the error.
 *
 * Contract: the update is addressed by the history id captured in the
 * request's own AsyncLocalStorage context, and falls back to the tail only
 * when there is no context (the pre-attribution call sites).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  logRequest,
  updateLastHistoryEntry,
  getRequestHistory,
  clearRequestHistory,
} from '../src/standalone-proxy.js';
import { runCtx, newRunRequestContext } from '../src/run-attribution.js';

describe('history rows are updated by id, not by array position', () => {
  beforeEach(() => {
    clearRequestHistory();
  });

  it('interleaved requests: the update lands on the row its own context created', () => {
    const rcA = newRunRequestContext({ headers: {} });
    const rcB = newRunRequestContext({ headers: {} });

    runCtx.run(rcA, () => logRequest('claude-sonnet-4-6', 'claude-sonnet-4-6', 'anthropic', 11, true, 'passthrough'));
    runCtx.run(rcB, () => logRequest('claude-sonnet-4-6', 'claude-sonnet-4-6', 'anthropic', 22, true, 'passthrough'));

    // A finishes second: without id addressing this writes onto B's row.
    runCtx.run(rcA, () => updateLastHistoryEntry(1000, 500, 0.0123));

    const history = getRequestHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.costUsd).toBe(0.0123);
    expect(history[0]!.tokensIn).toBe(1000);
    expect(history[0]!.tokensOut).toBe(500);
    expect(history[1]!.costUsd).toBe(0);
    expect(history[1]!.tokensIn).toBe(0);
  });

  it('each context updates its own row, both rows end up correct', () => {
    const rcA = newRunRequestContext({ headers: {} });
    const rcB = newRunRequestContext({ headers: {} });

    runCtx.run(rcA, () => logRequest('m', 'm', 'anthropic', 1, true, 'passthrough'));
    runCtx.run(rcB, () => logRequest('m', 'm', 'anthropic', 2, true, 'passthrough'));
    runCtx.run(rcB, () => updateLastHistoryEntry(20, 2, 0.002));
    runCtx.run(rcA, () => updateLastHistoryEntry(10, 1, 0.001));

    const history = getRequestHistory();
    expect(history[0]!.costUsd).toBe(0.001);
    expect(history[1]!.costUsd).toBe(0.002);
  });

  it('outside any run context the tail is still updated (pre-attribution call sites keep working)', () => {
    logRequest('m', 'm', 'anthropic', 5, true, 'passthrough');
    updateLastHistoryEntry(7, 3, 0.0009);

    const history = getRequestHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.costUsd).toBe(0.0009);
    expect(history[0]!.tokensIn).toBe(7);
    expect(history[0]!.tokensOut).toBe(3);
  });

  it('a context whose row was pruned out of history does not throw or corrupt a neighbour', () => {
    const rcA = newRunRequestContext({ headers: {} });
    runCtx.run(rcA, () => logRequest('m', 'm', 'anthropic', 1, true, 'passthrough'));
    clearRequestHistory();
    logRequest('other', 'other', 'anthropic', 1, true, 'passthrough');

    expect(() => runCtx.run(rcA, () => updateLastHistoryEntry(99, 99, 9.99))).not.toThrow();
    const history = getRequestHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.originalModel).toBe('other');
    expect(history[0]!.costUsd).toBe(0);
  });
});
