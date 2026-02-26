/**
 * Osmosis Knowledge Mesh — Capture
 * Converts proxy request/response data into knowledge atoms.
 */

import { createHash } from 'node:crypto';
import type { CaptureEvent } from './types.js';
import { MeshStore } from './store.js';

/**
 * Capture a proxy request as a knowledge atom (fire-and-forget).
 */
export function captureRequest(store: MeshStore, event: CaptureEvent): string {
  const paramsHash = createHash('sha256')
    .update(`${event.model}:${event.task_type}:${event.input_tokens}`)
    .digest('hex')
    .slice(0, 16);

  const atom = store.insert({
    type: 'tool',
    observation: event.success
      ? `${event.task_type}→${event.model}: ${event.output_tokens} tokens, $${event.cost_usd.toFixed(4)}, ${event.latency_ms}ms`
      : `${event.task_type}→${event.model}: FAILED (${event.error_type ?? 'unknown'})`,
    context: JSON.stringify({
      provider: event.provider,
      task_type: event.task_type,
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cost_usd: event.cost_usd,
    }),
    confidence: event.success ? 0.7 : 0.3,
    fitness_score: event.success ? 0.8 : 0.2,
    trust_tier: 'local',
    source_agent_hash: 'relayplane-proxy',
    decay_rate: 0.99,
    tool_name: `${event.task_type}→${event.model}`,
    params_hash: paramsHash,
    outcome: event.success ? 'success' : 'failure',
    error_signature: event.error_type ?? null,
    latency_ms: event.latency_ms,
    reliability_score: event.success ? 1.0 : 0.0,
  });

  return atom.id;
}
