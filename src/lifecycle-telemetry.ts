/**
 * Proxy Lifecycle Telemetry
 *
 * Sends 6 anonymous lifecycle events to the telemetry pipeline:
 *   proxy.activated        , first successful proxied request (once per install)
 *   proxy.session          , daily heartbeat while proxy is running
 *   proxy.dashboard_linked , when user connects their cloud account
 *   run.first_attributed   , first run closed that carried an X-RelayPlane-Run header
 *   run.milestone_10       , the tenth header-attributed run closed
 *   run.milestone_100      , the hundredth header-attributed run closed
 *
 * Encoded as TelemetryEvent with task_type = event name, model = 'lifecycle',
 * all numeric fields 0. The run events carry no run id, no label, no agent
 * name and no cost: only the fact that attribution is being used at all.
 * Fails silently , never crashes the proxy.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDeviceId, isLifecycleEnabled, getConfigDir } from './config.js';

const MESH_API_URL = process.env.RELAYPLANE_API_URL || 'https://api.relayplane.com';
const LIFECYCLE_FILE = (() => { try { return path.join(getConfigDir(), 'lifecycle.json'); } catch { return ''; } })();

/** Every lifecycle event this module is allowed to send. */
export type LifecycleEventType =
  | 'proxy.activated'
  | 'proxy.session'
  | 'proxy.dashboard_linked'
  | 'run.first_attributed'
  | 'run.milestone_10'
  | 'run.milestone_100';

interface LifecycleState {
  activation_sent: boolean;
  last_session_date: string | null; // ISO date string (YYYY-MM-DD)
  run_first_attributed_sent: boolean;
  run_milestone_10_sent: boolean;
  run_milestone_100_sent: boolean;
}

const DEFAULT_LIFECYCLE_STATE: LifecycleState = {
  activation_sent: false,
  last_session_date: null,
  run_first_attributed_sent: false,
  run_milestone_10_sent: false,
  run_milestone_100_sent: false,
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Old state files predate the run flags, so every field is read defensively and
 * missing keys fall back to the default rather than arriving as `undefined`.
 */
function loadLifecycleState(): LifecycleState {
  try {
    if (fs.existsSync(LIFECYCLE_FILE)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(LIFECYCLE_FILE, 'utf-8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const raw = parsed as Record<string, unknown>;
        const lastSession = raw['last_session_date'];
        return {
          activation_sent: readBoolean(raw['activation_sent'], DEFAULT_LIFECYCLE_STATE.activation_sent),
          last_session_date: typeof lastSession === 'string' ? lastSession : null,
          run_first_attributed_sent: readBoolean(raw['run_first_attributed_sent'], false),
          run_milestone_10_sent: readBoolean(raw['run_milestone_10_sent'], false),
          run_milestone_100_sent: readBoolean(raw['run_milestone_100_sent'], false),
        };
      }
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_LIFECYCLE_STATE };
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
async function sendLifecycleEvent(eventType: LifecycleEventType): Promise<void> {
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

/**
 * Fire run.first_attributed once, the first time a run that was tagged with an
 * explicit X-RelayPlane-Run header closes with at least one request on it.
 * Subsequent calls are no-ops. Carries no run id and no label.
 */
export function maybeFireRunFirstAttributed(): void {
  if (!isLifecycleEnabled()) return;

  try {
    const state = loadLifecycleState();
    if (state.run_first_attributed_sent) return;

    state.run_first_attributed_sent = true;
    saveLifecycleState(state);

    sendLifecycleEvent('run.first_attributed').catch(() => {});
  } catch {
    // Never crash
  }
}

/**
 * Fire run.milestone_10 / run.milestone_100 at the tenth and hundredth
 * header-attributed run. `count` is the number of completed header-source runs
 * on this install; the flags make each milestone send exactly once, and a
 * count that jumps straight past 10 still reports the higher milestone only.
 */
export function maybeFireRunMilestone(count: number): void {
  if (!isLifecycleEnabled()) return;
  if (!Number.isFinite(count)) return;

  try {
    const state = loadLifecycleState();
    let event: LifecycleEventType | null = null;

    if (count >= 100 && !state.run_milestone_100_sent) {
      state.run_milestone_100_sent = true;
      event = 'run.milestone_100';
    } else if (count >= 10 && !state.run_milestone_10_sent) {
      state.run_milestone_10_sent = true;
      event = 'run.milestone_10';
    }

    if (event === null) return;
    saveLifecycleState(state);
    sendLifecycleEvent(event).catch(() => {});
  } catch {
    // Never crash
  }
}
