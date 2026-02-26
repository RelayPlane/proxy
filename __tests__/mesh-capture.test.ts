import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeshStore } from '../src/mesh/store.js';
import { captureRequest } from '../src/mesh/capture.js';
import type { CaptureEvent } from '../src/mesh/types.js';

describe('captureRequest', () => {
  let store: MeshStore;

  beforeEach(() => {
    store = new MeshStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('captures a successful request as a tool atom', () => {
    const event: CaptureEvent = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      task_type: 'code_generation',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.015,
      latency_ms: 2500,
      success: true,
      timestamp: new Date().toISOString(),
    };

    const id = captureRequest(store, event);
    expect(id).toBeTruthy();

    const atom = store.getById(id);
    expect(atom).toBeTruthy();
    expect(atom!.type).toBe('tool');
    expect(atom!.outcome).toBe('success');
    expect(atom!.confidence).toBe(0.7);
    expect(atom!.observation).toContain('code_generation');
    expect(atom!.observation).toContain('claude-sonnet-4-6');
  });

  it('captures a failed request', () => {
    const event: CaptureEvent = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      task_type: 'analysis',
      input_tokens: 500,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 5000,
      success: false,
      error_type: 'rate_limit',
      timestamp: new Date().toISOString(),
    };

    const id = captureRequest(store, event);
    const atom = store.getById(id);
    expect(atom!.outcome).toBe('failure');
    expect(atom!.confidence).toBe(0.3);
    expect(atom!.observation).toContain('FAILED');
    expect(atom!.observation).toContain('rate_limit');
  });

  it('stores atoms as unsynced by default', () => {
    captureRequest(store, {
      model: 'gpt-4o', provider: 'openai', task_type: 'general',
      input_tokens: 100, output_tokens: 50, cost_usd: 0.001,
      latency_ms: 1000, success: true, timestamp: new Date().toISOString(),
    });

    expect(store.getUnsynced()).toHaveLength(1);
    expect(store.countSynced()).toBe(0);
  });
});
