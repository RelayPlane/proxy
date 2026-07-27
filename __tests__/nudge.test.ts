/**
 * Tests for the claim nudge feature (rp-proxy-cli-nudge-100-requests)
 *
 * Covers:
 *  1. track() increments total_requests in stats.json correctly
 *  2. nudge fires exactly once when total_requests crosses 100
 *  3. nudge does NOT fire before 100 requests
 *  4. nudge does NOT re-fire at 200 requests (claim_nudge_sent gate)
 *  5. claim_nudge_sent flag is written to stats.json on first fire
 *  6. nudge goes to stderr, not stdout
 *  7. nudge message contains relayplane.com/claim?d=<device_id>
 *  8. try/catch: file-system errors never throw / break the proxy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
let originalOverride: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-nudge-test-'));
  originalOverride = process.env['RELAYPLANE_HOME_OVERRIDE'];
  process.env['RELAYPLANE_HOME_OVERRIDE'] = tmpDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalOverride === undefined) {
    delete process.env['RELAYPLANE_HOME_OVERRIDE'];
  } else {
    process.env['RELAYPLANE_HOME_OVERRIDE'] = originalOverride;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readStats(dir: string): Record<string, unknown> {
  const p = path.join(dir, 'stats.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ── track(): counter increments ───────────────────────────────────────────────

describe('nudge: track() increments total_requests', () => {
  it('creates stats.json on first call with total_requests = 1', async () => {
    const { track } = await import('../src/nudge.js');
    track();
    const stats = readStats(tmpDir);
    expect(stats.total_requests).toBe(1);
  });

  it('increments total_requests on each call', async () => {
    const { track } = await import('../src/nudge.js');
    track();
    track();
    track();
    const stats = readStats(tmpDir);
    expect(stats.total_requests).toBe(3);
  });

  it('persists a stable device_id across calls', async () => {
    const { track } = await import('../src/nudge.js');
    track();
    track();
    const stats1 = readStats(tmpDir);
    track();
    const stats2 = readStats(tmpDir);
    expect(stats1.device_id).toBeDefined();
    expect(stats2.device_id).toBe(stats1.device_id);
  });
});

// ── track(): nudge threshold ──────────────────────────────────────────────────

describe('nudge: fires at 100, not before', () => {
  it('does NOT emit to stderr before 100 requests', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 99; i++) track();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits to stderr on exactly the 100th request', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('emits exactly once even when called 200 times total', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 200; i++) track();

    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});

// ── claim_nudge_sent flag ─────────────────────────────────────────────────────

describe('nudge: claim_nudge_sent flag prevents re-fire', () => {
  it('writes claim_nudge_sent: true to stats.json after firing', async () => {
    const { track } = await import('../src/nudge.js');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    const stats = readStats(tmpDir);
    expect(stats.claim_nudge_sent).toBe(true);
  });

  it('does NOT write claim_nudge_sent before 100 requests', async () => {
    const { track } = await import('../src/nudge.js');

    for (let i = 0; i < 99; i++) track();

    const stats = readStats(tmpDir);
    expect(stats.claim_nudge_sent).toBeFalsy();
  });

  it('does not re-fire when stats.json already has claim_nudge_sent: true on fresh module load', async () => {
    // Pre-write stats.json with claim_nudge_sent and high count
    fs.writeFileSync(
      path.join(tmpDir, 'stats.json'),
      JSON.stringify({ device_id: 'existing-device', total_requests: 150, claim_nudge_sent: true }),
      'utf-8'
    );

    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    track(); // count goes to 151, but flag is already set

    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ── nudge output format ───────────────────────────────────────────────────────

describe('nudge: output format', () => {
  it('message contains relayplane.com/claim', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('relayplane.com/claim');
  });

  it('message contains the device_id as query param', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    const stats = readStats(tmpDir);
    const deviceId = stats.device_id as string;
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain(`?d=${deviceId}`);
  });

  it('message contains [relayplane] prefix', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[relayplane]');
  });

  it('nudge goes to STDERR, not stdout', async () => {
    const { track } = await import('../src/nudge.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    for (let i = 0; i < 100; i++) track();

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ── error resilience ──────────────────────────────────────────────────────────

describe('nudge: never throws on fs errors', () => {
  it('track() does not throw when config dir is not writable', async () => {
    process.env['RELAYPLANE_HOME_OVERRIDE'] = '/root/no-such-dir-rp-99999';
    const { track } = await import('../src/nudge.js');

    expect(() => track()).not.toThrow();
  });
});

// ── CLAIM_NUDGE_THRESHOLD constant ────────────────────────────────────────────

describe('nudge: CLAIM_NUDGE_THRESHOLD constant', () => {
  it('CLAIM_NUDGE_THRESHOLD is 100', async () => {
    const { CLAIM_NUDGE_THRESHOLD } = await import('../src/nudge.js');
    expect(CLAIM_NUDGE_THRESHOLD).toBe(100);
  });
});
