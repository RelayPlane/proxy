import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = join(__dirname, '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'relayplane-codex-setup-'));
  homes.push(home);
  return home;
}

function runCodexSetup(home: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, 'codex', ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ZAI_API_KEY: 'test-zai',
      MINIMAX_API_KEY: 'test-minimax',
      BYTEPLUS_API_KEY: 'test-byteplus',
      DEEPSEEK_API_KEY: 'test-deepseek',
    },
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('relayplane codex setup', () => {
  it('configures a Responses provider and multi-provider subagents without changing the primary model', () => {
    const home = newHome();
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-primary"\nmodel_reasoning_effort = "high"\n');

    const result = runCodexSetup(home, ['up', '--global', '--foreground']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('primary Codex provider unchanged');
    const codexConfig = readFileSync(join(codexDir, 'config.toml'), 'utf8');
    expect(codexConfig).toContain('model = "gpt-primary"');
    expect(codexConfig).toContain('[model_providers.relayplane]');
    expect(codexConfig).toContain('base_url = "http://127.0.0.1:4100/v1"');
    expect(codexConfig).toContain('wire_api = "responses"');
    expect(codexConfig).not.toMatch(/^model_provider\s*=/m);

    const switchAgent = readFileSync(join(codexDir, 'agents', 'switch-pro.toml'), 'utf8');
    expect(switchAgent).toContain('model = "switch/pro"');
    expect(switchAgent).toContain('model_provider = "relayplane"');
    expect(existsSync(join(codexDir, 'agents', 'glm.toml'))).toBe(true);
    expect(existsSync(join(codexDir, 'agents', 'minimax.toml'))).toBe(true);

    const proxyConfig = JSON.parse(readFileSync(join(home, '.relayplane', 'config.json'), 'utf8'));
    expect(proxyConfig.nativeDelegate.providers.zai.openaiBaseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(proxyConfig.nativeDelegate.providers.minimax.openaiBaseUrl).toBe('https://api.minimax.io/v1');
    expect(proxyConfig.nativeDelegate.providers.byteplus.openaiBaseUrl).toContain('/api/coding/v3');
    expect(proxyConfig.nativeDelegate.providers.deepseek.openaiBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(proxyConfig.nativeDelegate.switch.pro.members).toEqual([
      'deepseek/deepseek-pro',
      'byteplus/deepseek-pro',
    ]);
  });

  it('is idempotent and updates an existing relayplane provider table in place', () => {
    const home = newHome();
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), [
      'model = "gpt-primary"',
      '',
      '[model_providers.relayplane]',
      'name = "Old name"',
      'base_url = "http://127.0.0.1:9999/v1"',
      'env_key = "RELAYPLANE_KEY"',
      'custom_header = "preserve-me"',
      '',
      '[tui]',
      'theme = "github"',
      '',
    ].join('\n'));

    expect(runCodexSetup(home, ['up', '--global', '--foreground']).status).toBe(0);
    expect(runCodexSetup(home, ['up', '--global', '--foreground']).status).toBe(0);

    const config = readFileSync(join(codexDir, 'config.toml'), 'utf8');
    expect(config.match(/\[model_providers\.relayplane\]/g)).toHaveLength(1);
    expect(config).toContain('base_url = "http://127.0.0.1:4100/v1"');
    expect(config).not.toContain('env_key = "RELAYPLANE_KEY"');
    expect(config).toContain('custom_header = "preserve-me"');
    expect(config).toContain('[tui]\ntheme = "github"');
  });

  it('removes only RelayPlane-managed agent files on teardown', () => {
    const home = newHome();
    const agentsDir = join(home, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const custom = 'name = "glm"\ndescription = "user profile"\ndeveloper_instructions = "keep"\n';
    writeFileSync(join(agentsDir, 'glm.toml'), custom);

    const up = runCodexSetup(home, ['up', '--global', '--foreground']);
    expect(up.status).toBe(0);
    expect(up.stdout).toContain('Preserved 1 existing non-RelayPlane profile');
    expect(readFileSync(join(agentsDir, 'glm.toml'), 'utf8')).toBe(custom);
    expect(existsSync(join(agentsDir, 'switch-pro.toml'))).toBe(true);

    const down = runCodexSetup(home, ['down', '--global']);
    expect(down.status).toBe(0);
    expect(readFileSync(join(agentsDir, 'glm.toml'), 'utf8')).toBe(custom);
    expect(existsSync(join(agentsDir, 'switch-pro.toml'))).toBe(false);
  });
});
