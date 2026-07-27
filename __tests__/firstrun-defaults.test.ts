/**
 * TDD Phase 1: Failing tests for PR C, first-run 4-tier defaults +
 * routing.preferred_provider = "auto".
 *
 * Spec: state/clients/relayplane/model-routing-modernization-plan-2026-06-09.md
 *
 * Contract:
 *   1. On a FRESH install (no ~/.relayplane/config.json), `relayplane init`
 *      run non-interactively MUST write:
 *        - routing.preferred_provider: "auto"
 *        - a 4-tier complexity scheme that includes the new "elite" tier
 *          (simple, moderate, complex, elite) - PR B prerequisite.
 *      All silently, no prompt.
 *
 *   2. An EXISTING config that does NOT contain routing.preferred_provider
 *      MUST be left untouched by a re-run of `relayplane init`. Absence of
 *      preferred_provider means "current behavior" - we must not retro-fit
 *      the new default onto existing configs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const packageRoot = join(__dirname, '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

// Isolated HOME so we never touch the developer's real ~/.relayplane
const testHome = join(tmpdir(), `relayplane-firstrun-${process.pid}`);
const configDir = join(testHome, '.relayplane');
const configPath = join(configDir, 'config.json');

function runInit(extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, 'init'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: testHome,
      // Force non-interactive path: no TTY because spawnSync doesn't give us one,
      // and explicitly scrub keys so the OpenRouter-only branch doesn't fire.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GOOGLE_API_KEY: '',
      GEMINI_API_KEY: '',
      XAI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      GROQ_API_KEY: '',
      ...extraEnv,
    },
  });
}

beforeAll(() => {
  // Sanity: tests assume the CLI has been built (pnpm test runs `tsc` first)
  if (!existsSync(cliPath)) {
    throw new Error(
      `CLI artifact missing at ${cliPath}. Build with \`pnpm --filter @relayplane/proxy build\` before running this test.`
    );
  }
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh test home for every case
  rmSync(testHome, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
});

describe('PR C, first-run 4-tier defaults + preferred_provider=auto', () => {
  describe('fresh install', () => {
    it('writes routing.preferred_provider = "auto" silently', () => {
      const res = runInit();
      expect(res.status).toBe(0);
      expect(existsSync(configPath)).toBe(true);

      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const routing = cfg['routing'] as Record<string, unknown> | undefined;
      expect(routing).toBeDefined();
      expect(routing?.['preferred_provider']).toBe('auto');
    });

    it('writes a 4-tier complexity scheme including "elite"', () => {
      const res = runInit();
      expect(res.status).toBe(0);

      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

      // The 4 tiers must be reachable through the config. Implementations may
      // place them under routing.complexity, complexity, or model_tiers - the
      // contract only requires that all four named tiers are present
      // somewhere in the written config.
      const flat = JSON.stringify(cfg);
      expect(flat).toMatch(/"simple"/);
      expect(flat).toMatch(/"moderate"/);
      expect(flat).toMatch(/"complex"/);
      expect(flat).toMatch(/"elite"/);
    });

    it('does not prompt the user (non-interactive completes immediately)', () => {
      const res = runInit();
      expect(res.status).toBe(0);
      // No interactive prompt markers should appear in stdout.
      expect(res.stdout).not.toMatch(/\? Anthropic API key/);
      expect(res.stdout).not.toMatch(/Write config and finish/);
    });
  });

  describe('existing config (no preferred_provider) is left alone', () => {
    it('does not add preferred_provider to a pre-existing config', () => {
      // Seed an existing config without preferred_provider
      const seeded = {
        device_id: 'pre-existing-device',
        budget: { enabled: true, dailyUsd: 5, onBreach: 'downgrade' },
        providers: {
          anthropic: { accounts: [{ label: 'default', apiKey: 'sk-ant-existing' }] },
        },
      };
      writeFileSync(configPath, JSON.stringify(seeded, null, 2) + '\n');
      const before = readFileSync(configPath, 'utf-8');

      const res = runInit();
      expect(res.status).toBe(0);

      const after = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      // Original fields preserved
      expect(after['device_id']).toBe('pre-existing-device');
      const providers = after['providers'] as Record<string, unknown>;
      const anthropic = providers['anthropic'] as Record<string, unknown>;
      const accounts = anthropic['accounts'] as Array<{ apiKey: string }>;
      expect(accounts[0]?.apiKey).toBe('sk-ant-existing');

      // CRITICAL: preferred_provider must NOT have been retro-fitted.
      // Absence of routing.preferred_provider must continue to mean
      // "current behavior" for existing installs.
      const routing = after['routing'] as Record<string, unknown> | undefined;
      const preferred = routing?.['preferred_provider'];
      expect(preferred).toBeUndefined();

      // And the file should be functionally unchanged. We compare the
      // parsed shape (whitespace-tolerant) - any field added by init on
      // top of a pre-existing config is a regression of this contract.
      const beforeParsed = JSON.parse(before);
      const afterParsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(afterParsed).toEqual(beforeParsed);
    });
  });
});
