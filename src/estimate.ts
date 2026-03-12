/**
 * Pre-flight cost estimation for RelayPlane proxy.
 *
 * POST /v1/estimate — Pro-tier feature.
 *
 * Accepts `{ model, messages, max_tokens }` (same shape as chat completions)
 * and returns a cost estimate without forwarding to any provider.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { estimateCost, MODEL_PRICING } from './telemetry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EstimateRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown[] }>;
  max_tokens?: number;
}

export interface EstimateResponse {
  model: string;
  estimated_cost_usd: number;
  input_tokens: number;
  estimated_output_tokens: number;
  provider: string;
  note: 'estimate only';
}

export interface UpgradeRequiredError {
  error: 'upgrade_required';
  message: string;
  url: string;
}

export interface InvalidRequestError {
  error: 'invalid_request';
  message: string;
}

// ---------------------------------------------------------------------------
// Token counting (no external deps — ~4 chars per token heuristic + role overhead)
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;
// Anthropic/OpenAI: ~4 tokens overhead per message (role + structural markup)
const TOKENS_PER_MESSAGE_OVERHEAD = 4;

/**
 * Count tokens in a string using the standard 4-chars-per-token heuristic.
 * This is equivalent to tiktoken for the purposes of cost estimation.
 */
export function countTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Count total input tokens across all messages.
 */
export function countMessagesTokens(
  messages: Array<{ role: string; content: string | unknown[] }>
): number {
  let total = 0;
  for (const msg of messages) {
    total += TOKENS_PER_MESSAGE_OVERHEAD;
    const content = msg.content;
    if (typeof content === 'string') {
      total += countTextTokens(content);
    } else if (Array.isArray(content)) {
      // OpenAI content blocks: [{type:'text', text:'...'}, ...]
      for (const block of content) {
        if (
          block !== null &&
          typeof block === 'object' &&
          'text' in (block as object) &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          total += countTextTokens((block as { text: string }).text);
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Provider inference from model name
// ---------------------------------------------------------------------------

const MODEL_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^claude/i, provider: 'anthropic' },
  { pattern: /^gpt-|^o[0-9]|^text-/i, provider: 'openai' },
  { pattern: /^gemini/i, provider: 'google' },
  { pattern: /^grok/i, provider: 'xai' },
  { pattern: /^deepseek/i, provider: 'deepseek' },
  { pattern: /^llama|^mixtral|^mistral/i, provider: 'openrouter' },
];

/**
 * Infer provider from model name.
 */
export function inferProvider(model: string): string {
  for (const { pattern, provider } of MODEL_PROVIDER_PATTERNS) {
    if (pattern.test(model)) return provider;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Pro tier check
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.relayplane');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

interface Credentials {
  apiKey?: string;
  plan?: string;
  email?: string;
}

const PRO_PLANS = new Set(['pro', 'max', 'enterprise']);

/**
 * Returns true if the current local credentials indicate a Pro (or higher) plan.
 * Also respects the RELAYPLANE_PRO_ESTIMATE env variable for testing / CI overrides.
 * The env override is intentionally disabled in production to prevent bypassing the gate.
 */
export function isProTier(): boolean {
  // Allow env-based override in non-production environments only (tests, CI, dev)
  if (process.env.NODE_ENV !== 'production') {
    const envOverride = process.env.RELAYPLANE_PRO_ESTIMATE;
    if (envOverride === 'true' || envOverride === '1') return true;
    if (envOverride === 'false' || envOverride === '0') return false;
  }

  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds: Credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      if (creds.plan && PRO_PLANS.has(creds.plan.toLowerCase())) return true;
    }
  } catch {
    // If we can't read credentials, treat as free tier
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core estimation logic
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_MULTIPLIER = 1.5;

/**
 * Estimate cost for a chat request without forwarding to the provider.
 */
export function estimateChatRequest(req: EstimateRequest): EstimateResponse {
  const inputTokens = countMessagesTokens(req.messages);

  const estimatedOutputTokens =
    req.max_tokens != null
      ? req.max_tokens
      : Math.ceil(inputTokens * DEFAULT_OUTPUT_MULTIPLIER);

  const estimatedCostUsd = estimateCost(req.model, inputTokens, estimatedOutputTokens);

  const provider = inferProvider(req.model);

  return {
    model: req.model,
    estimated_cost_usd: estimatedCostUsd,
    input_tokens: inputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    provider,
    note: 'estimate only',
  };
}

/**
 * The full estimate endpoint handler (called from standalone-proxy.ts).
 * Returns `{ status, body }` so the proxy can write headers + body.
 */
export function handleEstimateRequest(
  rawBody: string
): { status: number; body: EstimateResponse | UpgradeRequiredError | InvalidRequestError } {
  // --- Pro tier gate ---
  if (!isProTier()) {
    return {
      status: 402,
      body: {
        error: 'upgrade_required',
        message: 'Upgrade to Pro for pre-flight cost estimation',
        url: 'https://relayplane.com/pricing',
      },
    };
  }

  // --- Parse request ---
  let req: EstimateRequest;
  try {
    req = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'Invalid JSON body',
      },
    };
  }

  if (!req.model || !Array.isArray(req.messages)) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'model and messages are required',
      },
    };
  }

  // --- Validate max_tokens bounds ---
  if (
    req.max_tokens != null &&
    (req.max_tokens <= 0 || req.max_tokens > 200_000 || !Number.isFinite(req.max_tokens))
  ) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'max_tokens must be 1–200000',
      },
    };
  }

  const estimate = estimateChatRequest(req);
  return { status: 200, body: estimate };
}

/**
 * Export the pricing table so tests and external callers can inspect it.
 */
export { MODEL_PRICING };

// ---------------------------------------------------------------------------
// Per-IP rate limiter for /v1/estimate — extracted for testability
// ---------------------------------------------------------------------------

export interface EstimateRateLimitEntry {
  windowStart: number;
  count: number;
}

export interface EstimateRateLimitResult {
  /** Whether the request is allowed within the current window. */
  allowed: boolean;
  /** Current request count in the window (after incrementing on success). */
  count: number;
}

/**
 * Check and update the per-IP rate limit for /v1/estimate.
 *
 * Uses `remoteAddress` (socket-level) as the key — never x-forwarded-for.
 * Mutates rateMap in place. Returns { allowed: false } when limit is exceeded.
 */
export function checkEstimateRateLimit(
  rateMap: Map<string, EstimateRateLimitEntry>,
  ip: string,
  now: number,
  windowMs = 60_000,
  maxRequests = 60,
): EstimateRateLimitResult {
  const entry = rateMap.get(ip);
  if (entry && now - entry.windowStart < windowMs) {
    if (entry.count >= maxRequests) {
      return { allowed: false, count: entry.count };
    }
    entry.count++;
    return { allowed: true, count: entry.count };
  }
  // New window — create or reset entry
  rateMap.set(ip, { windowStart: now, count: 1 });
  return { allowed: true, count: 1 };
}

/**
 * Purge entries from rateMap whose window has expired.
 * Call this periodically (e.g. every 5 minutes) to bound memory usage.
 */
export function purgeExpiredRateLimitEntries(
  rateMap: Map<string, EstimateRateLimitEntry>,
  now: number,
  windowMs = 60_000,
): void {
  for (const [ip, entry] of rateMap) {
    if (now - entry.windowStart > windowMs) {
      rateMap.delete(ip);
    }
  }
}
