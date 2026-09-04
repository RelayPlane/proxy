/**
 * Anonymous install ping.
 *
 * Posts { v, event, did } to relayplane.com/api/v1/ping at most once per
 * day on startup and once per hour on dashboard open. The marketing site
 * forwards it to the mesh API's anonymous telemetry table.
 *
 * Guarantees:
 *   - never throws, never blocks startup (2.5s timeout, errors swallowed)
 *   - never sends from CI / test runs (see isCiEnvironment)
 *   - failures are visible with RELAYPLANE_DEBUG=1 and are otherwise
 *     silent, so a dead endpoint cannot spam every startup again
 *     (the route 404'd from mid-2026 until 2026-09-04 and every start
 *     printed a warning)
 *   - endpoint overridable with RELAYPLANE_PING_URL for 4101 testing
 */

import { loadConfig, saveConfig, isCiEnvironment } from './config';
import fetch from 'node-fetch';

function getVersion(): string {
  try {
    const pkg = require('../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export const DEFAULT_PING_ENDPOINT = 'https://relayplane.com/api/v1/ping';

export function getPingEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['RELAYPLANE_PING_URL'];
  return override && override.trim() !== '' ? override.trim() : DEFAULT_PING_ENDPOINT;
}

export type PingEvent = 'startup' | 'dashboard';

export interface PingPayload {
  v: string;
  event: PingEvent;
  did: string;
}

export type PingResult =
  | { sent: false; reason: 'ci' | 'opted_out' | 'throttled' }
  | { sent: true; ok: boolean; status?: number; error?: string };

function debugLog(message: string): void {
  if (process.env['RELAYPLANE_DEBUG']) {
    console.warn(`[Telemetry] ${message}`);
  }
}

function isDayElapsed(lastPing?: string): boolean {
  if (!lastPing) return true;
  const lastDate = new Date(lastPing);
  const today = new Date();
  lastDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return today.getTime() > lastDate.getTime();
}

function isHourElapsed(lastPing?: string): boolean {
  if (!lastPing) return true;
  const oneHour = 60 * 60 * 1000;
  return (new Date().getTime() - new Date(lastPing).getTime()) > oneHour;
}

export async function sendPing(event: PingEvent): Promise<PingResult> {
  try {
    if (isCiEnvironment()) {
      debugLog(`ping '${event}' skipped: CI environment`);
      return { sent: false, reason: 'ci' };
    }

    const config = loadConfig();

    // Lifecycle pings are anonymous install/dashboard signals. They follow
    // the lifecycle_enabled flag (default on), NOT the per-request
    // telemetry_enabled flag, per the 2026-04-04 privacy spec.
    if (config.lifecycle_enabled === false || config.telemetry_exclude) {
      return { sent: false, reason: 'opted_out' };
    }

    const now = new Date().toISOString();

    if (event === 'startup') {
      if (!isDayElapsed(config.last_ping_date)) return { sent: false, reason: 'throttled' };
      config.last_ping_date = now;
    } else {
      if (!isHourElapsed(config.last_dashboard_ping)) return { sent: false, reason: 'throttled' };
      config.last_dashboard_ping = now;
    }

    const payload: PingPayload = { v: getVersion(), event, did: config.device_id };
    const endpoint = getPingEndpoint();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 2500,
      });

      if (response.ok) {
        // Only persist the throttle timestamp on success so a dead
        // endpoint is retried next start instead of silently dropped.
        saveConfig(config);
        debugLog(`ping '${event}' accepted (${response.status}) by ${endpoint}`);
        return { sent: true, ok: true, status: response.status };
      }

      debugLog(`ping '${event}' rejected with HTTP ${response.status} by ${endpoint}`);
      return { sent: true, ok: false, status: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`ping '${event}' failed: ${message} (${endpoint})`);
      return { sent: true, ok: false, error: message };
    }
  } catch (error) {
    // Config load/save problems must never surface to the proxy.
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`ping '${event}' aborted: ${message}`);
    return { sent: true, ok: false, error: message };
  }
}
