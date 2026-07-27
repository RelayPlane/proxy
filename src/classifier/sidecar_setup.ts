import type { SidecarLogger } from './sidecar_client.js';

export interface SidecarConfig {
  url: string | null;
  confidenceThreshold: number;
  timeoutMs: number;
  enabled: boolean;
}

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_TIMEOUT_MS = 200;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 2000;

export function loadSidecarConfig(env: Record<string, string | undefined> = process.env): SidecarConfig {
  const url = env['RELAYPLANE_SIDECAR_URL'] ?? null;

  const rawThreshold = parseFloat(env['RELAYPLANE_SIDECAR_CONFIDENCE_THRESHOLD'] ?? '');
  const confidenceThreshold = isNaN(rawThreshold)
    ? DEFAULT_THRESHOLD
    : Math.max(0, Math.min(1, rawThreshold));

  const rawTimeout = parseInt(env['RELAYPLANE_SIDECAR_TIMEOUT_MS'] ?? '', 10);
  const timeoutMs = isNaN(rawTimeout)
    ? DEFAULT_TIMEOUT_MS
    : Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, rawTimeout));

  return { url, confidenceThreshold, timeoutMs, enabled: url !== null };
}

export async function probeSidecar(
  url: string,
  timeoutMs: number,
  logger: SidecarLogger
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (res.ok) {
      if (logger.info) logger.info(`[sidecar] sidecar reachable at ${url}`);
    }
    return res.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logger.debug) logger.debug(`[sidecar] probe failed: ${msg}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function bootstrapSidecar(logger: SidecarLogger): Promise<SidecarConfig> {
  const config = loadSidecarConfig();
  if (config.enabled && config.url) {
    const reachable = await probeSidecar(config.url, config.timeoutMs, logger);
    if (!reachable) {
      if (logger.warn) logger.warn('[sidecar] sidecar unreachable at startup, will use regex fallback');
    } else {
      if (logger.info) logger.info(`[sidecar] sidecar reachable at ${config.url}`);
    }
  }
  return config;
}
