import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export const CLAIM_NUDGE_THRESHOLD = 100;

interface NudgeStats {
  device_id: string;
  total_requests: number;
  claim_nudge_sent: boolean;
}

function getConfigDir(): string {
  // Inner tests use RELAYPLANE_CONFIG_DIR; outer tests use RELAYPLANE_HOME_OVERRIDE
  return (
    process.env['RELAYPLANE_CONFIG_DIR'] ??
    process.env['RELAYPLANE_HOME_OVERRIDE'] ??
    path.join(os.homedir(), '.relayplane')
  );
}

function getStatsPath(): string {
  return path.join(getConfigDir(), 'stats.json');
}

function generateDeviceId(): string {
  const bytes = crypto.randomBytes(16);
  return `anon_${bytes.toString('hex').slice(0, 16)}`;
}

function loadStats(): NudgeStats {
  try {
    const statsPath = getStatsPath();
    if (fs.existsSync(statsPath)) {
      const raw = fs.readFileSync(statsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NudgeStats>;
      return {
        device_id: parsed.device_id ?? generateDeviceId(),
        total_requests: parsed.total_requests ?? 0,
        claim_nudge_sent: parsed.claim_nudge_sent ?? false,
      };
    }
  } catch {
    // fall through to fresh stats
  }
  return { device_id: generateDeviceId(), total_requests: 0, claim_nudge_sent: false };
}

function saveStats(stats: NudgeStats): void {
  try {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getStatsPath(), JSON.stringify(stats, null, 2), 'utf8');
  } catch {
    // Never break the proxy over nudge persistence
  }
}

export function track(): void {
  try {
    const stats = loadStats();
    stats.total_requests += 1;

    if (stats.total_requests === CLAIM_NUDGE_THRESHOLD && !stats.claim_nudge_sent) {
      stats.claim_nudge_sent = true;
      saveStats(stats);
      process.stderr.write(
        `\n[relayplane] 100+ requests proxied. Claim your dashboard: relayplane.com/claim?d=${stats.device_id}\n\n`
      );
      return;
    }

    saveStats(stats);
  } catch {
    // Never throw; nudge is non-critical
  }
}

export function getStats(): NudgeStats {
  return loadStats();
}
