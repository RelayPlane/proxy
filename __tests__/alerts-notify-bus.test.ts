import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

import { AlertManager } from '../src/alerts.js';

describe('notification bus delivery', () => {
  beforeEach(() => execFile.mockReset());
  afterEach(() => vi.restoreAllMocks());

  function complete(error: Error | null, stdout: string): void {
    const callback = execFile.mock.calls[0]![3] as (error: Error | null, stdout: string) => void;
    callback(error, stdout);
  }

  it('is opt-in and disabled alerts never publish', () => {
    new AlertManager({ enabled: true }).fireBreach('daily', 500, 500);
    new AlertManager({ notifyCliPath: '/notify-cli.py' }).fireBreach('daily', 500, 500);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('publishes a critical breach through the canonical bus without a shell', () => {
    const manager = new AlertManager({ enabled: true, notifyCliPath: '/clawd/notify-cli.py' });
    const alert = manager.fireBreach('daily', 500, 500)!;
    expect(execFile).toHaveBeenCalledWith('python3', [
      '/clawd/notify-cli.py', 'publish', '--class', 'INFRA-CRITICAL',
      '--source', 'relayplane', '--kind', 'breach',
      '--title', 'RelayPlane breach', '--body', alert.message,
      '--dedup-key', 'relayplane:breach:daily:',
    ], { timeout: 30_000, maxBuffer: 64 * 1024 }, expect.any(Function));
    expect(alert.delivered).toBe(false);
    complete(null, 'notify-cli: published id=1 delivered=True');
    expect(manager.getRecent()[0]!.delivered).toBe(true);
    manager.fireBreach('daily', 501, 500);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(['notify-cli: published id=1 delivered=False', 'notify-cli: suppressed (dedup), existing id=1'])(
    'does not claim Telegram delivery for %s', (stdout) => {
      const manager = new AlertManager({ enabled: true, notifyCliPath: '/notify-cli.py' });
      const alert = manager.fireThreshold(80, 80, 400, 500)!;
      expect(execFile.mock.calls[0]![1]).toContain('BRIEF');
      complete(null, stdout);
      expect(alert.delivered).toBe(false);
    },
  );

  it('handles missing notifier or timeout without leaking subprocess output', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new AlertManager({ enabled: true, notifyCliPath: '/notify-cli.py' });
    const alert = manager.fireAnomaly({ type: 'repetition', severity: 'critical', message: 'loop', data: {} })!;
    complete(new Error('private output'), 'private output');
    expect(alert.delivered).toBe(false);
    expect(warn).toHaveBeenCalledWith('[RelayPlane Alerts] Notification bus publish failed');
  });

  it('rejects a relative notifier path', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    new AlertManager({ enabled: true, notifyCliPath: 'notify-cli.py' }).fireBreach('daily', 500, 500);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([true, false])('only marks successful HTTP responses delivered (ok=%s)', async (ok) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok } as Response);
    const alert = new AlertManager({ enabled: true, webhookUrl: 'https://invalid.example' }).fireBreach('daily', 500, 500)!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alert.delivered).toBe(ok);
  });
});
