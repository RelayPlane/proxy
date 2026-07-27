import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Module under test (does not exist yet; import will fail, making the test fail)
import { track, getStats } from '../nudge.js';

describe('nudge', () => {
  let tmpDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-nudge-test-'));
    vi.stubEnv('RELAYPLANE_CONFIG_DIR', tmpDir);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('increments total_requests on each call', async () => {
    await track();
    await track();
    const stats = getStats();
    expect(stats.total_requests).toBe(2);
  });

  it('does not emit nudge before 100 requests', async () => {
    for (let i = 0; i < 99; i++) await track();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits nudge to stderr exactly once at the 100th request', async () => {
    for (let i = 0; i < 100; i++) await track();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = String((stderrSpy.mock.calls[0] as unknown[])[0]);
    expect(output).toMatch(/relayplane\.com\/claim\?d=/);
    expect(output).toMatch(/100\+ requests proxied/);
  });

  it('does not re-emit nudge at 200 requests', async () => {
    for (let i = 0; i < 200; i++) await track();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('writes claim_nudge_sent flag to stats.json after crossing 100', async () => {
    for (let i = 0; i < 100; i++) await track();
    const statsPath = path.join(tmpDir, 'stats.json');
    const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    expect(data.claim_nudge_sent).toBe(true);
  });

  it('persists device_id across calls', async () => {
    await track();
    const s1 = getStats();
    await track();
    const s2 = getStats();
    expect(s1.device_id).toBeTruthy();
    expect(s1.device_id).toBe(s2.device_id);
  });

  it('includes device_id in claim URL', async () => {
    for (let i = 0; i < 100; i++) await track();
    const output = String((stderrSpy.mock.calls[0] as unknown[])[0]);
    const stats = getStats();
    expect(output).toContain(stats.device_id);
  });
});
