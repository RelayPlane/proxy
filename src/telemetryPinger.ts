
import { loadConfig, saveConfig, ProxyConfig } from './config';
import fetch from 'node-fetch';

// This function needs to exist somewhere to get the current proxy version.
// Assuming it's in a utils or version file.
function getVersion(): string {
  try {
    const pkg = require('../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const PING_ENDPOINT = 'https://relayplane.com/api/v1/ping';

interface PingPayload {
  v: string;
  event: 'startup' | 'dashboard';
  did: string;
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


export async function sendPing(event: 'startup' | 'dashboard') {
  const config = loadConfig();

  if (!config.telemetry_enabled || config.telemetry_exclude) {
    return;
  }

  const now = new Date().toISOString();
  let configNeedsSave = false;

  if (event === 'startup') {
    if (!isDayElapsed(config.last_ping_date)) {
        return;
    }
    config.last_ping_date = now;
    configNeedsSave = true;
  }

  if (event === 'dashboard') {
    if (!isHourElapsed(config.last_dashboard_ping)) {
        return;
    }
    config.last_dashboard_ping = now;
    configNeedsSave = true;
  }

  const payload: PingPayload = {
    v: getVersion(),
    event,
    did: config.device_id,
  };

  try {
    const response = await fetch(PING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 2500,
    });

    if (response.ok && configNeedsSave) {
      saveConfig(config);
    } else if (!response.ok) {
        console.warn(`[Telemetry] Ping failed with status: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[Telemetry] Ping failed with network error.`);
  }
}
