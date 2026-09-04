/**
 * CI device-id pollution guard.
 *
 * Lifecycle telemetry used to mint an `anon_` device id per config dir,
 * so every CI job looked like a new install. In CI we tag ids `ci_` and
 * suppress lifecycle sends. Both paths are tested here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CI_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'TRAVIS', 'JENKINS_URL', 'TF_BUILD', 'VITEST', 'RELAYPLANE_CI'];

function withoutCi(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const k of CI_KEYS) delete copy[k];
  return copy;
}

describe('isCiEnvironment', () => {
  it('is false when no CI marker is set', async () => {
    const { isCiEnvironment } = await import('../src/config.js');
    expect(isCiEnvironment(withoutCi(process.env))).toBe(false);
  });

  it.each([
    ['CI', 'true'],
    ['CI', '1'],
    ['GITHUB_ACTIONS', 'true'],
    ['GITLAB_CI', 'true'],
    ['CIRCLECI', 'true'],
    ['BUILDKITE', 'true'],
    ['TRAVIS', 'true'],
    ['JENKINS_URL', 'https://ci.example'],
    ['TF_BUILD', 'True'],
    ['VITEST', 'true'],
    ['RELAYPLANE_CI', '1'],
  ])('is true when %s=%s', async (key, value) => {
    const { isCiEnvironment } = await import('../src/config.js');
    expect(isCiEnvironment({ ...withoutCi(process.env), [key]: value })).toBe(true);
  });

  it('treats CI=false and CI=0 as not CI', async () => {
    const { isCiEnvironment } = await import('../src/config.js');
    expect(isCiEnvironment({ ...withoutCi(process.env), CI: 'false' })).toBe(false);
    expect(isCiEnvironment({ ...withoutCi(process.env), CI: '0' })).toBe(false);
  });

  it('detects the real vitest run we are inside of', async () => {
    const { isCiEnvironment } = await import('../src/config.js');
    expect(isCiEnvironment()).toBe(true);
  });
});

describe('generateDeviceId', () => {
  it('uses the anon_ prefix outside CI', async () => {
    const { generateDeviceId } = await import('../src/config.js');
    expect(generateDeviceId(withoutCi(process.env))).toMatch(/^anon_[0-9a-f]{16}$/);
  });

  it('uses the ci_ prefix inside CI so analytics can exclude it', async () => {
    const { generateDeviceId } = await import('../src/config.js');
    expect(generateDeviceId({ ...withoutCi(process.env), CI: 'true' })).toMatch(/^ci_[0-9a-f]{16}$/);
  });

  it('is random per call (no fingerprinting)', async () => {
    const { generateDeviceId } = await import('../src/config.js');
    expect(generateDeviceId()).not.toBe(generateDeviceId());
  });
});

describe('lifecycle telemetry in CI', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ci-guard-'));
    for (const k of [...CI_KEYS, 'RELAYPLANE_HOME_OVERRIDE']) saved[k] = process.env[k];
    process.env['RELAYPLANE_HOME_OVERRIDE'] = tmp;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('isLifecycleEnabled is false under CI even with lifecycle_enabled=true', async () => {
    process.env['CI'] = 'true';
    const cfg = await import('../src/config.js');
    expect(cfg.loadConfig().lifecycle_enabled).toBe(true);
    expect(cfg.isLifecycleEnabled()).toBe(false);
  });

  it('isLifecycleEnabled is true outside CI with default config', async () => {
    for (const k of CI_KEYS) delete process.env[k];
    const cfg = await import('../src/config.js');
    expect(cfg.isLifecycleEnabled()).toBe(true);
  });

  it('a fresh config created in CI gets a ci_ device id', async () => {
    process.env['CI'] = 'true';
    const cfg = await import('../src/config.js');
    expect(cfg.loadConfig().device_id).toMatch(/^ci_/);
  });

  it('a fresh config created outside CI gets an anon_ device id', async () => {
    for (const k of CI_KEYS) delete process.env[k];
    const cfg = await import('../src/config.js');
    expect(cfg.loadConfig().device_id).toMatch(/^anon_/);
  });

  it('maybeSendSessionHeartbeat does not fetch under CI', async () => {
    process.env['CI'] = 'true';
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const lifecycle = await import('../src/lifecycle-telemetry.js');
    lifecycle.maybeSendSessionHeartbeat();
    lifecycle.maybeFireActivated();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maybeSendSessionHeartbeat fetches outside CI', async () => {
    for (const k of CI_KEYS) delete process.env[k];
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const lifecycle = await import('../src/lifecycle-telemetry.js');
    lifecycle.maybeSendSessionHeartbeat();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown[])[1] ? String(((fetchSpy.mock.calls[0] as unknown[])[1] as { body: string }).body) : '{}');
    expect(body.events[0].task_type).toBe('proxy.session');
    expect(body.events[0].device_id).toMatch(/^anon_/);
    vi.unstubAllGlobals();
  });
});
