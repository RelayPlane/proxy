/**
 * Characterization tests for src/streaming.ts.
 *
 * Pins CURRENT behavior of the pure aggregateStreamingResponse(chunks)
 * reassembly function (golden in/out tables) and of SSEWriter driven
 * against a minimal fake ServerResponse. Not a spec; a failing test after
 * a source change means observable behavior changed.
 *
 * streamProviderResponse is not exercised: it depends on fetch/network
 * and Date.now timing. Everything below is deterministic and offline.
 */

import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  SSEWriter,
  createSSEWriter,
  aggregateStreamingResponse,
} from '../src/streaming.js';

/** Minimal fake for the subset of ServerResponse that SSEWriter touches. */
class FakeResponse {
  statusCode: number | undefined;
  headers: Record<string, string> | undefined;
  writes: string[] = [];
  ended = false;
  throwOnWrite = false;
  private listeners: Record<string, Array<() => void>> = {};

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  on(event: string, cb: () => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  emit(event: string): void {
    for (const cb of this.listeners[event] ?? []) cb();
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error('write failed');
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe('aggregateStreamingResponse characterization', () => {
  it('returns empty content and all-undefined metadata for an empty chunk list', () => {
    expect(aggregateStreamingResponse([])).toEqual({
      content: '',
      usage: undefined,
      model: undefined,
      finish_reason: undefined,
    });
  });

  it('concatenates delta.content across chunks and picks up model, finish_reason, and usage', () => {
    const chunks = [
      { model: 'gpt-4o', choices: [{ delta: { content: 'Hel' } }] },
      { model: 'gpt-4o', choices: [{ delta: { content: 'lo' } }] },
      {
        model: 'gpt-4o',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ];
    expect(aggregateStreamingResponse(chunks)).toEqual({
      content: 'Hello',
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      model: 'gpt-4o',
      finish_reason: 'stop',
    });
  });

  it('computes total_tokens as prompt + completion when the chunk omits it', () => {
    const chunks = [{ usage: { prompt_tokens: 7, completion_tokens: 5 } }];
    expect(aggregateStreamingResponse(chunks).usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it('keeps an explicit total_tokens of 0 (nullish coalescing, not ||)', () => {
    const chunks = [{ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 0 } }];
    expect(aggregateStreamingResponse(chunks).usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 0,
    });
  });

  it('ignores usage objects missing numeric prompt_tokens or completion_tokens', () => {
    const chunks = [
      { usage: { prompt_tokens: 3 } },
      { usage: { prompt_tokens: '3', completion_tokens: '4' } },
    ];
    expect(aggregateStreamingResponse(chunks).usage).toBeUndefined();
  });

  it('skips non-object and null chunks without error', () => {
    const chunks: unknown[] = [
      null,
      'data',
      42,
      undefined,
      { choices: [{ delta: { content: 'ok' } }] },
    ];
    expect(aggregateStreamingResponse(chunks)).toEqual({
      content: 'ok',
      usage: undefined,
      model: undefined,
      finish_reason: undefined,
    });
  });

  it('reads only choices[0]; content in choices[1] is ignored', () => {
    const chunks = [
      {
        choices: [
          { delta: { content: 'first' } },
          { delta: { content: 'second' } },
        ],
      },
    ];
    expect(aggregateStreamingResponse(chunks).content).toBe('first');
  });

  it('last chunk wins for model and finish_reason; non-string values and empty strings are ignored', () => {
    const chunks = [
      { model: 'model-a', choices: [{ finish_reason: 'length' }] },
      { model: 123, choices: [{ finish_reason: '' }] },
      { model: 'model-b', choices: [{ finish_reason: 'stop' }] },
    ];
    const res = aggregateStreamingResponse(chunks);
    expect(res.model).toBe('model-b');
    expect(res.finish_reason).toBe('stop');
  });

  it('ignores non-string delta.content and chunks with an empty choices array', () => {
    const chunks = [
      { choices: [] },
      { choices: [{ delta: { content: 7 } }] },
      { choices: [{ delta: { content: null } }] },
      { choices: [{ delta: { content: 'x' } }] },
    ];
    expect(aggregateStreamingResponse(chunks).content).toBe('x');
  });
});

describe('SSEWriter characterization', () => {
  it('constructor writes SSE headers with status 200 exactly once', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    expect(writer.isOpen()).toBe(true);
    expect(res.writes).toEqual([]);
  });

  it('write() emits event, id, retry, and data lines in that order, ending with a blank line and trailing newline', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    const ok = writer.write({ event: 'update', id: '42', retry: 3000, data: 'hello' });
    expect(ok).toBe(true);
    expect(res.writes).toEqual(['event: update\nid: 42\nretry: 3000\ndata: hello\n\n']);
  });

  it('write() JSON-stringifies non-string data', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    writer.write({ data: { a: 1, b: 'two' } });
    expect(res.writes).toEqual(['data: {"a":1,"b":"two"}\n\n']);
  });

  it('write() splits multi-line string data into one data: line per line', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    writer.write({ data: 'line1\nline2\nline3' });
    expect(res.writes).toEqual(['data: line1\ndata: line2\ndata: line3\n\n']);
  });

  it('retry: 0 is emitted (checked with !== undefined) but an empty event string is dropped (truthiness check)', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    writer.write({ event: '', retry: 0, data: 'x' });
    expect(res.writes).toEqual(['retry: 0\ndata: x\n\n']);
  });

  it('writeData() is a data-only frame; comment() writes ": text" with a blank line', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    expect(writer.writeData('ping')).toBe(true);
    expect(writer.comment('keep-alive')).toBe(true);
    expect(res.writes).toEqual(['data: ping\n\n', ': keep-alive\n\n']);
  });

  it('close() writes a [DONE] frame, ends the response, and is idempotent', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    writer.close();
    expect(res.writes).toEqual(['data: [DONE]\n\n']);
    expect(res.ended).toBe(true);
    expect(writer.isOpen()).toBe(false);

    // Second close is a no-op; write/comment now return false without writing.
    writer.close();
    expect(writer.write({ data: 'late' })).toBe(false);
    expect(writer.comment('late')).toBe(false);
    expect(res.writes).toEqual(['data: [DONE]\n\n']);
  });

  it('client disconnect (response "close" event) marks the writer closed', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    expect(writer.isOpen()).toBe(true);
    res.emit('close');
    expect(writer.isOpen()).toBe(false);
    expect(writer.write({ data: 'x' })).toBe(false);
    expect(res.writes).toEqual([]);
  });

  it('a throwing response.write marks the writer closed and returns false, swallowing the error', () => {
    const res = new FakeResponse();
    const writer = new SSEWriter(res.asServerResponse());
    res.throwOnWrite = true;
    expect(writer.write({ data: 'x' })).toBe(false);
    expect(writer.isOpen()).toBe(false);
    // After the failure, further writes short-circuit on the closed flag.
    res.throwOnWrite = false;
    expect(writer.write({ data: 'y' })).toBe(false);
    expect(res.writes).toEqual([]);
  });

  it('createSSEWriter returns an SSEWriter instance', () => {
    const res = new FakeResponse();
    const writer = createSSEWriter(res.asServerResponse());
    expect(writer).toBeInstanceOf(SSEWriter);
    expect(res.statusCode).toBe(200);
  });
});
