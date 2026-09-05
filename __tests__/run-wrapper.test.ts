import { describe, expect, it } from 'vitest';
import {
  mintRunId,
  sanitizeRunLabel,
  runHeaders,
  composeCustomHeaders,
  buildChildEnv,
  formatRunSummary,
  formatDuration,
  formatUsd,
  parseRunArgs,
  type RunSummaryInput,
} from '../src/run-wrapper';

const FIXED_NOW = new Date(Date.UTC(2026, 8, 5, 12, 0, 0));

function localYyyymmdd(at: Date): string {
  return `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
}

describe('mintRunId', () => {
  it('mints `<label>-<yyyymmdd>-<6 hex>`', () => {
    const id = mintRunId('nightly-backfill', FIXED_NOW);
    expect(id).toMatch(new RegExp(`^nightly-backfill-${localYyyymmdd(FIXED_NOW)}-[0-9a-f]{6}$`));
  });

  it('falls back to the `run` prefix without a label', () => {
    expect(mintRunId(undefined, FIXED_NOW)).toMatch(/^run-\d{8}-[0-9a-f]{6}$/);
  });

  it('falls back to `run` when the label sanitizes down to nothing', () => {
    expect(mintRunId('!!! ???', FIXED_NOW)).toMatch(/^run-\d{8}-[0-9a-f]{6}$/);
  });

  it('turns spaces into dashes and drops characters outside [\\w\\-.:@]', () => {
    expect(sanitizeRunLabel('nightly backfill/v2 (prod)!')).toBe('nightly-backfillv2-prod');
    expect(sanitizeRunLabel('team:core@host-1.2')).toBe('team:core@host-1.2');
  });

  it('caps the label at 40 characters', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeRunLabel(long)).toHaveLength(40);
    expect(mintRunId(long, FIXED_NOW)).toMatch(/^a{40}-\d{8}-[0-9a-f]{6}$/);
  });

  it('is unique across calls at the same instant', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintRunId('x', FIXED_NOW)));
    expect(ids.size).toBeGreaterThan(45);
  });
});

describe('runHeaders', () => {
  it('always carries the run id and nothing it was not given', () => {
    expect(runHeaders({ runId: 'r-1' })).toEqual({ 'X-RelayPlane-Run': 'r-1' });
  });

  it('serializes every optional field with the documented header names', () => {
    expect(
      runHeaders({
        runId: 'r-1',
        label: 'nightly',
        tags: { env: 'prod', team: 'core' },
        capUsd: 5,
        parentRunId: 'parent-1',
        agent: 'coder',
      }),
    ).toEqual({
      'X-RelayPlane-Run': 'r-1',
      'X-RelayPlane-Run-Label': 'nightly',
      'X-RelayPlane-Tags': 'env:prod,team:core',
      'X-RelayPlane-Run-Cap-Usd': '5',
      'X-RelayPlane-Parent-Run': 'parent-1',
      'X-RelayPlane-Agent': 'coder',
    });
  });

  it('drops an empty tag map and a non-positive cap', () => {
    const headers = runHeaders({ runId: 'r-1', tags: {}, capUsd: 0 });
    expect(headers['X-RelayPlane-Tags']).toBeUndefined();
    expect(headers['X-RelayPlane-Run-Cap-Usd']).toBeUndefined();
  });
});

describe('composeCustomHeaders', () => {
  it('appends our lines with \\n when there is nothing there yet', () => {
    expect(composeCustomHeaders(undefined, { 'X-RelayPlane-Run': 'r-1' })).toBe('X-RelayPlane-Run: r-1');
    expect(composeCustomHeaders('', { 'X-RelayPlane-Run': 'r-1', 'X-RelayPlane-Agent': 'coder' })).toBe(
      'X-RelayPlane-Run: r-1\nX-RelayPlane-Agent: coder',
    );
  });

  it('keeps an existing unrelated line first', () => {
    const out = composeCustomHeaders('X-Corp-Trace: abc', { 'X-RelayPlane-Run': 'r-1' });
    expect(out).toBe('X-Corp-Trace: abc\nX-RelayPlane-Run: r-1');
  });

  it('replaces an existing X-RelayPlane-Run line instead of duplicating it, case-insensitively', () => {
    const out = composeCustomHeaders('x-relayplane-run: old-run\nX-Corp-Trace: abc', {
      'X-RelayPlane-Run': 'new-run',
    });
    expect(out).toBe('X-Corp-Trace: abc\nX-RelayPlane-Run: new-run');
    expect(out.match(/relayplane-run/gi)).toHaveLength(1);
    expect(out).not.toContain('old-run');
  });

  it('drops blank and whitespace-only lines and normalizes CRLF', () => {
    const out = composeCustomHeaders('\r\nX-Corp-Trace: abc\r\n   \r\n', { 'X-RelayPlane-Run': 'r-1' });
    expect(out).toBe('X-Corp-Trace: abc\nX-RelayPlane-Run: r-1');
  });
});

describe('buildChildEnv', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/x' };

  it('exports the documented env contract', () => {
    const env = buildChildEnv(base, { runId: 'r-1', label: 'nightly', proxyUrl: 'http://127.0.0.1:4101' });
    expect(env['RELAYPLANE_RUN_ID']).toBe('r-1');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toContain('X-RelayPlane-Run: r-1');
  });

  it('writes RELAYPLANE_RUN_HEADERS as JSON equal to runHeaders(opts)', () => {
    const opts = { runId: 'r-1', label: 'nightly', tags: { env: 'prod' }, agent: 'coder' };
    const env = buildChildEnv(base, { ...opts, proxyUrl: 'http://127.0.0.1:4101' });
    expect(JSON.parse(env['RELAYPLANE_RUN_HEADERS'] ?? '{}')).toEqual(runHeaders(opts));
  });

  it('sets ANTHROPIC_BASE_URL only when the caller has not set one', () => {
    const unset = buildChildEnv(base, { runId: 'r-1', proxyUrl: 'http://127.0.0.1:4101' });
    expect(unset['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4101');

    const preset = buildChildEnv(
      { ...base, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      { runId: 'r-1', proxyUrl: 'http://127.0.0.1:4101' },
    );
    expect(preset['ANTHROPIC_BASE_URL']).toBe('https://api.anthropic.com');
  });

  it('treats an empty ANTHROPIC_BASE_URL as unset', () => {
    const env = buildChildEnv({ ...base, ANTHROPIC_BASE_URL: '  ' }, { runId: 'r-1', proxyUrl: 'http://127.0.0.1:4101' });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4101');
  });

  it('does not mutate the env it was handed', () => {
    const original = { ...base };
    buildChildEnv(base, { runId: 'r-1', proxyUrl: 'http://127.0.0.1:4101' });
    expect(base).toEqual(original);
  });
});

describe('formatUsd and formatDuration', () => {
  it('renders cents with two decimals and sub-cent runs with six', () => {
    expect(formatUsd(12.1)).toBe('12.10');
    expect(formatUsd(0)).toBe('0.00');
    expect(formatUsd(0.000144)).toBe('0.000144');
  });

  it('renders durations without a leading zero unit', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(102_000)).toBe('1m 42s');
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
  });
});

describe('formatRunSummary', () => {
  const started = Date.UTC(2026, 8, 5, 10, 0, 0);
  const input: RunSummaryInput = {
    run: {
      run_id: 'nightly-backfill-20260905-a1b2c3',
      label: 'nightly-backfill',
      status: 'completed',
      request_count: 37,
      cost_usd: 12.1,
      baseline_usd: 18.4,
      retry_count: 4,
      retry_cost_usd: 4.02,
      band_status: 'over',
      band_lo: 4,
      band_hi: 9,
      rate_limit_count: 0,
      drift_count: 0,
      started_at: started,
      ended_at: started + 102_000,
    },
    agents: [
      { agent_label: 'coder', request_count: 24, cost_usd: 8.1, models_seen: { 'claude-sonnet-5': 22, 'claude-haiku-4-5': 2 } },
      { agent_label: 'researcher', request_count: 13, cost_usd: 4.0, models_seen: { 'claude-sonnet-5': 13 } },
      { agent_label: 'writer', request_count: 3, cost_usd: 0.9, models_seen: { 'claude-haiku-4-5': 3 } },
      { agent_label: 'linter', request_count: 1, cost_usd: 0.05, models_seen: { 'claude-haiku-4-5': 1 } },
    ],
    dashboardUrl: 'http://localhost:4100/dashboard#run=nightly-backfill-20260905-a1b2c3',
  };

  it('leads with the id, label, status and duration', () => {
    const lines = formatRunSummary(input).split('\n');
    expect(lines[0]).toBe('Run nightly-backfill-20260905-a1b2c3 (nightly-backfill)  completed  1m 42s');
  });

  it('always calls the cost notional and shows the baseline', () => {
    const cost = formatRunSummary(input).split('\n')[1] ?? '';
    expect(cost).toContain('cost $12.10 notional (all-opus baseline $18.40)');
    expect(cost).toContain('requests 37');
  });

  it('shows the retries clause with a percentage of run cost', () => {
    expect(formatRunSummary(input)).toContain('retries $4.02 (33%)');
  });

  it('omits the retries clause when retry_count is 0', () => {
    const out = formatRunSummary({ ...input, run: { ...input.run, retry_count: 0, retry_cost_usd: 0 } });
    expect(out).not.toContain('retries');
  });

  it('shows the band clause with its range, and omits it when band_status is none', () => {
    expect(formatRunSummary(input)).toContain('band over [4.00, 9.00]');
    const none = formatRunSummary({
      ...input,
      run: { ...input.run, band_status: 'none', band_lo: null, band_hi: null },
    });
    expect(none).not.toContain('band ');
  });

  it('prints the 429 and drift counters', () => {
    expect(formatRunSummary({ ...input, run: { ...input.run, rate_limit_count: 5, drift_count: 2 } })).toContain(
      '429s 5   model drift 2',
    );
  });

  it('lists only the top 3 agents by cost, with their model mix', () => {
    const agentsLine = formatRunSummary(input).split('\n').find((l) => l.startsWith('  agents:')) ?? '';
    expect(agentsLine).toBe(
      '  agents: coder $8.10 (24 req, claude-sonnet-5 x22, claude-haiku-4-5 x2) | researcher $4.00 (13 req, claude-sonnet-5 x13) | writer $0.90 (3 req, claude-haiku-4-5 x3)',
    );
    expect(agentsLine).not.toContain('linter');
  });

  it('ends with the dashboard deep link', () => {
    const lines = formatRunSummary(input).split('\n');
    expect(lines[lines.length - 1]).toBe(`  dashboard ${input.dashboardUrl}`);
  });

  it('omits the duration for a run that has not ended and the label for an unlabeled run', () => {
    const out = formatRunSummary({
      ...input,
      run: { ...input.run, label: null, status: 'running', ended_at: null },
    });
    expect(out.split('\n')[0]).toBe('Run nightly-backfill-20260905-a1b2c3  running');
  });
});

describe('parseRunArgs', () => {
  it('splits flags from the command at the first bare --', () => {
    const parsed = parseRunArgs(['--label', 'nightly', '--', 'bash', '-c', 'echo hi']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.opts.label).toBe('nightly');
    expect(parsed.command).toEqual(['bash', '-c', 'echo hi']);
  });

  it('accepts a repeatable --tag k:v', () => {
    const parsed = parseRunArgs(['--tag', 'env:prod', '--tag', 'team:core', '--', 'true']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.opts.tags).toEqual({ env: 'prod', team: 'core' });
  });

  it('parses a fractional --cap', () => {
    const parsed = parseRunArgs(['--cap', '0.5', '--', 'true']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.opts.capUsd).toBe(0.5);
  });

  it('parses the remaining flags', () => {
    const parsed = parseRunArgs([
      '--id', 'fixed-id', '--parent', 'parent-1', '--agent', 'coder',
      '--proxy', 'http://127.0.0.1:4101/', '--json', '--', 'true',
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.opts.runId).toBe('fixed-id');
    expect(parsed.opts.parentRunId).toBe('parent-1');
    expect(parsed.opts.agent).toBe('coder');
    expect(parsed.opts.proxyUrl).toBe('http://127.0.0.1:4101');
    expect(parsed.opts.json).toBe(true);
  });

  it('leaves flags after the -- alone for the child', () => {
    const parsed = parseRunArgs(['--', 'claude', '-p', 'hi', '--json']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.opts.json).toBeUndefined();
    expect(parsed.command).toEqual(['claude', '-p', 'hi', '--json']);
  });

  it('errors when the -- separator is missing', () => {
    const parsed = parseRunArgs(['--label', 'nightly', 'bash']);
    expect('error' in parsed && parsed.error).toContain('Missing "--"');
  });

  it('errors on an empty command after --', () => {
    const parsed = parseRunArgs(['--label', 'nightly', '--']);
    expect('error' in parsed && parsed.error).toContain('No command');
  });

  it('errors on a malformed tag, a bad cap and an unknown flag', () => {
    expect('error' in parseRunArgs(['--tag', 'nope', '--', 'true'])).toBe(true);
    expect('error' in parseRunArgs(['--cap', 'lots', '--', 'true'])).toBe(true);
    expect('error' in parseRunArgs(['--cap', '-1', '--', 'true'])).toBe(true);
    expect('error' in parseRunArgs(['--nope', '--', 'true'])).toBe(true);
  });

  it('errors when a value-taking flag has no value before the --', () => {
    const parsed = parseRunArgs(['--label', '--', 'true']);
    expect('error' in parsed && parsed.error).toContain('--label needs a value');
  });
});
