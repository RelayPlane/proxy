/**
 * Install ping: never crashes, never sends from CI, failures visible in
 * debug log only, throttle timestamp persisted only on success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fetchMock = vi.fn();
vi.mock('node-fetch', () => ({ default: (...args: unknown[]) => fetchMock(...args) }));

const CI_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'TRAVIS', 'JENKINS_URL', 'TF_BUILD', 'VITEST', 'RELAYPLANE_CI'];

describe('sendPing', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ping-'));
    for (const k of [...CI_KEYS, 'RELAYPLANE_HOME_OVERRIDE', 'RELAYPLANE_DEBUG', 'RELAYPLANE_PING_URL']) saved[k] = process.env[k];
    for (const k of CI_KEYS) delete process.env[k];
    delete process.env['RELAYPLANE_DEBUG'];
    delete process.env['RELAYPLANE_PING_URL'];
    process.env['RELAYPLANE_HOME_OVERRIDE'] = tmp;
    fetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('posts { v, event, did } to the default endpoint and persists the throttle on 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { sendPing, DEFAULT_PING_ENDPOINT } = await import('../src/telemetryPinger.js');
    const result = await sendPing('startup');
    expect(result).toEqual({ sent: true, ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; method: string }];
    expect(url).toBe(DEFAULT_PING_ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['did', 'event', 'v']);
    expect(body.event).toBe('startup');
    expect(body.did).toMatch(/^anon_/);
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().last_ping_date).toBeTruthy();
  });

  it('skips entirely under CI and does not touch the network', async () => {
    process.env['CI'] = 'true';
    const { sendPing } = await import('../src/telemetryPinger.js');
    expect(await sendPing('startup')).toEqual({ sent: false, reason: 'ci' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on HTTP 404 it does not throw, does not persist, and stays silent without RELAYPLANE_DEBUG', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendPing } = await import('../src/telemetryPinger.js');
    expect(await sendPing('startup')).toEqual({ sent: true, ok: false, status: 404 });
    expect(warn).not.toHaveBeenCalled();
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().last_ping_date).toBeUndefined();
  });

  it('on HTTP 404 with RELAYPLANE_DEBUG=1 the failure is logged', async () => {
    process.env['RELAYPLANE_DEBUG'] = '1';
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendPing } = await import('../src/telemetryPinger.js');
    await sendPing('startup');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/HTTP 404/);
  });

  it('on a network error it resolves instead of rejecting', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { sendPing } = await import('../src/telemetryPinger.js');
    await expect(sendPing('dashboard')).resolves.toEqual({ sent: true, ok: false, error: 'ECONNREFUSED' });
  });

  it('honours RELAYPLANE_PING_URL for local 4101 testing', async () => {
    process.env['RELAYPLANE_PING_URL'] = 'http://127.0.0.1:4101/api/v1/ping';
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { sendPing } = await import('../src/telemetryPinger.js');
    await sendPing('startup');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://127.0.0.1:4101/api/v1/ping');
  });

  it('throttles a second startup ping on the same day', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { sendPing } = await import('../src/telemetryPinger.js');
    await sendPing('startup');
    expect(await sendPing('startup')).toEqual({ sent: false, reason: 'throttled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
