/**
 * RelayPlane Proxy Telemetry
 * 
 * Anonymized telemetry collection for improving model routing.
 * 
 * What we collect (exact schema):
 * - device_id: anonymous random ID
 * - task_type: inferred from token patterns, NOT prompt content
 * - model: which model was used
 * - tokens_in/out: token counts
 * - latency_ms: response time
 * - success: whether request succeeded
 * - cost_usd: estimated cost
 * 
 * What we NEVER collect:
 * - Prompts or responses
 * - File paths or contents
 * - Anything that could identify you or your project
 * 
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDeviceId, isTelemetryEnabled, getConfigDir } from './config.js';

/**
 * Telemetry event schema (matches PITCH-v2.md)
 */
export interface TelemetryEvent {
  /** Anonymous device ID */
  device_id: string;
  
  /** Inferred task type (from token patterns, NOT prompt content) */
  task_type: string;
  
  /** Model used */
  model: string;
  
  /** Input tokens */
  tokens_in: number;
  
  /** Output tokens */
  tokens_out: number;
  
  /** Request latency in milliseconds */
  latency_ms: number;
  
  /** Whether request succeeded */
  success: boolean;
  
  /** Estimated cost in USD */
  cost_usd: number;
  
  /** Timestamp */
  timestamp: string;

  /** Original requested model (before routing) */
  requested_model?: string;

  /** Anthropic prompt caching: tokens used to create new cache entries */
  cache_creation_tokens?: number;

  /** Anthropic prompt caching: tokens read from cache */
  cache_read_tokens?: number;
}

/**
 * Local telemetry store using SQLite (via Ledger)
 */
const TELEMETRY_FILE = path.join(getConfigDir(), 'telemetry.jsonl');

// In-memory buffer for audit mode
let auditBuffer: TelemetryEvent[] = [];
let auditMode = false;
let offlineMode = false;

/**
 * Task type inference based on token patterns
 * This infers task type from request characteristics, NOT from prompt content
 */
export function inferTaskType(
  inputTokens: number,
  outputTokens: number,
  model: string,
  hasTools: boolean = false
): string {
  // Simple heuristics based on token patterns
  const ratio = outputTokens / Math.max(inputTokens, 1);
  
  if (hasTools) {
    return 'tool_use';
  }
  
  if (inputTokens > 10000) {
    return 'long_context';
  }
  
  if (ratio > 5) {
    return 'generation';
  }
  
  if (ratio < 0.3 && outputTokens < 100) {
    return 'classification';
  }
  
  if (inputTokens < 500 && outputTokens < 500) {
    return 'quick_task';
  }
  
  if (inputTokens > 2000 && outputTokens > 500) {
    return 'code_review';
  }
  
  if (outputTokens > 1000) {
    return 'content_generation';
  }
  
  return 'general';
}

/**
 * Estimate cost based on model and token counts
 * Pricing as of 2024 (USD per 1M tokens)
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic — versioned IDs
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // Anthropic — -latest aliases (resolve to same tier)
  'claude-opus-4-latest': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-latest': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-latest': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4.0 },
  'claude-3-haiku-latest': { input: 0.25, output: 1.25 },
  // Anthropic — short aliases used in proxy MODEL_MAPPING
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },

  // Google
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  
  // Default for unknown models
  'default': { input: 1.0, output: 3.0 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number, cacheCreationTokens?: number, cacheReadTokens?: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  if (cacheCreationTokens || cacheReadTokens) {
    // With cache breakdown: inputTokens is only the non-cached portion
    const regularInputCost = (inputTokens / 1_000_000) * pricing.input;
    const cacheCreationCost = ((cacheCreationTokens ?? 0) / 1_000_000) * pricing.input * 1.25;
    const cacheReadCost = ((cacheReadTokens ?? 0) / 1_000_000) * pricing.input * 0.1;
    return regularInputCost + cacheCreationCost + cacheReadCost + outputCost;
  }

  // No cache breakdown — backward compatible
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  return inputCost + outputCost; // Full precision — rounding happens at display time
}

/**
 * Set audit mode - shows telemetry payload before sending
 */
export function setAuditMode(enabled: boolean): void {
  auditMode = enabled;
}

/**
 * Check if audit mode is enabled
 */
export function isAuditMode(): boolean {
  return auditMode;
}

/**
 * Set offline mode - disables all network calls except LLM
 */
export function setOfflineMode(enabled: boolean): void {
  offlineMode = enabled;
}

/**
 * Check if offline mode is enabled
 */
export function isOfflineMode(): boolean {
  return offlineMode;
}

/**
 * Get pending audit events
 */
export function getAuditBuffer(): TelemetryEvent[] {
  return [...auditBuffer];
}

/**
 * Clear audit buffer
 */
export function clearAuditBuffer(): void {
  auditBuffer = [];
}

/**
 * Record a telemetry event
 */
export function recordTelemetry(event: Omit<TelemetryEvent, 'device_id' | 'timestamp'>): void {
  if (!isTelemetryEnabled() && !auditMode) {
    return; // Telemetry disabled and not in audit mode
  }
  
  const fullEvent: TelemetryEvent = {
    ...event,
    device_id: getDeviceId(),
    timestamp: new Date().toISOString(),
  };
  
  if (auditMode) {
    // In audit mode, buffer events and print them
    auditBuffer.push(fullEvent);
    console.log('\n📊 [TELEMETRY AUDIT] The following data would be collected:');
    console.log(JSON.stringify(fullEvent, null, 2));
    console.log('');
    return;
  }
  
  if (!isTelemetryEnabled()) {
    return;
  }
  
  // Store locally (append to JSONL file)
  try {
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(fullEvent) + '\n');
  } catch (err) {
    // Silently fail - telemetry should never break the proxy
  }
  
  // Queue for cloud upload (if not offline)
  queueForUpload(fullEvent);
}

/**
 * Get local telemetry data
 */
export function getLocalTelemetry(): TelemetryEvent[] {
  try {
    if (!fs.existsSync(TELEMETRY_FILE)) {
      return [];
    }
    
    const data = fs.readFileSync(TELEMETRY_FILE, 'utf-8');
    return data
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as TelemetryEvent);
  } catch (err) {
    return [];
  }
}

/**
 * Get telemetry stats summary
 */
export function getTelemetryStats(): {
  totalEvents: number;
  totalCost: number;
  baselineCost: number;
  savings: number;
  savingsPercent: number;
  byModel: Record<string, { count: number; cost: number; baselineCost: number }>;
  byTaskType: Record<string, { count: number; cost: number }>;
  successRate: number;
  savingsNote?: string;
} {
  const events = getLocalTelemetry();
  
  // Default baseline model: what you'd be paying without RelayPlane
  // Baseline = most recently used task-appropriate model
  const BASELINE_MODEL = 'claude-3-5-haiku-20241022'; // Safe default, Haiku
  
  const byModel: Record<string, { count: number; cost: number; baselineCost: number }> = {};
  const byTaskType: Record<string, { count: number; cost: number }> = {};
  let totalCost = 0;
  let totalBaselineCost = 0;
  let successCount = 0;
  
  for (const event of events) {
    totalCost += event.cost_usd;
    if (event.success) successCount++;
    
    // Calculate what this request would have cost on the baseline model
    const baselineForEvent = estimateCost(BASELINE_MODEL, event.tokens_in, event.tokens_out);
    totalBaselineCost += baselineForEvent;
    
    if (!byModel[event.model]) {
      byModel[event.model] = { count: 0, cost: 0, baselineCost: 0 };
    }
    byModel[event.model].count++;
    byModel[event.model].cost += event.cost_usd;
    byModel[event.model].baselineCost += baselineForEvent;
    
    if (!byTaskType[event.task_type]) {
      byTaskType[event.task_type] = { count: 0, cost: 0 };
    }
    byTaskType[event.task_type].count++;
    byTaskType[event.task_type].cost += event.cost_usd;
  }
  
  const savings = totalBaselineCost - totalCost;
  const savingsPercent = totalBaselineCost > 0 ? (savings / totalBaselineCost) * 100 : 0;
  
  return {
    totalEvents: events.length,
    totalCost: Math.round(totalCost * 10000) / 10000,
    baselineCost: Math.round(totalBaselineCost * 10000) / 10000,
    savings: Math.round(savings * 10000) / 10000,
    savingsPercent: Math.round(savingsPercent * 10) / 10,
    byModel,
    byTaskType,
    successRate: events.length > 0 ? successCount / events.length : 0,
    savingsNote: 'Baseline model: Claude Opus (input: $15/1M, output: $75/1M). ' +
      'Actual routing selects cheaper models based on task complexity.',
  };
}

/**
 * Clear all local telemetry data
 */
export function clearTelemetry(): void {
  try {
    if (fs.existsSync(TELEMETRY_FILE)) {
      fs.unlinkSync(TELEMETRY_FILE);
    }
  } catch (err) {
    // Silently fail
  }
}

/**
 * Get telemetry file path
 */
export function getTelemetryPath(): string {
  return TELEMETRY_FILE;
}

// ============================================
// CLOUD TELEMETRY UPLOAD
// ============================================

const BRAIN_API_URL = process.env.RELAYPLANE_API_URL || 'https://api.relayplane.com';
const UPLOAD_BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 5000; // 5 second debounce

let uploadQueue: TelemetryEvent[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue an event for cloud upload
 */
export function queueForUpload(event: TelemetryEvent): void {
  if (offlineMode) return;
  
  uploadQueue.push(event);
  
  // Flush immediately if batch is full
  if (uploadQueue.length >= UPLOAD_BATCH_SIZE) {
    flushTelemetryToCloud().catch(() => {});
    return;
  }
  
  // Otherwise debounce: flush 5s after last event (batches rapid-fire calls)
  if (flushTimeout) clearTimeout(flushTimeout);
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    flushTelemetryToCloud().catch(() => {});
  }, FLUSH_DELAY_MS);
}

/**
 * Flush queued telemetry to cloud
 * Uses authenticated endpoint if API key available, otherwise anonymous endpoint
 */
export async function flushTelemetryToCloud(): Promise<void> {
  if (offlineMode || uploadQueue.length === 0) return;
  
  const apiKey = getApiKey();
  
  // Use anonymous endpoint for free tier, authenticated for Pro
  const endpoint = apiKey 
    ? `${BRAIN_API_URL}/v1/telemetry`
    : `${BRAIN_API_URL}/v1/telemetry/anonymous`;
  
  // Anonymous uploads have smaller batch limit (100 vs 1000)
  const batchSize = apiKey ? UPLOAD_BATCH_SIZE : Math.min(UPLOAD_BATCH_SIZE, 100);
  const batch = uploadQueue.splice(0, batchSize);
  
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Only add auth header if we have an API key
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        schemaVersion: '1.0',
        events: batch,
      }),
    });
    
    if (!response.ok) {
      // Re-queue failed events
      uploadQueue.unshift(...batch);
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    if (result.success) {
      // Successfully uploaded
    } else {
      // Partial failure - log but continue
      console.warn('[Telemetry] Partial upload failure:', result.errors);
    }
  } catch (err) {
    // Network error - re-queue events
    uploadQueue.unshift(...batch);
    throw err;
  }
}

/**
 * Get configured API key
 * Checks: 1) credentials.json (from `relayplane login`), 2) config.json, 3) env var
 */
function getApiKey(): string | null {
  try {
    // Check credentials file first (from `relayplane login`)
    const credPath = path.join(getConfigDir(), 'credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (creds.apiKey) return creds.apiKey;
    }
  } catch {}
  try {
    const configPath = path.join(getConfigDir(), 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.apiKey || null;
    }
  } catch (err) {
    // Ignore config read errors
  }
  return process.env.RELAYPLANE_API_KEY || null;
}

/**
 * Stop upload timer (for cleanup)
 */
export function stopUploadTimer(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  // Final flush on shutdown
  flushTelemetryToCloud().catch(() => {});
}

/**
 * Get number of events pending upload
 */
export function getPendingUploadCount(): number {
  return uploadQueue.length;
}

/**
 * Print telemetry disclosure message
 */
export function printTelemetryDisclosure(): void {
  console.log(`
╭─────────────────────────────────────────────────────────────────────╮
│                    📊 TELEMETRY DISCLOSURE                          │
╰─────────────────────────────────────────────────────────────────────╯

RelayPlane collects anonymous telemetry to improve model routing.

What we collect:
  • Anonymous device ID (random, not fingerprintable)
  • Task type (inferred from token patterns, NOT your prompts)
  • Model used, token counts, latency, success/failure
  • Estimated cost

What we NEVER collect:
  • Your prompts or model responses
  • File paths or contents
  • Anything that could identify you or your project

How to verify:
  • Run with --audit to see exact payloads before they're sent
  • Run with --offline to disable all telemetry transmission
  • Full source code: https://github.com/RelayPlane/proxy

To opt out completely:
  $ relayplane-proxy telemetry off

Learn more: https://relayplane.com/privacy

`);
}
