/**
 * Pure helpers behind `relayplane run` and `relayplane runs`.
 *
 * Nothing here does I/O: no fetch, no spawn, no filesystem. The CLI layer in
 * cli.ts owns every side effect, so this module can be unit-tested without a
 * proxy, a child process, or a clock. The one exception is `mintRunId`, which
 * reads randomness and (by default) the wall clock; both are injectable.
 */
import { randomBytes } from 'node:crypto';

/** Characters a run label may keep. Everything else is dropped. */
const LABEL_ALLOWED = /[^\w\-.:@]/g;
const MAX_LABEL_LEN = 40;

/**
 * Sanitize a user supplied label into something safe for a run id: spaces
 * collapse to '-', anything outside [\w\-.:@] is dropped, capped at 40 chars.
 */
export function sanitizeRunLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, '-')
    .replace(LABEL_ALLOWED, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LEN)
    .replace(/-+$/, '');
}

function yyyymmdd(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** `${label ?? 'run'}-${yyyymmdd}-${6 hex}`. */
export function mintRunId(label?: string, now?: Date): string {
  const at = now ?? new Date();
  const base = label ? sanitizeRunLabel(label) : '';
  const prefix = base.length > 0 ? base : 'run';
  return `${prefix}-${yyyymmdd(at)}-${randomBytes(3).toString('hex')}`;
}

export interface RunHeaderOpts {
  runId: string;
  label?: string;
  tags?: Record<string, string>;
  capUsd?: number;
  parentRunId?: string;
  agent?: string;
}

/**
 * The request headers documented in the env contract (plan 3.3). Keys are in
 * canonical casing because they are written verbatim into
 * ANTHROPIC_CUSTOM_HEADERS, which Claude Code forwards byte for byte.
 */
export function runHeaders(opts: RunHeaderOpts): Record<string, string> {
  const out: Record<string, string> = { 'X-RelayPlane-Run': opts.runId };
  if (opts.label !== undefined && opts.label.length > 0) {
    out['X-RelayPlane-Run-Label'] = opts.label;
  }
  const tagEntries = Object.entries(opts.tags ?? {});
  if (tagEntries.length > 0) {
    out['X-RelayPlane-Tags'] = tagEntries.map(([k, v]) => `${k}:${v}`).join(',');
  }
  if (typeof opts.capUsd === 'number' && Number.isFinite(opts.capUsd) && opts.capUsd > 0) {
    out['X-RelayPlane-Run-Cap-Usd'] = String(opts.capUsd);
  }
  if (opts.parentRunId !== undefined && opts.parentRunId.length > 0) {
    out['X-RelayPlane-Parent-Run'] = opts.parentRunId;
  }
  if (opts.agent !== undefined && opts.agent.length > 0) {
    out['X-RelayPlane-Agent'] = opts.agent;
  }
  return out;
}

/**
 * Merge our run headers into an existing ANTHROPIC_CUSTOM_HEADERS value.
 *
 * Existing unrelated lines are kept, in order, first. Any existing line whose
 * header name matches one of ours (case-insensitively) is dropped rather than
 * duplicated, so wrapping a run inside another run replaces the outer
 * X-RelayPlane-Run instead of sending two of them.
 */
export function composeCustomHeaders(
  existing: string | undefined,
  headers: Record<string, string>,
): string {
  const ours = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const kept: string[] = [];
  for (const rawLine of (existing ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(':');
    const name = (idx === -1 ? line : line.slice(0, idx)).trim().toLowerCase();
    if (ours.has(name)) continue;
    kept.push(line);
  }
  for (const [name, value] of Object.entries(headers)) {
    kept.push(`${name}: ${value}`);
  }
  return kept.join('\n');
}

/**
 * The child environment `relayplane run` hands to the wrapped command.
 *
 * Documented deviation from "only export headers": we also set
 * ANTHROPIC_BASE_URL to the proxy when the caller has not set one. The whole
 * point of the wrapper is zero code changes, so a bare
 * `relayplane run -- claude -p '...'` has to reach the proxy. An explicit
 * ANTHROPIC_BASE_URL in the parent env always wins.
 */
export function buildChildEnv(
  env: NodeJS.ProcessEnv,
  opts: RunHeaderOpts & { proxyUrl: string },
): NodeJS.ProcessEnv {
  const headers = runHeaders(opts);
  const next: NodeJS.ProcessEnv = { ...env };
  next['ANTHROPIC_CUSTOM_HEADERS'] = composeCustomHeaders(env['ANTHROPIC_CUSTOM_HEADERS'], headers);
  next['RELAYPLANE_RUN_ID'] = opts.runId;
  next['RELAYPLANE_RUN_HEADERS'] = JSON.stringify(headers);
  const existingBase = (env['ANTHROPIC_BASE_URL'] ?? '').trim();
  if (existingBase.length === 0) next['ANTHROPIC_BASE_URL'] = opts.proxyUrl;
  return next;
}

// ---------------------------------------------------------------------------
// Rollup formatting
// ---------------------------------------------------------------------------

export interface RunSummaryRun {
  run_id: string;
  label: string | null;
  status: string;
  request_count: number;
  cost_usd: number;
  baseline_usd: number;
  retry_count: number;
  retry_cost_usd: number;
  band_status: string;
  band_lo: number | null;
  band_hi: number | null;
  rate_limit_count: number;
  drift_count: number;
  started_at: number;
  ended_at: number | null;
}

export interface RunSummaryAgent {
  agent_label: string;
  request_count: number;
  cost_usd: number;
  models_seen: Record<string, number>;
}

export interface RunSummaryInput {
  run: RunSummaryRun;
  agents: RunSummaryAgent[];
  dashboardUrl: string;
}

/**
 * Money for humans. Two decimals is the reporting default, but a sub-cent run
 * (a smoke test, a single cheap call) would render as $0.00 and read as
 * "free", so anything under a cent falls back to six decimals.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  if (value === 0) return '0.00';
  return Math.abs(value) < 0.01 ? value.toFixed(6) : value.toFixed(2);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatModels(modelsSeen: Record<string, number>): string {
  return Object.entries(modelsSeen)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, count]) => `${model} x${count}`)
    .join(', ');
}

/**
 * The rollup printed to stderr when a wrapped run finishes. Cost always says
 * "notional": flat rate accounts pay list price nowhere, so this is what the
 * traffic would have cost, never an invoice.
 */
export function formatRunSummary(input: RunSummaryInput): string {
  const { run } = input;
  const lines: string[] = [];

  const labelPart = run.label ? ` (${run.label})` : '';
  const durationPart = run.ended_at !== null ? `  ${formatDuration(run.ended_at - run.started_at)}` : '';
  lines.push(`Run ${run.run_id}${labelPart}  ${run.status}${durationPart}`);

  const parts: string[] = [
    `cost $${formatUsd(run.cost_usd)} notional (all-opus baseline $${formatUsd(run.baseline_usd)})`,
    `requests ${run.request_count}`,
  ];
  if (run.retry_count > 0) {
    const pct = run.cost_usd > 0 ? Math.round((run.retry_cost_usd / run.cost_usd) * 100) : 0;
    parts.push(`retries $${formatUsd(run.retry_cost_usd)} (${pct}%)`);
  }
  if (run.band_status !== 'none') {
    const range =
      run.band_lo !== null && run.band_hi !== null
        ? ` [${formatUsd(run.band_lo)}, ${formatUsd(run.band_hi)}]`
        : '';
    parts.push(`band ${run.band_status}${range}`);
  }
  lines.push(`  ${parts.join('   ')}`);
  lines.push(`  429s ${run.rate_limit_count}   model drift ${run.drift_count}`);

  const topAgents = [...input.agents].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 3);
  if (topAgents.length > 0) {
    const rendered = topAgents.map((a) => {
      const models = formatModels(a.models_seen);
      const detail = models.length > 0 ? `${a.request_count} req, ${models}` : `${a.request_count} req`;
      return `${a.agent_label} $${formatUsd(a.cost_usd)} (${detail})`;
    });
    lines.push(`  agents: ${rendered.join(' | ')}`);
  }

  lines.push(`  dashboard ${input.dashboardUrl}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface RunArgOpts {
  label?: string;
  tags: Record<string, string>;
  capUsd?: number;
  parentRunId?: string;
  runId?: string;
  agent?: string;
  proxyUrl?: string;
  json?: boolean;
}

export type ParsedRunArgs = { opts: RunArgOpts; command: string[] } | { error: string };

/**
 * Everything before the first bare `--` is a flag, everything after is the
 * command to wrap. The separator is mandatory: without it there is no way to
 * tell `relayplane run --label x mycmd` from a typo'd flag value.
 */
export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const sep = argv.indexOf('--');
  if (sep === -1) {
    return { error: 'Missing "--" separator. Usage: relayplane run [flags] -- <command...>' };
  }
  const flags = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  if (command.length === 0) {
    return { error: 'No command given after "--". Usage: relayplane run [flags] -- <command...>' };
  }

  const opts: RunArgOpts = { tags: {} };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    const takesValue = (): string | null => {
      const value = flags[i + 1];
      if (value === undefined) return null;
      i++;
      return value;
    };
    switch (flag) {
      case '--label': {
        const value = takesValue();
        if (value === null) return { error: '--label needs a value' };
        opts.label = value;
        break;
      }
      case '--tag': {
        const value = takesValue();
        if (value === null) return { error: '--tag needs a k:v value' };
        const idx = value.indexOf(':');
        if (idx <= 0) return { error: `Invalid --tag "${value}", expected k:v` };
        opts.tags[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
        break;
      }
      case '--cap': {
        const value = takesValue();
        if (value === null) return { error: '--cap needs a USD amount' };
        const cap = Number(value);
        if (!Number.isFinite(cap) || cap <= 0) return { error: `Invalid --cap "${value}", expected a positive number` };
        opts.capUsd = cap;
        break;
      }
      case '--parent': {
        const value = takesValue();
        if (value === null) return { error: '--parent needs a run id' };
        opts.parentRunId = value;
        break;
      }
      case '--id': {
        const value = takesValue();
        if (value === null) return { error: '--id needs a run id' };
        opts.runId = value;
        break;
      }
      case '--agent': {
        const value = takesValue();
        if (value === null) return { error: '--agent needs a label' };
        opts.agent = value;
        break;
      }
      case '--proxy': {
        const value = takesValue();
        if (value === null) return { error: '--proxy needs a base URL' };
        opts.proxyUrl = value.replace(/\/+$/, '');
        break;
      }
      case '--json':
        opts.json = true;
        break;
      default:
        return { error: `Unknown flag "${flag}" before "--"` };
    }
  }

  return { opts, command };
}
