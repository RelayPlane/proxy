/**
 * P0-2 (install test 2026-09-04, matrix row 4a, fix list #2):
 * non-interactive `relayplane init` wrote routing.complexity tiers as
 * { description: "..." } objects the proxy cannot parse. Every start then
 * logged four `[parseComplexityModel] Unknown provider "undefined"` warnings
 * plus `Auto-routing: simple=undefined ...`, and relayplane:auto / rp:* on
 * non-Anthropic installs routed to anthropic/unknown.
 *
 * Contract: init emits valid tiers for whichever providers the user has keys
 * for, and a start on that config is warning-free.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cliPath, packageRoot, makeHome, cleanEnv, spawnProxy, type SpawnedProxy } from './helpers/p0-harness.js';

function runInit(home: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [cliPath, 'init'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: cleanEnv(home, env),
    stdio: ['ignore', 'pipe', 'pipe'], // no TTY => non-interactive path
  });
}

function readTiers(configPath: string): Record<string, unknown> {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { routing?: { complexity?: Record<string, unknown> } };
  return cfg.routing?.complexity ?? {};
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('relayplane init (non-TTY) writes tiers the proxy can parse', () => {
  it('OpenRouter-only: every tier is an "openrouter/..." model string, no description objects', () => {
    const { home, configPath } = makeHome();
    homes.push(home);
    const res = runInit(home, { OPENROUTER_API_KEY: 'sk-or-dummy' });
    expect(res.status, res.stderr).toBe(0);
    const tiers = readTiers(configPath);
    for (const tier of ['simple', 'moderate', 'complex', 'elite']) {
      const v = tiers[tier];
      expect(typeof v, `${tier} should be a string, got ${JSON.stringify(v)}`).toBe('string');
      expect(v as string).toMatch(/^openrouter\/.+\/.+/);
    }
    expect(JSON.stringify(tiers)).not.toContain('description');
  });

  it('OpenAI-only: tiers are "openai/gpt-..." strings', () => {
    const { home, configPath } = makeHome();
    homes.push(home);
    const res = runInit(home, { OPENAI_API_KEY: 'sk-dummy' });
    expect(res.status, res.stderr).toBe(0);
    const tiers = readTiers(configPath);
    for (const tier of ['simple', 'moderate', 'complex', 'elite']) {
      expect(tiers[tier]).toMatch(/^openai\/gpt-/);
    }
  });

  it('no keys at all (Claude Code Max plan): tiers are claude-* strings the passthrough path can serve', () => {
    const { home, configPath } = makeHome();
    homes.push(home);
    const res = runInit(home, {});
    expect(res.status, res.stderr).toBe(0);
    const tiers = readTiers(configPath);
    for (const tier of ['simple', 'moderate', 'complex', 'elite']) {
      expect(tiers[tier]).toMatch(/^claude-/);
    }
    // Haiku is not available on Max plan OAuth: simple must not be haiku here.
    expect(tiers['simple']).not.toMatch(/haiku/);
  });
});

describe('start on an init-written config is warning-free', () => {
  let proxy: SpawnedProxy | undefined;
  afterEach(async () => { await proxy?.stop(); proxy = undefined; });

  it('OpenRouter-only init + start: no Unknown provider warnings, tiers resolved', async () => {
    const { home } = makeHome();
    const res = runInit(home, { OPENROUTER_API_KEY: 'sk-or-dummy' });
    expect(res.status).toBe(0);
    proxy = await spawnProxy({ home, env: { OPENROUTER_API_KEY: 'sk-or-dummy' } });
    const out = proxy.output();
    expect(out).not.toMatch(/Unknown provider/);
    expect(out).not.toMatch(/=undefined/);
    expect(out).toMatch(/Auto-routing: simple=google\/gemini/);
  }, 30_000);

  it('a hand-edited config with junk tiers gets an actionable warning naming the key', async () => {
    const { home } = makeHome({
      config_version: 4,
      routing: { complexity: { enabled: true, simple: { description: 'nope' }, moderate: 42 } },
    });
    proxy = await spawnProxy({ home, env: { OPENAI_API_KEY: 'sk-dummy' } });
    const out = proxy.output();
    expect(out).toMatch(/routing\.complexity\.simple/);
    expect(out).toMatch(/routing\.complexity\.moderate/);
    expect(out).toMatch(/provider\/model/);
    expect(out).not.toMatch(/Unknown provider "undefined"/);
  }, 30_000);
});
