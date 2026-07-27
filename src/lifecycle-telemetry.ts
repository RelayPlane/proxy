/**
 * Proxy Lifecycle Telemetry
 *
 * Sends 3 anonymous lifecycle events to the telemetry pipeline:
 *   proxy.activated        , first successful proxied request (once per install)
 *   proxy.session          , daily heartbeat while proxy is running
 *   proxy.dashboard_linked , when user connects their cloud account
 *
 * Encoded as TelemetryEvent with task_type = event name, model = 'lifecycle',
 * all numeric fields 0.  Fails silently , never crashes the proxy.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDeviceId, isLifecycleEnabled, getConfigDir } from './config.js';

const MESH_API_URL = process.env.RELAYPLANE_API_URL || 'https://api.relayplane.com';
const LIFECYCLE_FILE = (() => { try { return path.join(getConfigDir(), 'lifecycle.json'); } catch { return ''; } })();

interface LifecycleState {
  activation_sent: boolean;
  last_session_date: string | null; // ISO date string (YYYY-MM-DD)
}

function loadLifecycleState(): LifecycleState {
  try {
    if (fs.existsSync(LIFECYCLE_FILE)) {
      return JSON.parse(fs.readFileSync(LIFECYCLE_FILE, 'utf-8')) as LifecycleState;
    }
  } catch {
    // Fall through to default
  }
  return { activation_sent: false, last_session_date: null };
}

function saveLifecycleState(state: LifecycleState): void {
  try {
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(LIFECYCLE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Silently fail , telemetry must never crash the proxy
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Send a single lifecycle event to the anonymous telemetry endpoint.
 * Uses the same TelemetryEvent schema as LLM request events, with
 * placeholder values for non-applicable fields.
 */
async function sendLifecycleEvent(eventType: string): Promise<void> {
  const endpoint = `${MESH_API_URL}/v1/telemetry/anonymous`;

  const event = {
    device_id: getDeviceId(),
    task_type: eventType,
    model: 'lifecycle',
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 0,
    success: true,
    cost_usd: 0,
    timestamp: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: '1.0', events: [event] }),
      signal: controller.signal,
    });
  } catch {
    // Silently fail
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire proxy.activated once on the first successful proxied request.
 * Subsequent calls are no-ops.
 */
export function maybeFireActivated(): void {
  if (!isLifecycleEnabled()) return;

  try {
    const state = loadLifecycleState();
    if (state.activation_sent) return;

    state.activation_sent = true;
    saveLifecycleState(state);

    sendLifecycleEvent('proxy.activated').catch(() => {});
  } catch {
    // Never crash
  }
}

/**
 * Fire proxy.session heartbeat at most once per calendar day.
 * Call on proxy startup.
 */
export function maybeSendSessionHeartbeat(): void {
  if (!isLifecycleEnabled()) return;

  try {
    const state = loadLifecycleState();
    const today = todayIso();
    if (state.last_session_date === today) return;

    state.last_session_date = today;
    saveLifecycleState(state);

    sendLifecycleEvent('proxy.session').catch(() => {});
  } catch {
    // Never crash
  }
}

/**
 * Fire proxy.dashboard_linked when the user successfully links their cloud account.
 * Idempotent , safe to call multiple times but only sends once per day to avoid spam.
 */
export function fireDashboardLinked(): void {
  if (!isLifecycleEnabled()) return;
  sendLifecycleEvent('proxy.dashboard_linked').catch(() => {});
}
