/**
 * Routing Log
 *
 * In-memory ring buffer (1000 entries) with JSONL persistence at
 * ~/.relayplane/routing-log.jsonl. Tracks all routing decisions for
 * observability and debugging.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ResolvedBy } from './agent-policy.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RoutingLogEntry {
  ts: string;                    // ISO 8601
  requestId: string;
  agentFingerprint: string | null;
  agentName: string | null;
  taskType: string;
  complexity: string;
  resolvedModel: string;         // "provider/model"
  resolvedBy: ResolvedBy;
  candidateModel: string | null; // what complexity routing would have picked
  reason: string;                // human-readable from PolicyResolution.reason
  // Optional — populated from upstream response usage headers/body when available
  inputTokens?: number;          // prompt token count from provider response
  outputTokens?: number;         // completion token count from provider response
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.relayplane');
export const LOG_FILE = path.join(LOG_DIR, 'routing-log.jsonl');
const BAK_FILE = path.join(LOG_DIR, 'routing-log.jsonl.bak');
const MAX_ENTRIES = 1000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── State ────────────────────────────────────────────────────────────────────

let _buffer: RoutingLogEntry[] = [];

/** Reset for testing */
export function _resetRoutingLog(): void {
  _buffer = [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize routing log by loading the last 1000 lines from file.
 * Called once on proxy startup.
 */
export function initRoutingLog(): void {
  if (!fs.existsSync(LOG_FILE)) return;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const last = lines.slice(-MAX_ENTRIES);
    _buffer = [];
    for (const line of last) {
      try {
        const entry = JSON.parse(line) as RoutingLogEntry;
        _buffer.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Non-critical — start with empty buffer
  }
}

/**
 * Append a routing decision to the in-memory buffer and JSONL file.
 */
export function appendRoutingLog(entry: RoutingLogEntry): void {
  // Ring buffer: drop oldest when full
  if (_buffer.length >= MAX_ENTRIES) {
    _buffer.shift();
  }
  _buffer.push(entry);

  // Persist to file
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    // Rotate if file is too large
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_FILE_SIZE) {
        fs.renameSync(LOG_FILE, BAK_FILE);
      }
    } catch {
      // File may not exist yet — that's fine
    }

    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Non-critical — don't break the proxy
  }
}

/**
 * Get routing log entries from the in-memory buffer with optional filters.
 */
export function getRoutingLog(opts?: {
  limit?: number;
  agentFingerprint?: string;
  taskType?: string;
}): RoutingLogEntry[] {
  let entries = _buffer.slice();

  if (opts?.agentFingerprint) {
    const fp = opts.agentFingerprint;
    entries = entries.filter(e => e.agentFingerprint === fp || e.agentName === fp);
  }
  if (opts?.taskType) {
    const tt = opts.taskType;
    entries = entries.filter(e => e.taskType === tt);
  }

  const limit = Math.min(opts?.limit ?? 100, MAX_ENTRIES);
  return entries.slice(-limit);
}

/**
 * No-op flush — writes are synchronous. Called for symmetry on shutdown.
 */
export function flushRoutingLog(): void {
  // No-op: all writes are synchronous appends
}
