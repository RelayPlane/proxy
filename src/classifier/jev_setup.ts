/**
 * Env-gated configuration for the optional Jev complexity classifier.
 *
 * Mirrors sidecar_setup.ts: a single env var switches the add-on on. When the
 * key is absent, `enabled` is false and RelayPlane behaves exactly as before
 * (free heuristic only, no external calls, no Jev network module loaded).
 *
 * Env vars:
 *   RELAYPLANE_JEV_API_KEY     - THE gate. Absent => disabled (default).
 *   RELAYPLANE_JEV_ENDPOINT    - override endpoint (default TypeSafe System One).
 *   RELAYPLANE_JEV_MODEL       - override model id (default jev-latest).
 *   RELAYPLANE_JEV_TIMEOUT_MS  - override abort timeout (default 500, clamped).
 *
 * Matt's personal key lives at /home/coder/.config/typesafe/api_key on one box
 * only; it is deliberately NOT a default here. RelayPlane runs on other
 * people's machines that will not have any Jev key, and those installs must
 * stay on the free heuristic.
 */

export interface JevConfig {
  apiKey: string | null;
  endpoint: string;
  model: string;
  timeoutMs: number;
  enabled: boolean;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 500;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 2000;

export function loadJevConfig(env: Record<string, string | undefined> = process.env): JevConfig {
  const rawKey = env['RELAYPLANE_JEV_API_KEY'];
  const apiKey = rawKey && rawKey.trim().length > 0 ? rawKey.trim() : null;

  const endpointRaw = env['RELAYPLANE_JEV_ENDPOINT'];
  const endpoint = endpointRaw && endpointRaw.trim().length > 0 ? endpointRaw.trim() : DEFAULT_ENDPOINT;

  const modelRaw = env['RELAYPLANE_JEV_MODEL'];
  const model = modelRaw && modelRaw.trim().length > 0 ? modelRaw.trim() : DEFAULT_MODEL;

  const rawTimeout = parseInt(env['RELAYPLANE_JEV_TIMEOUT_MS'] ?? '', 10);
  const timeoutMs = isNaN(rawTimeout)
    ? DEFAULT_TIMEOUT_MS
    : Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, rawTimeout));

  return { apiKey, endpoint, model, timeoutMs, enabled: apiKey !== null };
}
