/**
 * PR2 run export: the column contract is a public surface (people build
 * spreadsheets and pipelines on it), so the header order, the RFC 4180
 * quoting and the opt-in content columns are pinned here. One live HTTP case
 * proves the route wires the writers up with the right headers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeHome,
  spawnProxy,
  startMockAnthropicUpstream,
  request,
  messagesBody,
  passthroughAnthropicConfig,
  waitForRun,
  type MockAnthropicUpstream,
  type SpawnedProxy,
} from './helpers/p0-harness.js';
import {
  EXPORT_COLUMNS,
  CONTENT_COLUMNS,
  exportCsv,
  exportJson,
  exportJsonl,
  csvCell,
  exportFilename,
  type ExportContent,
  type ExportRun,
} from '../src/run-export.js';
import type { RunRequestRow, RunRow } from '../src/run-store.js';

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    run_id: 'exp-run',
    parent_run_id: null,
    depth: 0,
    label: 'nightly',
    run_source: 'header',
    status: 'completed',
    started_at: 1_700_000_000_000,
    last_seen_at: 1_700_000_060_000,
    ended_at: 1_700_000_060_000,
    exit_code: 0,
    reopen_count: 0,
    request_count: 2,
    error_count: 0,
    rate_limit_count: 0,
    retry_count: 0,
    retry_cost_usd: 0,
    drift_count: 0,
    tokens_in: 100,
    tokens_out: 20,
    cache_read: 0,
    cache_creation: 0,
    cost_usd: 0.5,
    baseline_usd: 1.5,
    cap_usd: null,
    cap_hit_at: null,
    cache_state: 'cold',
    band_lo: null,
    band_hi: null,
    band_status: 'none',
    tags: { env: 'ci', team: 'core' },
    client_key: 'abcd1234',
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RunRequestRow> = {}): RunRequestRow {
  return {
    trace_id: 'trace-1',
    run_id: 'exp-run',
    agent_label: 'coder',
    thread_id: 'thread-1',
    history_id: 'hist-1',
    ts: 1_700_000_010_000,
    model: 'claude-sonnet-4-6',
    requested_model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    attempt: 1,
    is_retry: 0,
    retry_reason: null,
    cache_state: 'cold',
    tokens_in: 50,
    tokens_out: 10,
    cache_read: 0,
    cache_creation: 0,
    cost_usd: 0.25,
    cost_estimated: 0,
    latency_ms: 900,
    success: 1,
    status_code: 200,
    complexity: 'moderate',
    task_type: 'code',
    ...overrides,
  };
}

const twoRequests: ExportRun[] = [
  {
    run: makeRun(),
    requests: [makeRequest(), makeRequest({ trace_id: 'trace-2', history_id: 'hist-2', ts: 1_700_000_020_000 })],
  },
];

describe('run export column contract', () => {
  it('CSV header order equals EXPORT_COLUMNS', () => {
    const csv = exportCsv(twoRequests, false);
    const header = csv.split('\r\n')[0];
    expect(header).toBe(EXPORT_COLUMNS.join(','));
  });

  it('omits the content columns by default and appends them on request', () => {
    const plain = exportCsv(twoRequests, false).split('\r\n')[0] ?? '';
    for (const column of CONTENT_COLUMNS) expect(plain).not.toContain(column);

    const content = new Map<string, ExportContent>([
      ['trace-1', { systemPrompt: 'be terse', userMessage: 'ping', responsePreview: 'PONG' }],
    ]);
    const withContent = exportCsv([{ ...twoRequests[0]!, content }], true);
    const header = withContent.split('\r\n')[0] ?? '';
    expect(header).toBe([...EXPORT_COLUMNS, ...CONTENT_COLUMNS].join(','));
    const firstRow = withContent.split('\r\n')[1] ?? '';
    expect(firstRow).toContain('be terse');
    expect(firstRow).toContain('PONG');
    // The second request has no content entry, so its cells are empty.
    const secondRow = withContent.split('\r\n')[2] ?? '';
    expect(secondRow.endsWith(',,,')).toBe(true);
  });

  it('quotes commas and doubles inner quotes per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');

    const csv = exportCsv(
      [{ run: makeRun(), requests: [makeRequest({ task_type: 'refactor, with "quotes"' })] }],
      false,
    );
    const row = csv.split('\r\n')[1] ?? '';
    expect(row).toContain('"refactor, with ""quotes"""');
    // Quoting must not add a column: the row still parses to the header width.
    expect(row.split(',').length).toBeGreaterThan(EXPORT_COLUMNS.length - 2);
  });

  it('writes the ts as an ISO string and the tags as the LiteLLM k:v string', () => {
    const csv = exportCsv(twoRequests, false);
    const row = (csv.split('\r\n')[1] ?? '').split(',');
    const tsIndex = EXPORT_COLUMNS.indexOf('ts');
    expect(row[tsIndex]).toBe(new Date(1_700_000_010_000).toISOString());
    // `env:ci,team:core` holds a comma, so it arrives quoted and spans cells.
    expect(csv).toContain('"env:ci,team:core"');
  });

  it('JSON nests the requests under each run', () => {
    const parsed = JSON.parse(exportJson(twoRequests, false)) as {
      exported_at: string;
      runs: Array<{ run_id: string; requests: Array<{ trace_id: string }> }>;
    };
    expect(typeof parsed.exported_at).toBe('string');
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]!.run_id).toBe('exp-run');
    expect(parsed.runs[0]!.requests).toHaveLength(2);
    expect(parsed.runs[0]!.requests[0]!.trace_id).toBe('trace-1');
    expect(exportJson(twoRequests, false)).toContain('\n  "runs"');
  });

  it('JSONL emits exactly one line per request with the CSV columns', () => {
    const lines = exportJsonl(twoRequests, false).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual([...EXPORT_COLUMNS]);
    expect(first['trace_id']).toBe('trace-1');
    expect(first['cost_usd']).toBe(0.25);

    const withContent = exportJsonl([{ ...twoRequests[0]!, content: new Map() }], true).trim().split('\n');
    expect(Object.keys(JSON.parse(withContent[0]!) as Record<string, unknown>)).toEqual([
      ...EXPORT_COLUMNS,
      ...CONTENT_COLUMNS,
    ]);
  });

  it('names the download after the UTC date and the format', () => {
    const at = Date.parse('2026-09-05T23:30:00Z');
    expect(exportFilename('csv', at)).toBe('relayplane-runs-20260905.csv');
    expect(exportFilename('jsonl', at)).toBe('relayplane-runs-20260905.jsonl');
    expect(exportFilename('json', at)).toBe('relayplane-runs-20260905.json');
  });
});

describe('POST /v1/runs/export over HTTP', () => {
  let upstream: MockAnthropicUpstream;
  let proxy: SpawnedProxy;
  let home: string;

  beforeAll(async () => {
    upstream = await startMockAnthropicUpstream();
    ({ home } = makeHome(passthroughAnthropicConfig));
    proxy = await spawnProxy({ home, anthropicBaseUrl: upstream.url });
    const res = await request(proxy.port, '/v1/messages', {
      body: messagesBody('export me, please, one short prompt.'),
      headers: { 'X-RelayPlane-Run': 'export-run' },
    });
    expect(res.status, res.text).toBe(200);
    await waitForRun(home, 'export-run', 1);
  }, 40_000);

  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it('returns text/csv with the header row and an attachment disposition', async () => {
    const res = await request(proxy.port, '/v1/runs/export', {
      body: { days: 1, format: 'csv' },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="relayplane-runs-\d{8}\.csv"$/);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(res.text).toContain('export-run');
  }, 20_000);

  it('exports the named runs as JSONL and rejects an unknown format', async () => {
    const jsonl = await request(proxy.port, '/v1/runs/export', {
      body: { run_ids: ['export-run'], format: 'jsonl' },
    });
    expect(jsonl.status, jsonl.text).toBe(200);
    expect(jsonl.headers['content-type']).toBe('application/x-ndjson');
    const lines = jsonl.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { run_id: string }).run_id).toBe('export-run');

    const bad = await request(proxy.port, '/v1/runs/export', { body: { days: 1, format: 'parquet' } });
    expect(bad.status).toBe(400);
  }, 20_000);
});
