/**
 * `relayplane codex` — configure Codex CLI custom subagents to use RelayPlane
 * delegates while the primary Codex thread keeps its normal OpenAI provider and
 * authentication.
 *
 *   relayplane codex up      [--global | --project [path]] [--foreground]
 *   relayplane codex down    [--global | --project [path]]
 *   relayplane codex status  [--global | --project [path]]
 *
 * Codex speaks the Responses API. RelayPlane exposes `/v1/responses`, converts
 * those requests to each delegate's OpenAI-compatible chat endpoint, and maps
 * the response back to Responses events.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  DELEGATE_BASE_URL,
  DELEGATE_KEY_SPECS,
  DELEGATE_PORT,
  applyDelegateProxyConfig,
  collectDelegateKeys,
  delegateConfigPath,
  delegateEnvFilePath,
  isDelegatePortUp,
  startDelegateDaemon,
  stopDelegateDaemon,
} from './cc-setup.js';

const MANAGED_MARKER = '# Managed by RelayPlane (`relayplane codex`).';
const PROVIDER_HEADER = '[model_providers.relayplane]';
const CODEX_PROVIDER_BASE_URL = `http://127.0.0.1:${DELEGATE_PORT}/v1`;

interface CodexScope {
  kind: 'global' | 'project';
  root: string;
  configPath: string;
  agentsDir: string;
}

const CODEX_AGENTS: Record<string, string> = {
  'switch-pro.toml': `name = "switch-pro"
description = "Resilient coding helper that automatically fails over between DeepSeek-V4-Pro providers through RelayPlane. Use for substantial coding, refactoring, and analysis when provider availability matters."
model = "switch/pro"
model_provider = "relayplane"
developer_instructions = """
You are a capable engineering assistant running on a RelayPlane-managed pro model.
Answer directly and precisely. When editing code, make minimal, surgical changes
and match the surrounding style.
"""
`,
  'switch-flash.toml': `name = "switch-flash"
description = "Fast coding helper that automatically fails over between DeepSeek-V4-Flash providers through RelayPlane. Use for quick edits, summaries, scans, and routine tasks."
model = "switch/flash"
model_provider = "relayplane"
developer_instructions = """
You are a fast engineering assistant running on a RelayPlane-managed flash model.
Answer concisely. When editing code, make minimal, surgical changes and match the
surrounding style.
"""
`,
  'glm.toml': `name = "glm"
description = "General-purpose helper on Zhipu GLM (glm-5.2) via RelayPlane native delegation. Use for routine coding, summarization, and analysis tasks where GLM is preferred."
model = "zai/glm-5.2"
model_provider = "relayplane"
developer_instructions = """
You are a focused engineering assistant running on the GLM model.
Answer directly and concisely. When editing code, make minimal, surgical changes
and match the surrounding style.
"""
`,
  'minimax.toml': `name = "minimax"
description = "Reasoning-heavy helper on MiniMax-M3 via RelayPlane native delegation. Use for planning, debugging, and multi-step analysis."
model = "minimax/MiniMax-M3"
model_provider = "relayplane"
developer_instructions = """
You are a careful reasoning assistant running on the MiniMax-M3 model.
Think through the problem step by step, then give a clear, actionable answer.
When editing code, make minimal, surgical changes and match the surrounding style.
"""
`,
  'deepseek-pro.toml': `name = "deepseek-pro"
description = "Capable coding helper on DeepSeek-V4-Pro via BytePlus ModelArk and RelayPlane. Use for substantial coding, refactoring, and analysis tasks."
model = "byteplus/deepseek-pro"
model_provider = "relayplane"
developer_instructions = """
You are a capable engineering assistant running on the DeepSeek-V4-Pro model.
Answer directly and precisely. When editing code, make minimal, surgical changes
and match the surrounding style.
"""
`,
  'deepseek-flash.toml': `name = "deepseek-flash"
description = "Fast, low-cost coding helper on DeepSeek-V4-Flash via BytePlus ModelArk and RelayPlane. Use for quick edits, summaries, and routine tasks."
model = "byteplus/deepseek-flash"
model_provider = "relayplane"
developer_instructions = """
You are a fast engineering assistant running on the DeepSeek-V4-Flash model.
Answer concisely. When editing code, make minimal, surgical changes and match the
surrounding style.
"""
`,
  'deepseek-direct-pro.toml': `name = "deepseek-direct-pro"
description = "Capable coding helper on DeepSeek-V4-Pro through the DeepSeek API and RelayPlane. Use for substantial coding and as an alternative to BytePlus."
model = "deepseek/deepseek-pro"
model_provider = "relayplane"
developer_instructions = """
You are a capable engineering assistant running on the DeepSeek-V4-Pro model.
Answer directly and precisely. When editing code, make minimal, surgical changes
and match the surrounding style.
"""
`,
  'deepseek-direct-flash.toml': `name = "deepseek-direct-flash"
description = "Fast coding helper on DeepSeek-V4-Flash through the DeepSeek API and RelayPlane. Use for quick work and as an alternative to BytePlus."
model = "deepseek/deepseek-flash"
model_provider = "relayplane"
developer_instructions = """
You are a fast engineering assistant running on the DeepSeek-V4-Flash model.
Answer concisely. When editing code, make minimal, surgical changes and match the
surrounding style.
"""
`,
};

function resolveScope(args: string[]): CodexScope {
  const projectIndex = args.indexOf('--project');
  if (projectIndex !== -1) {
    const maybePath = args[projectIndex + 1];
    const root = maybePath && !maybePath.startsWith('--') ? maybePath : process.cwd();
    return {
      kind: 'project',
      root,
      configPath: join(root, '.codex', 'config.toml'),
      agentsDir: join(root, '.codex', 'agents'),
    };
  }
  const root = homedir();
  return {
    kind: 'global',
    root,
    configPath: join(root, '.codex', 'config.toml'),
    agentsDir: join(root, '.codex', 'agents'),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Upsert keys in one TOML table without parsing or rewriting unrelated config. */
function upsertTomlTable(
  path: string,
  header: string,
  values: Record<string, string | boolean>,
  removeKeys: string[] = [],
): void {
  const original = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  const headerPattern = new RegExp(`^\\s*${escapeRegExp(header)}\\s*$`);
  const start = lines.findIndex((line) => headerPattern.test(line));

  if (start === -1) {
    const separator = original.trim().length > 0 ? '\n\n' : '';
    const body = Object.entries(values)
      .map(([key, value]) => `${key} = ${typeof value === 'string' ? JSON.stringify(value) : value}`)
      .join('\n');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${original.replace(/\s*$/, '')}${separator}${MANAGED_MARKER}\n${header}\n${body}\n`, 'utf-8');
    return;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i]!)) { end = i; break; }
  }

  for (const key of removeKeys) {
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    for (let index = end - 1; index > start; index--) {
      if (keyPattern.test(lines[index]!)) {
        lines.splice(index, 1);
        end--;
      }
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const assignment = `${key} = ${typeof value === 'string' ? JSON.stringify(value) : value}`;
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const existing = lines.findIndex((line, index) => index > start && index < end && keyPattern.test(line));
    if (existing === -1) {
      lines.splice(end, 0, assignment);
      end++;
    } else {
      lines[existing] = assignment;
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'), 'utf-8');
}

function configureCodexProvider(scope: CodexScope): void {
  upsertTomlTable(scope.configPath, PROVIDER_HEADER, {
    name: 'RelayPlane',
    base_url: CODEX_PROVIDER_BASE_URL,
    wire_api: 'responses',
    requires_openai_auth: false,
  }, ['env_key', 'env_key_instructions', 'experimental_bearer_token']);
}

function managedAgentBody(body: string): string {
  return `${MANAGED_MARKER}\n${body}`;
}

function writeAgents(scope: CodexScope): { written: string[]; preserved: string[] } {
  mkdirSync(scope.agentsDir, { recursive: true });
  const written: string[] = [];
  const preserved: string[] = [];
  for (const [name, body] of Object.entries(CODEX_AGENTS)) {
    const path = join(scope.agentsDir, name);
    if (existsSync(path) && !readFileSync(path, 'utf-8').startsWith(MANAGED_MARKER)) {
      preserved.push(path);
      continue;
    }
    writeFileSync(path, managedAgentBody(body), 'utf-8');
    written.push(path);
  }
  return { written, preserved };
}

function removeAgents(scope: CodexScope): { removed: string[]; preserved: string[] } {
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const name of Object.keys(CODEX_AGENTS)) {
    const path = join(scope.agentsDir, name);
    if (!existsSync(path)) continue;
    if (!readFileSync(path, 'utf-8').startsWith(MANAGED_MARKER)) {
      preserved.push(path);
      continue;
    }
    try { unlinkSync(path); removed.push(path); } catch { /* best effort */ }
  }
  return { removed, preserved };
}

function parseEnvKeys(): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(delegateEnvFilePath())) return result;
  for (const line of readFileSync(delegateEnvFilePath(), 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator > 0) result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

async function codexUp(args: string[]): Promise<void> {
  const scope = resolveScope(args);
  const foreground = args.includes('--foreground');
  console.log(`\n  RelayPlane × Codex CLI — setup (${scope.kind}${scope.kind === 'project' ? `: ${scope.root}` : ''})\n`);

  const keys = await collectDelegateKeys();
  console.log(`  ✓ Provider keys saved to ${delegateEnvFilePath()} (chmod 600)`);

  const { routingChanged, prevMode } = applyDelegateProxyConfig();
  console.log(`  ✓ Proxy config: ${delegateConfigPath()} (Responses delegation + pro/flash failover pools)`);
  if (routingChanged) console.log(`    ⚠️  Changed routing.mode "${prevMode}" → "standard" (delegation needs passthrough).`);

  configureCodexProvider(scope);
  console.log(`  ✓ Codex provider: ${scope.configPath} (${PROVIDER_HEADER}, primary Codex provider unchanged)`);

  const agents = writeAgents(scope);
  console.log(`  ✓ Subagents: ${agents.written.length} managed profiles in ${scope.agentsDir}`);
  if (agents.preserved.length > 0) {
    console.log(`    ℹ️  Preserved ${agents.preserved.length} existing non-RelayPlane profile(s) with matching names.`);
  }

  if (foreground) {
    console.log('\n  Setup complete. Start the proxy in this terminal:\n    relayplane start\n');
  } else {
    console.log('');
    await startDelegateDaemon(keys);
  }

  console.log('\n  Done. Next:');
  console.log(`    • ${scope.kind === 'project' ? `cd ${scope.root} && ` : ''}codex`);
  console.log('    • Ask Codex: “Use the switch-pro subagent for this refactor.”');
  console.log('    • The primary thread keeps your normal OpenAI model and login.');
  console.log(`    • Tear down: relayplane codex down ${scope.kind === 'project' ? `--project ${scope.root}` : '--global'}\n`);
}

function codexDown(args: string[]): void {
  const scope = resolveScope(args);
  console.log(`\n  RelayPlane × Codex CLI — teardown (${scope.kind})\n`);
  const agents = removeAgents(scope);
  console.log(`  ✓ Removed ${agents.removed.length} RelayPlane-managed subagent profile(s) from ${scope.agentsDir}`);
  if (agents.preserved.length > 0) console.log(`  ℹ️  Preserved ${agents.preserved.length} user-managed profile(s).`);
  stopDelegateDaemon();
  console.log(`\n  Left in place: ${scope.configPath}, ${delegateConfigPath()}, and ${delegateEnvFilePath()} (safe to reuse).\n`);
}

async function codexStatus(args: string[]): Promise<void> {
  const scope = resolveScope(args);
  console.log(`\n  RelayPlane × Codex CLI — status (${scope.kind})\n`);
  const up = await isDelegatePortUp();
  console.log(`  Proxy (:${DELEGATE_PORT}): ${up ? '🟢 running' : '🔴 not running'}`);
  if (up) {
    try {
      const response = await fetch(`${DELEGATE_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
      console.log(`  Health: ${response.ok ? 'ok' : 'HTTP ' + response.status}`);
    } catch { console.log('  Health: (port open, /health not reachable)'); }
  }
  const config = existsSync(scope.configPath) ? readFileSync(scope.configPath, 'utf-8') : '';
  console.log(`  Provider: ${config.includes(PROVIDER_HEADER) ? '✓' : '✗'}  (${scope.configPath})`);
  const managed = Object.keys(CODEX_AGENTS).filter((name) => {
    const path = join(scope.agentsDir, name);
    return existsSync(path) && readFileSync(path, 'utf-8').startsWith(MANAGED_MARKER);
  }).length;
  console.log(`  Agents: ${managed}/${Object.keys(CODEX_AGENTS).length} RelayPlane-managed  (${scope.agentsDir})`);
  const env = parseEnvKeys();
  console.log(`  Keys: ${DELEGATE_KEY_SPECS.map(({ env: key }) => `${key}=${env[key] || process.env[key] ? 'set' : 'MISSING'}`).join(', ')}`);
  console.log('');
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case 'up': await codexUp(args.slice(1)); break;
    case 'down': codexDown(args.slice(1)); break;
    case 'status': await codexStatus(args.slice(1)); break;
    default:
      console.log(`
  relayplane codex — use alternate LLM providers for Codex CLI subagents

  Usage:
    relayplane codex up      [--global | --project [path]] [--foreground]
    relayplane codex down    [--global | --project [path]]
    relayplane codex status  [--global | --project [path]]

  --global       (default) write ~/.codex/config.toml and ~/.codex/agents
  --project      write <path>/.codex/config.toml and <path>/.codex/agents
  --foreground   configure only; start the proxy yourself with \`relayplane start\`
`);
      if (subcommand && subcommand !== 'help' && subcommand !== '--help' && subcommand !== '-h') process.exit(1);
  }
}
