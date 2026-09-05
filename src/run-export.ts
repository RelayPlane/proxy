/**
 * Run export writers (PR2).
 *
 * Pure and unit testable: no store access, no filesystem, no clock beyond the
 * `exported_at` stamp on the JSON envelope. The HTTP route gathers the rows and
 * hands them here, so the column contract can be tested without a live proxy.
 *
 * One row per request in CSV and JSONL, nested runs in JSON. Content columns
 * (system prompt, user message, response preview) are appended only when the
 * caller explicitly asks for them.
 */

import { formatTags } from './run-attribution.js';
import type { RunRequestRow, RunRow } from './run-store.js';

export const EXPORT_COLUMNS = [
  'run_id',
  'run_label',
  'parent_run_id',
  'run_source',
  'agent_label',
  'thread_id',
  'trace_id',
  'ts',
  'model',
  'requested_model',
  'provider',
  'tokens_in',
  'tokens_out',
  'cache_read',
  'cache_creation',
  'cost_usd',
  'latency_ms',
  'success',
  'status_code',
  'complexity',
  'task_type',
  'tags',
  'attempt',
  'is_retry',
  'retry_reason',
  'cache_state',
] as const;

export const CONTENT_COLUMNS = ['system_prompt', 'user_message', 'response_preview'] as const;

export interface ExportContent {
  systemPrompt?: string;
  userMessage?: string;
  responsePreview?: string;
}

export interface ExportRun {
  run: RunRow;
  requests: RunRequestRow[];
  /** Keyed by `trace_id`. Missing entries simply export as empty cells. */
  content?: Map<string, ExportContent>;
}

export type ExportFormat = 'csv' | 'json' | 'jsonl';

export type ExportCell = string | number | null;

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'csv' || value === 'json' || value === 'jsonl';
}

export function exportContentType(format: ExportFormat): string {
  if (format === 'csv') return 'text/csv';
  if (format === 'jsonl') return 'application/x-ndjson';
  return 'application/json';
}

export function exportExtension(format: ExportFormat): string {
  return format === 'jsonl' ? 'jsonl' : format;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `relayplane-runs-<yyyymmdd>.<ext>` in UTC, matching the run id date stamp. */
export function exportFilename(format: ExportFormat, now?: number): string {
  const d = new Date(now ?? Date.now());
  const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  return `relayplane-runs-${stamp}.${exportExtension(format)}`;
}

function isoTs(ts: number): string {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/** One flat record per request, in `EXPORT_COLUMNS` order. */
export function buildExportRow(
  run: RunRow,
  req: RunRequestRow,
  content: ExportContent | undefined,
  includeContent: boolean,
): Record<string, ExportCell> {
  const row: Record<string, ExportCell> = {
    run_id: req.run_id,
    run_label: run.label,
    parent_run_id: run.parent_run_id,
    run_source: run.run_source,
    agent_label: req.agent_label,
    thread_id: req.thread_id,
    trace_id: req.trace_id,
    ts: isoTs(req.ts),
    model: req.model,
    requested_model: req.requested_model,
    provider: req.provider,
    tokens_in: req.tokens_in,
    tokens_out: req.tokens_out,
    cache_read: req.cache_read,
    cache_creation: req.cache_creation,
    cost_usd: req.cost_usd,
    latency_ms: req.latency_ms,
    success: req.success,
    status_code: req.status_code,
    complexity: req.complexity,
    task_type: req.task_type,
    tags: formatTags(run.tags),
    attempt: req.attempt,
    is_retry: req.is_retry,
    retry_reason: req.retry_reason,
    cache_state: req.cache_state,
  };
  if (includeContent) {
    row['system_prompt'] = content?.systemPrompt ?? null;
    row['user_message'] = content?.userMessage ?? null;
    row['response_preview'] = content?.responsePreview ?? null;
  }
  return row;
}

function columnsFor(includeContent: boolean): string[] {
  return includeContent ? [...EXPORT_COLUMNS, ...CONTENT_COLUMNS] : [...EXPORT_COLUMNS];
}

/** RFC 4180: quote when the cell holds a comma, a quote, CR or LF; double inner quotes. */
export function csvCell(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : value;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function eachRow(
  runs: ExportRun[],
  includeContent: boolean,
  visit: (row: Record<string, ExportCell>) => void,
): void {
  for (const entry of runs) {
    for (const req of entry.requests) {
      visit(buildExportRow(entry.run, req, entry.content?.get(req.trace_id), includeContent));
    }
  }
}

export function exportCsv(runs: ExportRun[], includeContent = false): string {
  const columns = columnsFor(includeContent);
  const lines: string[] = [columns.join(',')];
  eachRow(runs, includeContent, (row) => {
    lines.push(columns.map((c) => csvCell(row[c] ?? null)).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

export function exportJsonl(runs: ExportRun[], includeContent = false): string {
  const columns = columnsFor(includeContent);
  const lines: string[] = [];
  eachRow(runs, includeContent, (row) => {
    const ordered: Record<string, ExportCell> = {};
    for (const c of columns) ordered[c] = row[c] ?? null;
    lines.push(JSON.stringify(ordered));
  });
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function exportJson(runs: ExportRun[], includeContent = false, now?: number): string {
  const payload = {
    exported_at: new Date(now ?? Date.now()).toISOString(),
    runs: runs.map((entry) => ({
      ...entry.run,
      requests: entry.requests.map((req) => {
        if (!includeContent) return { ...req };
        const content = entry.content?.get(req.trace_id);
        return {
          ...req,
          system_prompt: content?.systemPrompt ?? null,
          user_message: content?.userMessage ?? null,
          response_preview: content?.responsePreview ?? null,
        };
      }),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function renderExport(runs: ExportRun[], format: ExportFormat, includeContent = false): string {
  if (format === 'csv') return exportCsv(runs, includeContent);
  if (format === 'jsonl') return exportJsonl(runs, includeContent);
  return exportJson(runs, includeContent);
}
