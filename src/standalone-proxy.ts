/**
 * RelayPlane L2/L3 Proxy Server
 *
 * An LLM Gateway proxy that routes requests
 * to configurable models using @relayplane/core.
 *
 * Supports:
 * - OpenAI-compatible API (/v1/chat/completions)
 * - Native Anthropic API (/v1/messages) for Claude Code integration
 * - Streaming (SSE) for both OpenAI and Anthropic formats
 * - Auth passthrough for Claude Code (OAuth/subscription billing)
 * - Cross-provider routing (Anthropic, OpenAI, Google, xAI)
 * - Tool/function calling with format conversion
 *
 * Authentication:
 * - Anthropic: Passthrough incoming Authorization header OR ANTHROPIC_API_KEY env
 * - Other providers: Require provider-specific API key env vars
 *
 * @packageDocumentation
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RelayPlane, inferTaskType, getInferenceConfidence } from '@relayplane/core';

// __dirname is available natively in CJS
import type { Provider as CoreProvider, TaskType } from '@relayplane/core';

type Provider = CoreProvider
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'together'
  | 'fireworks'
  | 'perplexity'
  | 'ollama';
import { buildModelNotFoundError } from './utils/model-suggestions.js';
import { recordTelemetry as recordCloudTelemetry, inferTaskType as inferTelemetryTaskType, estimateCost, queueForUpload } from './telemetry.js';
import { maybeFireActivated, maybeSendSessionHeartbeat } from './lifecycle-telemetry.js';
import { loadConfig as loadUserConfig, hasValidCredentials, getMeshConfig, getDeviceId, isTelemetryEnabled } from './config.js';
import { initMeshLayer, type MeshHandle } from './mesh/index.js';
import { getResponseCache, computeCacheKey, computeAggressiveCacheKey, isDeterministic, responseHasToolCalls, type CacheConfig } from './response-cache.js';
import { StatsCollector } from './stats.js';
import { acquireSlot, RateLimitError, configureRateLimiter } from './rate-limiter.js';
import {
  type OllamaProviderConfig,
  checkOllamaHealthCached,
  clearOllamaHealthCache,
  shouldRouteToOllama,
  resolveOllamaModel,
  forwardToOllama,
  forwardToOllamaStream,
  mapCloudModelToOllama,
  OLLAMA_DEFAULTS,
} from './ollama.js';
import {
  crossProviderCascade,
  CrossProviderCascadeManager,
  type CrossProviderCascadeConfig,
  type CascadeHop,
} from './cross-provider-cascade.js';
import { getBudgetManager, type BudgetConfig, type SessionBudgetCheckResult } from './budget.js';
import { getAnomalyDetector, type AnomalyConfig } from './anomaly.js';
import { getAlertManager, type AlertsConfig } from './alerts.js';
import { checkDowngrade, applyDowngradeHeaders, type DowngradeConfig, DEFAULT_DOWNGRADE_CONFIG } from './downgrade.js';
import { loadAgentRegistry, flushAgentRegistry, trackAgent, extractSystemPromptFromBody, renameAgent, getAgentRegistry, getAgentSummaries, updateAgentCost } from './agent-tracker.js';
import { getVersionStatus } from './utils/version-status.js';
import { initNudge, checkAndShowNudge } from './signup-nudge.js';
import { initStarNudge, checkAndShowStarNudge } from './star-nudge.js';
import { handleEstimateRequest, checkEstimateRateLimit, purgeExpiredRateLimitEntries, type EstimateRateLimitEntry } from './estimate.js';

// Per-IP rate limit state for /v1/estimate (60 req/min per IP)
const estimateRateMap = new Map<string, EstimateRateLimitEntry>();

// Fix A: Purge expired rate-limit entries every 5 minutes to prevent memory leak.
// Without this, IPs that make one request and disappear stay in the map forever.
setInterval(() => purgeExpiredRateLimitEntries(estimateRateMap, Date.now()), 5 * 60 * 1000);

import { captureAtom, countAtomsForSession, getOsmosisDb, getRelayplaneDir } from './osmosis-store.js';
import { writeEpisode } from './episode-writer.js';
import { getSessionId, upsertSession, getSessions, getActiveSessions } from './session-tracker.js';
import { TraceWriter, sha256Hex, defaultTracesConfig } from './trace-writer.js';
import { getToolRouter, extractToolContext } from './tool-router.js';
import { getTokenPool, type PoolAccountConfig } from './token-pool.js';
import { randomUUID } from 'node:crypto';
const PROXY_VERSION: string = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

/** Returns true when the model is a Haiku variant (does not support extended thinking) */
function isHaikuModel(model: string): boolean {
  return model.includes('haiku');
}

/** Beta flags that OAT tokens (sk-ant-oat*) do not support */
const OAT_UNSUPPORTED_BETA_FLAGS = new Set(['max-tokens-3-5-sonnet-2025-04-14']);

let latestProxyVersionCache: { value: string | null; checkedAt: number } = { value: null, checkedAt: 0 };
const LATEST_PROXY_VERSION_TTL_MS = 30 * 60 * 1000;

async function getLatestProxyVersion(): Promise<string | null> {
  const now = Date.now();
  if (now - latestProxyVersionCache.checkedAt < LATEST_PROXY_VERSION_TTL_MS) {
    return latestProxyVersionCache.value;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://registry.npmjs.org/@relayplane/proxy/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      latestProxyVersionCache = { value: null, checkedAt: now };
      return null;
    }

    const data = await res.json() as { version?: string };
    const latest = data.version ?? null;
    latestProxyVersionCache = { value: latest, checkedAt: now };
    return latest;
  } catch {
    latestProxyVersionCache = { value: null, checkedAt: now };
    return null;
  }
}

/** Shared stats collector instance for the proxy server */
export const proxyStatsCollector = new StatsCollector();

/** Shared mesh handle — set during startProxy() */
let _meshHandle: MeshHandle | null = null;

/** Capture a request into the mesh (fire-and-forget, never blocks) */
function meshCapture(
  model: string, provider: string, taskType: string,
  tokensIn: number, tokensOut: number, costUsd: number,
  latencyMs: number, success: boolean, errorType?: string,
): void {
  // Osmosis Phase 1: capture KnowledgeAtom (always, independent of mesh)
  const ts = Date.now();
  if (success) {
    captureAtom({
      type: 'success',
      model,
      taskType,
      latencyMs,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      timestamp: ts,
    });
  } else {
    captureAtom({
      type: 'failure',
      errorType: errorType ?? 'unknown',
      model,
      fallbackTaken: false,
      timestamp: ts,
    });
  }

  if (!_meshHandle) return;
  try {
    _meshHandle.captureRequest({
      model, provider, task_type: taskType,
      input_tokens: tokensIn, output_tokens: tokensOut,
      cost_usd: costUsd, latency_ms: latencyMs,
      success, error_type: errorType,
      timestamp: new Date().toISOString(),
    });
  } catch {}
}

/**
 * Provider endpoint configuration
 */
export interface ProviderEndpoint {
  baseUrl: string;
  apiKeyEnv: string;
}

/**
 * Default provider endpoints
 */
export const DEFAULT_ENDPOINTS: Record<string, ProviderEndpoint> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
  },
  fireworks: {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
  },
  perplexity: {
    baseUrl: 'https://api.perplexity.ai',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    apiKeyEnv: 'OLLAMA_API_KEY', // Not actually required, placeholder for consistency
  },
};

/**
 * Model to provider/model mapping
 */
export const MODEL_MAPPING: Record<string, { provider: Provider; model: string }> = {
  // Anthropic models (using correct API model IDs)
  'claude-opus-4-5': { provider: 'anthropic', model: 'claude-opus-4-6' },
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'claude-haiku-4-5': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-6' },
  // OpenAI models
  'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
  // OpenAI GPT-5 family
  'gpt-5.4':           { provider: 'openai', model: 'gpt-5.4' },
  'gpt-5.4-pro':       { provider: 'openai', model: 'gpt-5.4-pro' },
  'gpt-5.3':           { provider: 'openai', model: 'gpt-5.3-chat' },
  'gpt-5.2':           { provider: 'openai', model: 'gpt-5.2' },
  'gpt-5.1':           { provider: 'openai', model: 'gpt-5.1' },
  'gpt-5':             { provider: 'openai', model: 'gpt-5.4' },
  'gpt-5-mini':        { provider: 'openai', model: 'gpt-5-mini' },
  'gpt-5-nano':        { provider: 'openai', model: 'gpt-5-nano' },
  // OpenAI GPT-4.1
  'gpt-4.1-mini':      { provider: 'openai', model: 'gpt-4.1-mini' },
  'gpt-4.1-nano':      { provider: 'openai', model: 'gpt-4.1-nano' },
  // OpenAI O-series reasoning
  'o3':                { provider: 'openai', model: 'o3' },
  'o3-pro':            { provider: 'openai', model: 'o3-pro' },
  'o3-mini':           { provider: 'openai', model: 'o3-mini' },
  'o4-mini':           { provider: 'openai', model: 'o4-mini' },
  // Google Gemini
  'gemini-3.1-pro':        { provider: 'google', model: 'gemini-3.1-pro-preview' },
  'gemini-3-pro':          { provider: 'google', model: 'gemini-3-pro-preview' },
  'gemini-3-flash':        { provider: 'google', model: 'gemini-3-flash-preview' },
  'gemini-2.5-pro':        { provider: 'google', model: 'gemini-2.5-pro' },
  'gemini-2.5-flash':      { provider: 'google', model: 'gemini-2.5-flash' },
  'gemini-2.5-flash-lite': { provider: 'google', model: 'gemini-2.5-flash-lite' },
  'gemini-2.0-flash':      { provider: 'google', model: 'gemini-2.0-flash' },
  // xAI Grok
  'grok-4.20':         { provider: 'xai', model: 'grok-4.20-beta' },
  'grok-4':            { provider: 'xai', model: 'grok-4' },
  'grok-4-fast':       { provider: 'xai', model: 'grok-4-fast' },
  'grok-4.1-fast':     { provider: 'xai', model: 'grok-4.1-fast' },
  'grok-3':            { provider: 'xai', model: 'grok-3' },
  'grok-3-mini':       { provider: 'xai', model: 'grok-3-mini' },
  // DeepSeek
  'deepseek':          { provider: 'deepseek', model: 'deepseek-chat' },
  'deepseek-r1':       { provider: 'deepseek', model: 'deepseek-reasoner' },
};

/**
 * RelayPlane model aliases - resolve before routing
 * These are user-friendly aliases that map to internal routing modes
 */
export const RELAYPLANE_ALIASES: Record<string, string> = {
  'relayplane:auto': 'rp:balanced',
  'rp:auto': 'rp:balanced',
};

/**
 * Smart routing aliases - map to specific provider/model combinations
 * These provide semantic shortcuts for common use cases.
 * Populated dynamically at proxy startup based on available env vars.
 * Use buildSmartAliases() to (re)generate.
 */
export let SMART_ALIASES: Record<string, { provider: Provider; model: string }> = {
  // Defaults: Anthropic passthrough (Max plan / Claude Code users with no API key)
  'rp:best': { provider: 'anthropic', model: 'claude-opus-4-6' },
  'rp:fast': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'rp:cheap': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'rp:balanced': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

/**
 * Build provider-aware smart aliases based on available env vars at startup.
 * Priority: OPENROUTER_API_KEY > ANTHROPIC_API_KEY > OPENAI_API_KEY > fallback (OpenRouter defaults).
 * Call this once at proxy startup.
 */
export function buildSmartAliases(): { aliases: Record<string, { provider: Provider; model: string }>; via: string } {
  if (process.env['OPENROUTER_API_KEY']) {
    return {
      via: 'openrouter',
      aliases: {
        'rp:best': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
        'rp:fast': { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku' },
        'rp:cheap': { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
        'rp:balanced': { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku' },
      },
    };
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    return {
      via: 'anthropic',
      aliases: {
        'rp:best': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        'rp:fast': { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        'rp:cheap': { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        'rp:balanced': { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
      },
    };
  }
  if (process.env['OPENAI_API_KEY']) {
    return {
      via: 'openai',
      aliases: {
        'rp:best': { provider: 'openai', model: 'gpt-4o' },
        'rp:fast': { provider: 'openai', model: 'gpt-4o-mini' },
        'rp:cheap': { provider: 'openai', model: 'gpt-4o-mini' },
        'rp:balanced': { provider: 'openai', model: 'gpt-4o-mini' },
      },
    };
  }
  // Max plan / Claude Code passthrough — no API key, auth comes from Claude Code at request time
  // Haiku not available on Max plan, so Sonnet/Opus only
  return {
    via: 'anthropic (Max plan passthrough — Sonnet/Opus only)',
    aliases: {
      'rp:best': { provider: 'anthropic', model: 'claude-opus-4-6' },
      'rp:fast': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      'rp:cheap': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      'rp:balanced': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
  };
}

/**
 * Send a telemetry event to the cloud (anonymous or authenticated).
 * Non-blocking — errors are silently swallowed.
 */
function sendCloudTelemetry(
  taskType: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  success: boolean,
  costUsd?: number,
  requestedModel?: string,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
): void {
  try {
    const cost = costUsd ?? estimateCost(model, tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens);
    // Baseline = what the same tokens would cost on Opus 4 with NO cache discount
    const baselineCost = estimateCost('claude-opus-4-6', tokensIn, tokensOut);
    const event = {
      task_type: taskType,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Math.round(latencyMs),
      success,
      cost_usd: cost,
      actual_cost_usd: cost,
      baseline_cost_usd: baselineCost,
      requested_model: requestedModel,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
    };
    // Record locally (writes to telemetry.jsonl + queues upload if telemetry_enabled)
    recordCloudTelemetry(event);
    // Check whether we should show the signup nudge.
    // Called *after* the event is written so the count includes this request.
    // Uses setImmediate to guarantee zero added latency on the response path —
    // the nudge prints to stderr only after the current I/O cycle completes.
    setImmediate(() => checkAndShowNudge());
    // Star nudge fires at 50 requests (separate from signup nudge at 100)
    setImmediate(() => checkAndShowStarNudge());
    // Lifecycle event: fire proxy.activated once on first successful request
    if (success) {
      setImmediate(() => maybeFireActivated());
    }
  } catch {
    // Telemetry should never break the proxy
  }
}

/**
 * Get all available model names for error suggestions
 */
export function getAvailableModelNames(): string[] {
  return [
    ...Object.keys(MODEL_MAPPING),
    ...Object.keys(SMART_ALIASES),
    ...Object.keys(RELAYPLANE_ALIASES),
    // Add common model prefixes users might type
    'relayplane:auto',
    'relayplane:cost',
    'relayplane:fast',
    'relayplane:quality',
  ];
}

/**
 * Resolve model aliases before routing
 * Returns the resolved model name (may be same as input if no alias found)
 */
export function resolveModelAlias(model: string): string {
  // Check RELAYPLANE_ALIASES first (e.g., relayplane:auto → rp:balanced)
  if (RELAYPLANE_ALIASES[model]) {
    return RELAYPLANE_ALIASES[model];
  }
  return model;
}

/**
 * Default routing based on task type.
 * Updated at proxy startup by provider auto-detection via detectAvailableProviders().
 */
let DEFAULT_ROUTING: Record<TaskType, { provider: Provider; model: string }> = {
  code_generation: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  code_review: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  summarization: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  analysis: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  creative_writing: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  data_extraction: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  translation: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  question_answering: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  general: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

type RoutingSuffix = 'cost' | 'fast' | 'quality';

interface ParsedModel {
  baseModel: string;
  suffix: RoutingSuffix | null;
}

interface CooldownConfig {
  enabled: boolean;
  allowedFails: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

interface ProviderHealth {
  failures: { timestamp: number; error: string }[];
  cooledUntil: number | null;
}

interface CascadeConfig {
  enabled: boolean;
  models: string[];
  escalateOn: 'uncertainty' | 'refusal' | 'error';
  maxEscalations: number;
}

interface ComplexityConfig {
  enabled: boolean;
  simple?: string | { provider: string; model: string };
  moderate?: string | { provider: string; model: string };
  complex?: string | { provider: string; model: string };
}

/**
 * Parse a complexity routing config value into a provider/model pair.
 * Accepts:
 *   - plain model name string: "claude-sonnet-4-6"
 *   - provider/model slash notation: "google/gemini-2.5-flash-lite"
 *   - openrouter prefix: "openrouter/anthropic/claude-sonnet-4-6"
 *   - object: { provider: "google", model: "gemini-2.5-flash-lite" }
 */
function parseComplexityModel(
  val: string | { provider: string; model: string }
): { provider: Provider; model: string } {
  if (typeof val === 'object' && val !== null) {
    const knownProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'deepseek', 'groq', 'local', 'ollama'];
    const p = val.provider as Provider;
    if (!knownProviders.includes(p)) {
      console.warn(`[parseComplexityModel] Unknown provider "${val.provider}" in object config, falling back to anthropic`);
      return { provider: 'anthropic' as Provider, model: val.model };
    }
    return { provider: p, model: val.model };
  }
  if (typeof val === 'string') {
    if (val.includes('/')) {
      const idx = val.indexOf('/');
      const rawProvider = val.slice(0, idx);
      const model = val.slice(idx + 1); // preserves openrouter/anthropic/claude-... style
      const knownProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'deepseek', 'groq', 'local', 'ollama'];
      if (!knownProviders.includes(rawProvider as Provider)) {
        console.warn(`[parseComplexityModel] Unknown provider "${rawProvider}" in config, falling back to anthropic`);
        return { provider: 'anthropic' as Provider, model };
      }
      const provider = rawProvider as Provider;
      return { provider, model };
    }
    // Plain model name — look up in MODEL_MAPPING, fallback to anthropic
    return MODEL_MAPPING[val] ?? { provider: 'anthropic' as Provider, model: val };
  }
  return { provider: 'anthropic' as Provider, model: 'claude-sonnet-4-6' };
}

interface ComplexityTiers {
  simple:   { provider: Provider; model: string };
  moderate: { provider: Provider; model: string };
  complex:  { provider: Provider; model: string };
}

/** Per-provider default complexity tier models */
const PROVIDER_COMPLEXITY_TIERS: Record<string, ComplexityTiers> = {
  anthropic: {
    simple:   { provider: 'anthropic', model: 'claude-haiku-4-5' },
    moderate: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    complex:  { provider: 'anthropic', model: 'claude-opus-4-6' },
  },
  openai: {
    simple:   { provider: 'openai', model: 'gpt-4.1-mini' },
    moderate: { provider: 'openai', model: 'gpt-5.4' },
    complex:  { provider: 'openai', model: 'gpt-5.4' },
  },
  google: {
    simple:   { provider: 'google', model: 'gemini-2.5-flash-lite' },
    moderate: { provider: 'google', model: 'gemini-2.5-flash' },
    complex:  { provider: 'google', model: 'gemini-2.5-pro' },
  },
  xai: {
    simple:   { provider: 'xai', model: 'grok-4.1-fast' },
    moderate: { provider: 'xai', model: 'grok-4.20-beta' },
    complex:  { provider: 'xai', model: 'grok-4' },
  },
  deepseek: {
    simple:   { provider: 'deepseek', model: 'deepseek-chat' },
    moderate: { provider: 'deepseek', model: 'deepseek-chat' },
    complex:  { provider: 'deepseek', model: 'deepseek-reasoner' },
  },
  openrouter: {
    simple:   { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
    moderate: { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    complex:  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
  },
};

/**
 * Detect which AI providers are available based on env vars and user config.
 * Returns providers in priority order: anthropic > openai > google > xai > deepseek > openrouter > groq
 */
function detectAvailableProviders(userConfig?: Record<string, unknown>): Provider[] {
  const cfg = (userConfig ?? {}) as Record<string, Record<string, string> | undefined>;
  const auth = (cfg['auth'] ?? {}) as Record<string, string>;
  const available: Provider[] = [];

  if (process.env['ANTHROPIC_API_KEY'] || auth['anthropicApiKey'] || auth['anthropicMaxToken']) {
    available.push('anthropic');
  }
  if (process.env['OPENAI_API_KEY'] || auth['openaiApiKey']) {
    available.push('openai');
  }
  if (process.env['GOOGLE_API_KEY'] || process.env['GEMINI_API_KEY'] || auth['googleApiKey']) {
    available.push('google');
  }
  if (process.env['XAI_API_KEY'] || auth['xaiApiKey']) {
    available.push('xai');
  }
  if (process.env['DEEPSEEK_API_KEY'] || auth['deepseekApiKey']) {
    available.push('deepseek');
  }
  if (process.env['OPENROUTER_API_KEY'] || auth['openrouterApiKey']) {
    available.push('openrouter');
  }
  if (process.env['GROQ_API_KEY'] || auth['groqApiKey']) {
    available.push('groq');
  }

  return available;
}

/**
 * Build default complexity tiers based on first detected provider.
 * Config overrides win — only fills in tiers not explicitly set.
 */
function buildDefaultComplexityTiers(
  providers: Provider[],
  existing?: Partial<ComplexityConfig>
): ComplexityTiers {
  // Find first provider that has a known tier mapping
  const primaryProvider = providers.find((p) => PROVIDER_COMPLEXITY_TIERS[p]) ?? 'anthropic';
  const defaults = PROVIDER_COMPLEXITY_TIERS[primaryProvider] ?? PROVIDER_COMPLEXITY_TIERS['anthropic'];

  const simple = existing?.simple != null
    ? parseComplexityModel(existing.simple)
    : defaults.simple;
  const moderate = existing?.moderate != null
    ? parseComplexityModel(existing.moderate)
    : defaults.moderate;
  const complex = existing?.complex != null
    ? parseComplexityModel(existing.complex)
    : defaults.complex;

  return { simple, moderate, complex };
}

interface RoutingConfig {
  mode: 'standard' | 'cascade' | 'auto' | 'passthrough' | 'complexity';
  cascade: CascadeConfig;
  complexity: ComplexityConfig;
}

interface ReliabilityConfig {
  cooldowns: CooldownConfig;
}

type Complexity = 'simple' | 'moderate' | 'complex';

const UNCERTAINTY_PATTERNS = [
  /i'?m not (entirely |completely |really )?sure/i,
  /i don'?t (really |actually )?know/i,
  /it'?s (difficult|hard|tough) to say/i,
  /i can'?t (definitively|accurately|confidently)/i,
  /i'?m (uncertain|unsure)/i,
  /this is (just )?(a guess|speculation)/i,
];

const REFUSAL_PATTERNS = [
  /i can'?t (help|assist) with that/i,
  /i'?m (not able|unable) to/i,
  /i (cannot|can't|won't) (provide|give|create)/i,
  /as an ai/i,
];

class CooldownManager {
  private health: Map<string, ProviderHealth> = new Map();
  private config: CooldownConfig;
  
  constructor(config: CooldownConfig) {
    this.config = config;
  }
  
  updateConfig(config: CooldownConfig): void {
    this.config = config;
  }
  
  recordFailure(provider: string, error: string): void {
    const h = this.getOrCreateHealth(provider);
    const now = Date.now();
    
    h.failures = h.failures.filter(
      (f) => now - f.timestamp < this.config.windowSeconds * 1000
    );
    
    h.failures.push({ timestamp: now, error });
    
    if (h.failures.length >= this.config.allowedFails) {
      h.cooledUntil = now + this.config.cooldownSeconds * 1000;
      console.log(
        `[RelayPlane] Provider ${provider} cooled down for ${this.config.cooldownSeconds}s`
      );
    }
  }
  
  recordSuccess(provider: string): void {
    const h = this.health.get(provider);
    if (h) {
      h.failures = [];
      h.cooledUntil = null;
    }
  }
  
  isAvailable(provider: string): boolean {
    const h = this.health.get(provider);
    if (!h?.cooledUntil) return true;
    
    if (Date.now() > h.cooledUntil) {
      h.cooledUntil = null;
      h.failures = [];
      return true;
    }
    
    return false;
  }
  
  private getOrCreateHealth(provider: string): ProviderHealth {
    if (!this.health.has(provider)) {
      this.health.set(provider, { failures: [], cooledUntil: null });
    }
    return this.health.get(provider)!;
  }
}

/**
 * Proxy server configuration
 */
export interface ProxyConfig {
  port?: number;
  host?: string;
  dbPath?: string;
  verbose?: boolean;
  /** 
   * Auth passthrough mode for Anthropic requests.
   * - 'passthrough': Forward incoming Authorization header to Anthropic (for Claude Code OAuth)
   * - 'env': Always use ANTHROPIC_API_KEY env var
   * - 'auto' (default): Use incoming auth if present, fallback to env var
   */
  anthropicAuth?: 'passthrough' | 'env' | 'auto';
}

/**
 * RelayPlane proxy config file structure.
 */
interface HybridAuthConfig {
  /** MAX subscription token for Opus models */
  anthropicMaxToken?: string;
  /** Models that should use MAX token (e.g., ["opus", "claude-opus"]) */
  useMaxForModels?: string[];
}

interface RelayPlaneProxyConfigFile {
  enabled?: boolean;
  modelOverrides?: Record<string, string>;
  mode?: string;
  strategies?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  routing?: Partial<RoutingConfig>;
  reliability?: { cooldowns?: Partial<CooldownConfig> };
  auth?: HybridAuthConfig;
  cache?: Partial<CacheConfig>;
  budget?: Partial<BudgetConfig>;
  anomaly?: Partial<AnomalyConfig>;
  alerts?: Partial<AlertsConfig>;
  downgrade?: Partial<DowngradeConfig>;
  dashboard?: { showRequestContent?: boolean };
  /**
   * Cross-provider cascade fallback (GH #38).
   * When a provider returns 429/529/503, retry with the next provider in `providers` list.
   *
   * Example:
   * ```json
   * { "crossProviderCascade": { "enabled": true, "providers": ["anthropic","openrouter","google"] } }
   * ```
   */
  crossProviderCascade?: Partial<CrossProviderCascadeConfig>;
  /**
   * Ollama local model provider configuration.
   *
   * Example:
   * ```json
   * {
   *   "ollama": {
   *     "baseUrl": "http://localhost:11434",
   *     "models": ["llama3.2", "codestral"],
   *     "routeWhen": { "complexity": ["simple"] }
   *   }
   * }
   * ```
   */
  ollama?: OllamaProviderConfig;
  /**
   * Default provider for all requests. When set, ALL models route to this provider
   * regardless of model name prefix. Useful for OpenRouter-only setups.
   *
   * Example: `"defaultProvider": "openrouter"` routes every request through OpenRouter,
   * even models like `anthropic/claude-sonnet-4-6` or `claude-sonnet-4-6`.
   */
  defaultProvider?: string;
  /**
   * Session memory configuration (Phase 2 Session 4).
   * Controls layered session memory: episodic event capture, semantic knowledge atoms,
   * and procedural pattern injection.
   */
  memory?: {
    /**
     * When true, inject top procedural knowledge hints into system prompts.
     * Default: false — no system prompt modification occurs.
     * Can also be set via env RELAYPLANE_PROCEDURAL_INJECTION=true.
     */
    proceduralInjectionEnabled?: boolean;
  };
  [key: string]: unknown;
}

/**
 * Incoming request context with headers
 */
interface RequestContext {
  /** Authorization header from incoming request */
  authHeader?: string;
  /** anthropic-beta header from incoming request */
  betaHeaders?: string;
  /** anthropic-version header from incoming request */
  versionHeader?: string;
  /** x-api-key header from incoming request */
  apiKeyHeader?: string;
  /** user-agent header from incoming request (needed for OAuth passthrough) */
  userAgent?: string;
  /** x-app header from incoming request (needed for OAuth passthrough) */
  xApp?: string;
}

/**
 * Request statistics for monitoring
 */
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalLatencyMs: number;
  routingCounts: Record<string, number>;
  modelCounts: Record<string, number>;
  escalations: number;
  startedAt: number;
}

const globalStats: RequestStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalLatencyMs: 0,
  routingCounts: {},
  modelCounts: {},
  escalations: 0,
  startedAt: Date.now(),
};

/** Rolling request history for telemetry endpoints (max 10000 entries) */
export interface RequestContentData {
  systemPrompt?: string;
  userMessage?: string;
  responsePreview?: string;
  fullResponse?: string;
}

interface RequestHistoryEntry {
  id: string;
  originalModel: string;
  targetModel: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  mode: string;
  escalated: boolean;
  timestamp: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  taskType?: string;
  complexity?: string;
  responseModel?: string;
  agentFingerprint?: string;
  agentId?: string;
  requestContent?: RequestContentData;
  error?: string;
  statusCode?: number;
}
const requestHistory: RequestHistoryEntry[] = [];
const MAX_HISTORY = 10000;
const HISTORY_RETENTION_DAYS = 7;
let requestIdCounter = 0;

// --- Persistent history (JSONL) ---
const HISTORY_DIR = path.join(os.homedir(), '.relayplane');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.jsonl');
let historyWriteBuffer: RequestHistoryEntry[] = [];
let historyFlushTimer: NodeJS.Timeout | null = null;
let historyRequestsSinceLastPrune = 0;

function pruneOldEntries(): void {
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
  // Remove old entries from in-memory array
  while (requestHistory.length > 0 && new Date(requestHistory[0]!.timestamp).getTime() < cutoff) {
    requestHistory.shift();
  }
  // Cap at MAX_HISTORY
  while (requestHistory.length > MAX_HISTORY) {
    requestHistory.shift();
  }
}

function loadHistoryFromDisk(): void {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as RequestHistoryEntry;
        if (new Date(entry.timestamp).getTime() >= cutoff) {
          requestHistory.push(entry);
        }
      } catch {
        // Skip corrupt lines
      }
    }
    // Cap at MAX_HISTORY (keep most recent)
    while (requestHistory.length > MAX_HISTORY) {
      requestHistory.shift();
    }
    // Update requestIdCounter based on loaded entries
    for (const entry of requestHistory) {
      const match = entry.id.match(/^req-(\d+)$/);
      if (match) {
        const num = parseInt(match[1]!, 10);
        if (num > requestIdCounter) requestIdCounter = num;
      }
    }
    // Rewrite file with only valid/recent entries
    rewriteHistoryFile();
    console.log(`[RelayPlane] Loaded ${requestHistory.length} history entries from disk`);
  } catch (err) {
    console.log(`[RelayPlane] Could not load history: ${(err as Error).message}`);
  }
}

function rewriteHistoryFile(): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const data = requestHistory.map(e => JSON.stringify(e)).join('\n') + (requestHistory.length ? '\n' : '');
    fs.writeFileSync(HISTORY_FILE, data, 'utf-8');
  } catch (err) {
    console.log(`[RelayPlane] Could not rewrite history file: ${(err as Error).message}`);
  }
}

function flushHistoryBuffer(): void {
  if (historyWriteBuffer.length === 0) return;
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const data = historyWriteBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(HISTORY_FILE, data, 'utf-8');
  } catch (err) {
    console.log(`[RelayPlane] Could not flush history: ${(err as Error).message}`);
  }
  historyWriteBuffer = [];
}

function scheduleHistoryFlush(): void {
  if (historyFlushTimer) return;
  historyFlushTimer = setTimeout(() => {
    historyFlushTimer = null;
    flushHistoryBuffer();
  }, 10000);
}

function bufferHistoryEntry(entry: RequestHistoryEntry): void {
  historyWriteBuffer.push(entry);
  historyRequestsSinceLastPrune++;
  if (historyWriteBuffer.length >= 20) {
    if (historyFlushTimer) { clearTimeout(historyFlushTimer); historyFlushTimer = null; }
    flushHistoryBuffer();
  } else {
    scheduleHistoryFlush();
  }
  // Prune every 100 requests
  if (historyRequestsSinceLastPrune >= 100) {
    historyRequestsSinceLastPrune = 0;
    pruneOldEntries();
    rewriteHistoryFile();
  }
}

function shutdownHistory(): void {
  if (historyFlushTimer) { clearTimeout(historyFlushTimer); historyFlushTimer = null; }
  flushHistoryBuffer();
}

function logRequest(
  originalModel: string,
  targetModel: string,
  provider: Provider,
  latencyMs: number,
  success: boolean,
  mode: string,
  escalated?: boolean,
  taskType?: string,
  complexity?: string,
  agentFingerprint?: string,
  agentId?: string,
  errorMessage?: string,
  errorStatusCode?: number,
): void {
  const timestamp = new Date().toISOString();
  const status = success ? '✓' : '✗';
  const escalateTag = escalated ? ' [ESCALATED]' : '';
  const routingTag = mode === 'passthrough'
    ? '(forwarded)'
    : `(RelayPlane routed → ${mode})`;
  console.log(
    `[RelayPlane] ${timestamp} ${status} ${originalModel} → ${provider}/${targetModel} ${routingTag} ${latencyMs}ms${escalateTag}`
  );
  
  // Update stats
  globalStats.totalRequests++;
  if (success) {
    globalStats.successfulRequests++;
  } else {
    globalStats.failedRequests++;
  }
  globalStats.totalLatencyMs += latencyMs;
  globalStats.routingCounts[mode] = (globalStats.routingCounts[mode] || 0) + 1;
  const modelKey = `${provider}/${targetModel}`;
  globalStats.modelCounts[modelKey] = (globalStats.modelCounts[modelKey] || 0) + 1;
  if (escalated) {
    globalStats.escalations++;
  }

  // Record to StatsCollector for sandbox architecture
  proxyStatsCollector.recordRequest({
    timestamp: Date.now(),
    latencyMs,
    viaProxy: true,
    success,
  });

  // Record to request history for telemetry endpoints
  const entry: RequestHistoryEntry = {
    id: `req-${++requestIdCounter}`,
    originalModel,
    targetModel,
    provider,
    latencyMs,
    success,
    mode,
    escalated: !!escalated,
    timestamp,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    taskType: taskType || 'general',
    complexity: complexity || 'simple',
    agentFingerprint,
    agentId,
    error: errorMessage,
    statusCode: errorStatusCode,
  };
  requestHistory.push(entry);
  if (requestHistory.length > MAX_HISTORY) {
    requestHistory.shift();
  }
  bufferHistoryEntry(entry);
}

/** Update the most recent history entry with token/cost info */
function updateLastHistoryEntry(tokensIn: number, tokensOut: number, costUsd: number, responseModel?: string, cacheCreationTokens?: number, cacheReadTokens?: number, agentFingerprint?: string, agentId?: string, requestContent?: RequestContentData, errorMessage?: string, errorStatusCode?: number): void {
  if (requestHistory.length > 0) {
    const last = requestHistory[requestHistory.length - 1]!;
    last.tokensIn = tokensIn;
    last.tokensOut = tokensOut;
    last.costUsd = costUsd;
    if (responseModel) {
      last.responseModel = responseModel;
    }
    if (cacheCreationTokens !== undefined) last.cacheCreationTokens = cacheCreationTokens;
    if (cacheReadTokens !== undefined) last.cacheReadTokens = cacheReadTokens;
    if (agentFingerprint !== undefined) last.agentFingerprint = agentFingerprint;
    if (agentId !== undefined) last.agentId = agentId;
    if (requestContent) last.requestContent = requestContent;
    if (errorMessage !== undefined) last.error = errorMessage;
    if (errorStatusCode !== undefined) last.statusCode = errorStatusCode;
  }
}

/**
 * Extract request content for logging. Handles Anthropic and OpenAI formats.
 */
export function extractRequestContent(
  body: Record<string, unknown>,
  isAnthropic: boolean,
): { systemPrompt?: string; userMessage?: string } {
  let systemPrompt = '';
  let userMessage = '';
  if (isAnthropic) {
    if (typeof body.system === 'string') {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = (body.system as Array<{ type?: string; text?: string }>)
        .map(p => p.type === 'text' ? (p.text ?? '') : (typeof p === 'string' ? String(p) : ''))
        .join('');
    }
  } else {
    const sysmsgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
    if (Array.isArray(sysmsgs)) {
      for (const msg of sysmsgs) {
        if (msg.role === 'system') {
          systemPrompt = typeof msg.content === 'string' ? msg.content : '';
          break;
        }
      }
    }
  }
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'user') {
        const content = msgs[i]!.content;
        if (typeof content === 'string') {
          userMessage = content;
        } else if (Array.isArray(content)) {
          userMessage = (content as Array<{ type?: string; text?: string }>)
            .filter(p => p.type === 'text')
            .map(p => p.text ?? '')
            .join('');
        }
        break;
      }
    }
  }
  return {
    systemPrompt: systemPrompt ? systemPrompt.slice(0, 200) : undefined,
    userMessage: userMessage || undefined,
  };
}

/**
 * Extract assistant response text from response payload.
 */
export function extractResponseText(responseData: Record<string, unknown>, isAnthropic: boolean): string {
  if (isAnthropic) {
    const content = responseData.content as Array<{ type?: string; text?: string }> | undefined;
    if (Array.isArray(content)) {
      return content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
    }
  } else {
    const choices = responseData.choices as Array<{ message?: { content?: string } }> | undefined;
    if (Array.isArray(choices) && choices[0]?.message?.content) {
      return choices[0].message.content;
    }
  }
  return '';
}

const DEFAULT_PROXY_CONFIG: RelayPlaneProxyConfigFile = {
  enabled: true,
  modelOverrides: {},
  routing: {
    mode: 'cascade',
    cascade: {
      enabled: true,
      models: [
        'claude-sonnet-4-6',
        'claude-opus-4-6',
      ],
      escalateOn: 'uncertainty',
      maxEscalations: 1,
    },
    complexity: {
      enabled: true,
      simple: 'claude-sonnet-4-6',
      moderate: 'claude-sonnet-4-6',
      complex: 'claude-opus-4-6',
    },
  },
  reliability: {
    cooldowns: {
      enabled: true,
      allowedFails: 3,
      windowSeconds: 60,
      cooldownSeconds: 120,
    },
  },
};

/** Module-level ref to active proxy config (set during startProxy) */
let _activeProxyConfig: RelayPlaneProxyConfigFile = {};

/** Module-level ref to active Ollama config (set during startProxy) */
let _activeOllamaConfig: OllamaProviderConfig | undefined;

function isContentLoggingEnabled(): boolean {
  return _activeProxyConfig.dashboard?.showRequestContent !== false;
}

/**
 * Whether procedural knowledge hints should be injected into system prompts.
 * Default: false — no system prompt modification occurs.
 * Config file: memory.proceduralInjectionEnabled
 * Env override: RELAYPLANE_PROCEDURAL_INJECTION=true
 */
function isProceduralInjectionEnabled(): boolean {
  const envVal = process.env['RELAYPLANE_PROCEDURAL_INJECTION'];
  if (envVal !== undefined) return envVal === 'true';
  return _activeProxyConfig.memory?.proceduralInjectionEnabled === true;
}

function getProxyConfigPath(): string {
  const customPath = process.env['RELAYPLANE_CONFIG_PATH'];
  if (customPath && customPath.trim()) return customPath;
  return path.join(os.homedir(), '.relayplane', 'config.json');
}

function normalizeProxyConfig(config: RelayPlaneProxyConfigFile | null): RelayPlaneProxyConfigFile {
  const defaultRouting = DEFAULT_PROXY_CONFIG.routing as RoutingConfig;
  const configRouting = (config?.routing ?? {}) as Partial<RoutingConfig>;
  const cascade = { ...defaultRouting.cascade, ...(configRouting.cascade ?? {}) };
  const complexity = { ...defaultRouting.complexity, ...(configRouting.complexity ?? {}) };
  const routing: RoutingConfig = {
    ...defaultRouting,
    ...configRouting,
    cascade,
    complexity,
  };
  const defaultReliability = DEFAULT_PROXY_CONFIG.reliability as ReliabilityConfig;
  const configReliability = (config?.reliability ?? {}) as { cooldowns?: Partial<CooldownConfig> };
  const cooldowns: CooldownConfig = {
    ...defaultReliability.cooldowns,
    ...(configReliability.cooldowns ?? {}),
  };
  const reliability: ReliabilityConfig = {
    ...defaultReliability,
    ...configReliability,
    cooldowns,
  };
  
  return {
    ...DEFAULT_PROXY_CONFIG,
    ...(config ?? {}),
    modelOverrides: {
      ...(DEFAULT_PROXY_CONFIG.modelOverrides ?? {}),
      ...((config?.modelOverrides as Record<string, string> | undefined) ?? {}),
    },
    routing,
    reliability,
    enabled: config?.enabled !== undefined ? !!config.enabled : DEFAULT_PROXY_CONFIG.enabled,
  };
}

async function loadProxyConfig(configPath: string, log: (msg: string) => void): Promise<RelayPlaneProxyConfigFile> {
  try {
    const raw = await fs.promises.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as RelayPlaneProxyConfigFile;
    return normalizeProxyConfig(parsed);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      log(`Failed to load config: ${error.message}`);
    }
    return normalizeProxyConfig(null);
  }
}

async function saveProxyConfig(configPath: string, config: RelayPlaneProxyConfigFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  const payload = JSON.stringify(config, null, 2);
  await fs.promises.writeFile(configPath, payload, 'utf8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeProxyConfig(
  base: RelayPlaneProxyConfigFile,
  patch: Record<string, unknown>
): RelayPlaneProxyConfigFile {
  // Deep merge without normalizing intermediate results
  const merged = deepMerge(base as Record<string, unknown>, patch) as RelayPlaneProxyConfigFile;
  return normalizeProxyConfig(merged);
}

function getHeaderValue(
  req: http.IncomingMessage,
  headerName: string
): string | undefined {
  const raw = req.headers[headerName.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseHeaderBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function parseModelSuffix(model: string): ParsedModel {
  const trimmed = model.trim();
  if (/^relayplane:(auto|cost|fast|quality)$/.test(trimmed)) {
    return { baseModel: trimmed, suffix: null };
  }
  const suffixes: RoutingSuffix[] = ['cost', 'fast', 'quality'];
  for (const suffix of suffixes) {
    if (trimmed.endsWith(`:${suffix}`)) {
      return {
        baseModel: trimmed.slice(0, -(suffix.length + 1)),
        suffix,
      };
    }
  }
  return { baseModel: trimmed, suffix: null };
}

/**
 * Request body structure
 */
interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/**
 * Extract text content from messages for routing analysis
 */
function extractPromptText(messages: ChatRequest['messages']): string {
  if (!messages || !Array.isArray(messages)) return '';
  return messages
    .map((msg) => {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((c: unknown) => {
            const part = c as { type?: string; text?: string };
            return part.type === 'text' ? (part.text ?? '') : '';
          })
          .join(' ');
      }
      return '';
    })
    .join('\n');
}

function extractMessageText(messages: Array<{ content?: unknown }>): string {
  return messages
    .map((msg) => {
      const content = msg.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((c: unknown) => {
            const part = c as { type?: string; text?: string };
            return part.type === 'text' ? (part.text ?? '') : '';
          })
          .join(' ');
      }
      return '';
    })
    .join(' ');
}

export function classifyComplexity(messages: Array<{ role?: string; content?: unknown }>): Complexity {
  // Only classify based on the last user message, not system prompts or conversation history.
  // System prompts (AGENTS.md, SOUL.md, etc.) are always huge for agent workloads and would
  // cause everything to be classified as "complex".
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUserMessage = userMessages.length > 0 ? [userMessages[userMessages.length - 1]] : messages;
  const text = extractMessageText(lastUserMessage).toLowerCase();
  const tokens = Math.ceil(text.length / 4);
  
  let score = 0;
  
  // Code indicators
  if (/```/.test(text) || /function |class |const |let |import /.test(text)) score += 2;
  // Analytical tasks
  if (/analyze|compare|evaluate|assess|review|audit/.test(text)) score += 2;
  // Math/logic
  if (/calculate|compute|solve|equation|prove|derive/.test(text)) score += 2;
  // Multi-step reasoning
  if (/first.*then|step \d|1\).*2\)|phase \d/.test(text)) score += 2;
  // Architecture/design (inherently complex)
  if (/architect|infrastructure|distributed|microservice|system design|scalab/i.test(text)) score += 3;
  // Creative/generative with substance
  if (/write a (story|essay|article|report)|create a|design a|build a/.test(text)) score += 2;
  // Implementation requests
  if (/implement|refactor|debug|optimize|migrate/.test(text)) score += 2;
  // Planning/strategy
  if (/strategy|roadmap|plan for|how (would|should|can) (we|i|you)/.test(text)) score += 1;
  // Token-based scaling (large context = likely complex)
  if (tokens > 500) score += 1;
  if (tokens > 2000) score += 2;
  if (tokens > 5000) score += 2;
  // Multiple concepts/requirements
  const andCount = (text.match(/\band\b/g) || []).length;
  if (andCount >= 3) score += 1;
  if (andCount >= 5) score += 1;

  // Calculate total tokens across ALL messages, not just last user message.
  // For agent workloads (OpenClaw, aider, Claude Code) the last user message is
  // often tiny while the real complexity lives in the 100K+ token context.
  const allText = extractMessageText(messages);
  const totalTokens = Math.ceil(allText.length / 4);
  // Context size floor — use as a hard signal regardless of last-message score
  if (totalTokens > 100000) score += 5;      // definitely complex
  else if (totalTokens > 50000) score += 3;  // likely moderate+
  else if (totalTokens > 20000) score += 2;
  // Message count signal — long conversations imply multi-step reasoning
  if (messages.length > 50) score += 2;
  else if (messages.length > 20) score += 1;

  if (score >= 4) return 'complex';
  if (score >= 2) return 'moderate';
  return 'simple';
}

export function shouldEscalate(responseText: string, trigger: CascadeConfig['escalateOn']): boolean {
  if (trigger === 'error') return false;
  const patterns = trigger === 'refusal' ? REFUSAL_PATTERNS : UNCERTAINTY_PATTERNS;
  return patterns.some((p) => p.test(responseText));
}

/**
 * Check if a model should use MAX token (hybrid auth)
 */
function shouldUseMaxToken(model: string, authConfig?: HybridAuthConfig): boolean {
  if (!authConfig?.anthropicMaxToken || !authConfig?.useMaxForModels?.length) {
    return false;
  }
  const modelLower = model.toLowerCase();
  return authConfig.useMaxForModels.some(pattern => modelLower.includes(pattern.toLowerCase()));
}

/**
 * Get the appropriate API key for a model (hybrid auth support)
 */
function getAuthForModel(
  model: string,
  authConfig?: HybridAuthConfig,
  envApiKey?: string
): { apiKey?: string; isMax: boolean } {
  if (shouldUseMaxToken(model, authConfig)) {
    return { apiKey: authConfig!.anthropicMaxToken, isMax: true };
  }
  return { apiKey: envApiKey, isMax: false };
}

/**
 * Set Anthropic auth header for a token.
 * OAT tokens (sk-ant-oat*) require Authorization: Bearer + oauth beta header.
 * Standard API keys use x-api-key.
 */
function setAnthropicAuth(headers: Record<string, string>, token: string): void {
  if (token.startsWith('sk-ant-oat')) {
    headers['Authorization'] = `Bearer ${token}`;
    const existing = headers['anthropic-beta'];
    const oauthBeta = 'oauth-2025-04-20';
    if (!existing) {
      headers['anthropic-beta'] = oauthBeta;
    } else if (!existing.includes(oauthBeta)) {
      headers['anthropic-beta'] = `${existing},${oauthBeta}`;
    }
  } else {
    headers['x-api-key'] = token;
  }
}

/**
 * Build Anthropic headers with hybrid auth support
 */
function buildAnthropicHeadersWithAuth(
  ctx: RequestContext,
  apiKey?: string,
  isMaxToken?: boolean,
  isRerouted?: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  // Auth priority: incoming auth (passthrough) > configured API key > env key
  if (ctx.authHeader) {
    const token = ctx.authHeader.replace(/^Bearer\s+/i, '');
    setAnthropicAuth(headers, token);
  } else if (ctx.apiKeyHeader) {
    setAnthropicAuth(headers, ctx.apiKeyHeader);
  } else if (apiKey) {
    setAnthropicAuth(headers, apiKey);
  }

  // Pass through beta headers
  if (ctx.betaHeaders) {
    const existing = headers['anthropic-beta'];
    if (!existing) {
      headers['anthropic-beta'] = ctx.betaHeaders;
    } else if (!existing.includes(ctx.betaHeaders)) {
      headers['anthropic-beta'] = `${existing},${ctx.betaHeaders}`;
    }
  }

  // Strip beta flags unsupported by OAT tokens
  if (headers['anthropic-beta']) {
    const token = ctx.authHeader?.replace(/^Bearer\s+/i, '') ?? ctx.apiKeyHeader ?? apiKey ?? '';
    if (token.startsWith('sk-ant-oat')) {
      const cleaned = headers['anthropic-beta']
        .split(',')
        .map(b => b.trim())
        .filter(b => !OAT_UNSUPPORTED_BETA_FLAGS.has(b))
        .join(',');
      if (cleaned) {
        headers['anthropic-beta'] = cleaned;
      } else {
        delete headers['anthropic-beta'];
      }
    }
  }

  // Pass through OAuth identity headers (required by Anthropic for OAuth token validation)
  if (ctx.userAgent) {
    headers['user-agent'] = ctx.userAgent;
  }
  if (ctx.xApp) {
    headers['x-app'] = ctx.xApp;
  }

  return headers;
}

/**
 * Build Anthropic headers with auth passthrough support
 */
function buildAnthropicHeaders(
  ctx: RequestContext,
  envApiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  // Auth priority: incoming auth > x-api-key header > env key
  if (ctx.authHeader) {
    const token = ctx.authHeader.replace(/^Bearer\s+/i, '');
    setAnthropicAuth(headers, token);
  } else if (ctx.apiKeyHeader) {
    setAnthropicAuth(headers, ctx.apiKeyHeader);
  } else if (envApiKey) {
    setAnthropicAuth(headers, envApiKey);
  }

  // Pass through beta headers
  if (ctx.betaHeaders) {
    const existing = headers['anthropic-beta'];
    if (!existing) {
      headers['anthropic-beta'] = ctx.betaHeaders;
    } else if (!existing.includes(ctx.betaHeaders)) {
      headers['anthropic-beta'] = `${existing},${ctx.betaHeaders}`;
    }
  }

  // Strip beta flags unsupported by OAT tokens
  if (headers['anthropic-beta']) {
    const token = ctx.authHeader?.replace(/^Bearer\s+/i, '') ?? ctx.apiKeyHeader ?? envApiKey ?? '';
    if (token.startsWith('sk-ant-oat')) {
      const cleaned = headers['anthropic-beta']
        .split(',')
        .map(b => b.trim())
        .filter(b => !OAT_UNSUPPORTED_BETA_FLAGS.has(b))
        .join(',');
      if (cleaned) {
        headers['anthropic-beta'] = cleaned;
      } else {
        delete headers['anthropic-beta'];
      }
    }
  }

  // Pass through OAuth identity headers (required by Anthropic for OAuth token validation)
  if (ctx.userAgent) {
    headers['user-agent'] = ctx.userAgent;
  }
  if (ctx.xApp) {
    headers['x-app'] = ctx.xApp;
  }

  return headers;
}

/**
 * Forward non-streaming request to Anthropic API
 */
async function forwardToAnthropic(
  request: ChatRequest,
  targetModel: string,
  ctx: RequestContext,
  envApiKey?: string
): Promise<Response> {
  const anthropicBody = buildAnthropicBody(request, targetModel, false);
  const headers = buildAnthropicHeaders(ctx, envApiKey);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
  });

  return response;
}

/**
 * Forward streaming request to Anthropic API
 */
async function forwardToAnthropicStream(
  request: ChatRequest,
  targetModel: string,
  ctx: RequestContext,
  envApiKey?: string
): Promise<Response> {
  const anthropicBody = buildAnthropicBody(request, targetModel, true);
  const headers = buildAnthropicHeaders(ctx, envApiKey);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
  });

  return response;
}

/**
 * Forward native Anthropic /v1/messages request (passthrough with routing)
 * Used for Claude Code direct integration
 */
async function forwardNativeAnthropicRequest(
  body: Record<string, unknown>,
  ctx: RequestContext,
  envApiKey?: string,
  isMaxToken?: boolean,
  isRerouted?: boolean
): Promise<Response> {
  const headers = buildAnthropicHeadersWithAuth(ctx, envApiKey, isMaxToken, isRerouted);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  return response;
}

/**
 * OpenAI message structure for type safety
 */
interface OpenAIMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Convert OpenAI messages array to Anthropic format
 * Handles: user, assistant, tool_calls, tool results
 */
function convertMessagesToAnthropic(messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    const m = msg as OpenAIMessage;

    // Skip system messages (handled separately)
    if (m.role === 'system') continue;

    // Tool result message → Anthropic user message with tool_result content
    if (m.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }

    // Assistant message with tool_calls → Anthropic assistant with tool_use content
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const content: unknown[] = [];

      // Add text content if present
      if (m.content && typeof m.content === 'string') {
        content.push({ type: 'text', text: m.content });
      }

      // Add tool_use blocks
      for (const tc of m.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }

      result.push({ role: 'assistant', content });
      continue;
    }

    // Regular user/assistant message
    result.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  return result;
}

/**
 * Build Anthropic request body from OpenAI format
 */
function buildAnthropicBody(
  request: ChatRequest,
  targetModel: string,
  stream: boolean
): Record<string, unknown> {
  // Convert OpenAI messages to Anthropic format
  const anthropicMessages = convertMessagesToAnthropic(request.messages);

  const systemMessage = request.messages.find((m) => m.role === 'system');

  const anthropicBody: Record<string, unknown> = {
    model: targetModel,
    messages: anthropicMessages,
    max_tokens: request.max_tokens ?? 4096,
    stream,
  };

  if (systemMessage) {
    anthropicBody['system'] = systemMessage.content;
  }

  if (request.temperature !== undefined) {
    anthropicBody['temperature'] = request.temperature;
  }

  // Convert OpenAI tools format to Anthropic tools format
  if (request.tools && Array.isArray(request.tools)) {
    anthropicBody['tools'] = convertToolsToAnthropic(request.tools);
  }

  // Convert tool_choice
  if (request.tool_choice) {
    anthropicBody['tool_choice'] = convertToolChoiceToAnthropic(request.tool_choice);
  }

  return anthropicBody;
}

/**
 * Convert OpenAI tools format to Anthropic format
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolsToAnthropic(tools: unknown[]): unknown[] {
  return tools.map((tool: unknown) => {
    const t = tool as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } };
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      };
    }
    // Already in Anthropic format or unknown
    return tool;
  });
}

/**
 * Convert OpenAI tool_choice to Anthropic format
 */
function convertToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  
  // Specific tool: { type: "function", function: { name: "xxx" } }
  const tc = toolChoice as { type?: string; function?: { name?: string } };
  if (tc.type === 'function' && tc.function?.name) {
    return { type: 'tool', name: tc.function.name };
  }
  
  return toolChoice;
}

/**
 * Forward non-streaming request to OpenAI API
 */
async function forwardToOpenAI(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const openaiBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  return response;
}

/**
 * Forward streaming request to OpenAI API
 */
async function forwardToOpenAIStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const openaiBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  return response;
}

/**
 * Forward non-streaming request to xAI API (OpenAI-compatible)
 */
async function forwardToXAI(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const xaiBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(xaiBody),
  });

  return response;
}

/**
 * Forward streaming request to xAI API (OpenAI-compatible)
 */
async function forwardToXAIStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const xaiBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(xaiBody),
  });

  return response;
}

/**
 * Forward non-streaming request to OpenAI-compatible provider (OpenRouter, DeepSeek, Groq)
 */
async function forwardToOpenAICompatible(
  request: ChatRequest,
  targetModel: string,
  apiKey: string,
  provider: string = 'openrouter'
): Promise<Response> {
  const compatBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch(`${DEFAULT_ENDPOINTS[provider]?.baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(compatBody),
  });

  return response;
}

/**
 * Forward streaming request to OpenAI-compatible provider (OpenRouter, DeepSeek, Groq)
 */
async function forwardToOpenAICompatibleStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string,
  provider: string = 'openrouter'
): Promise<Response> {
  const compatBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch(`${DEFAULT_ENDPOINTS[provider]?.baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(compatBody),
  });

  return response;
}

/**
 * Convert OpenAI messages to Gemini format
 */
function convertMessagesToGemini(messages: ChatRequest['messages']): unknown[] {
  const geminiContents: unknown[] = [];
  
  for (const msg of messages) {
    // Skip system messages (handled separately via systemInstruction)
    if (msg.role === 'system') continue;
    
    const role = msg.role === 'assistant' ? 'model' : 'user';
    
    if (typeof msg.content === 'string') {
      geminiContents.push({
        role,
        parts: [{ text: msg.content }],
      });
    } else if (Array.isArray(msg.content)) {
      // Handle multimodal content
      const parts = msg.content.map((part: unknown) => {
        const p = part as { type?: string; text?: string; image_url?: { url?: string } };
        if (p.type === 'text') {
          return { text: p.text };
        }
        if (p.type === 'image_url' && p.image_url?.url) {
          // Handle base64 images
          const url = p.image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                inline_data: {
                  mime_type: match[1],
                  data: match[2],
                },
              };
            }
          }
          // URL-based images not directly supported, return as text
          return { text: `[Image: ${url}]` };
        }
        return { text: '' };
      });
      geminiContents.push({ role, parts });
    }
  }
  
  return geminiContents;
}

/**
 * Recursively strip JSON Schema properties that Gemini rejects but OpenAI/Anthropic accept.
 * Gemini rejects: patternProperties, additionalProperties (boolean), $schema, definitions, $defs, unevaluatedProperties
 */
function sanitizeSchemaForGemini(schema: unknown, _depth = 0, _nodeCount = { count: 0 }): unknown {
  // Guard against deeply nested or extremely wide schemas (DoS prevention)
  if (_depth > 20) return schema;
  _nodeCount.count++;
  if (_nodeCount.count > 10000) return schema;

  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeSchemaForGemini(item, _depth + 1, _nodeCount));
  }
  if (schema !== null && typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Strip fields Gemini doesn't support
      if (key === 'patternProperties') continue;
      if (key === '$schema') continue;
      if (key === 'definitions') continue;
      if (key === '$defs') continue;
      if (key === 'unevaluatedProperties') continue;
      // additionalProperties: Gemini only accepts object form, not boolean
      if (key === 'additionalProperties' && typeof value === 'boolean') continue;
      result[key] = sanitizeSchemaForGemini(value, _depth + 1, _nodeCount);
    }
    return result;
  }
  return schema;
}

/**
 * Forward non-streaming request to Gemini API
 */
async function forwardToGemini(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const geminiContents = convertMessagesToGemini(request.messages);
  
  const geminiBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      maxOutputTokens: request.max_tokens ?? 4096,
    },
  };
  
  if (request.temperature !== undefined) {
    (geminiBody['generationConfig'] as Record<string, unknown>)['temperature'] = request.temperature;
  }
  
  if (systemMessage && typeof systemMessage.content === 'string') {
    geminiBody['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
    };
  }

  if (request.tools && request.tools.length > 0) {
    geminiBody["tools"] = [{
      functionDeclarations: request.tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: sanitizeSchemaForGemini(t.function.parameters || {})
      }))
    }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    }
  );

  return response;
}

/**
 * Forward streaming request to Gemini API
 */
async function forwardToGeminiStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const geminiContents = convertMessagesToGemini(request.messages);
  
  const geminiBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      maxOutputTokens: request.max_tokens ?? 4096,
    },
  };
  
  if (request.temperature !== undefined) {
    (geminiBody['generationConfig'] as Record<string, unknown>)['temperature'] = request.temperature;
  }
  
  if (systemMessage && typeof systemMessage.content === 'string') {
    geminiBody['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
    };
  }

  if (request.tools && request.tools.length > 0) {
    geminiBody["tools"] = [{
      functionDeclarations: request.tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: sanitizeSchemaForGemini(t.function.parameters || {})
      }))
    }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    }
  );

  return response;
}

/**
 * Gemini API response structure
 */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Convert Gemini response to OpenAI format
 */
function convertGeminiResponse(geminiData: GeminiResponse, model: string): Record<string, unknown> {
  const candidate = geminiData.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  const functionCalls = parts.filter((p) => p.functionCall);
  
  let finishReason = 'stop';
  if (functionCalls.length > 0) {
    finishReason = 'tool_calls';
  } else if (candidate?.finishReason === 'MAX_TOKENS') {
    finishReason = 'length';
  } else if (candidate?.finishReason === 'SAFETY') {
    finishReason = 'content_filter';
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (functionCalls.length > 0) {
    message['tool_calls'] = functionCalls.map((p, i) => ({
      id: `call_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: p.functionCall!.name,
        arguments: JSON.stringify(p.functionCall!.args || {})
      }
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: geminiData.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: geminiData.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens:
        (geminiData.usageMetadata?.promptTokenCount ?? 0) +
        (geminiData.usageMetadata?.candidatesTokenCount ?? 0),
    },
  };
}

/**
 * Convert Gemini streaming event to OpenAI format
 */
function convertGeminiStreamEvent(
  eventData: GeminiResponse,
  messageId: string,
  model: string,
  isFirst: boolean
): string | null {
  const candidate = eventData.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  const functionCalls = parts.filter((p) => p.functionCall);
  
  const choice: Record<string, unknown> = {
    index: 0,
    delta: {},
    finish_reason: null,
  };
  
  const delta: Record<string, unknown> = {};
  if (isFirst) {
    delta['role'] = 'assistant';
  }
  if (text) {
    delta['content'] = text;
  }
  if (functionCalls.length > 0) {
    delta['tool_calls'] = functionCalls.map((p, i) => ({
      index: i,
      id: `call_${messageId}_${i}`,
      type: 'function',
      function: {
        name: p.functionCall!.name,
        arguments: JSON.stringify(p.functionCall!.args || {})
      }
    }));
    choice['finish_reason'] = 'tool_calls';
  }
  choice['delta'] = delta;
  
  // Check for finish
  if (candidate?.finishReason && choice['finish_reason'] === null) {
    let finishReason = 'stop';
    if (candidate.finishReason === 'MAX_TOKENS') {
      finishReason = 'length';
    } else if (candidate.finishReason === 'SAFETY') {
      finishReason = 'content_filter';
    }
    choice['finish_reason'] = finishReason;
  }
  
  const chunk = {
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
  };
  
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Parse Gemini SSE stream and convert to OpenAI format
 */
async function* convertGeminiStream(
  response: Response,
  model: string
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const messageId = `chatcmpl-${Date.now()}`;
  let isFirst = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (Gemini uses "data: " prefix)
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr.trim() === '[DONE]') {
            yield 'data: [DONE]\n\n';
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr) as GeminiResponse;
            const converted = convertGeminiStreamEvent(parsed, messageId, model, isFirst);
            if (converted) {
              yield converted;
              isFirst = false;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
    
    // Send [DONE] at the end
    yield 'data: [DONE]\n\n';
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic API response structure
 */
interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/**
 * Convert Anthropic response to OpenAI format
 * Handles both text and tool_use content blocks
 */
function convertAnthropicResponse(anthropicData: AnthropicResponse): Record<string, unknown> {
  const textBlocks = anthropicData.content?.filter((c) => c.type === 'text') ?? [];
  const toolBlocks = anthropicData.content?.filter((c) => c.type === 'tool_use') ?? [];

  const textContent = textBlocks.map((c) => c.text ?? '').join('');

  // Build message object
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent || null,
  };

  // Convert tool_use blocks to OpenAI tool_calls format
  if (toolBlocks.length > 0) {
    message['tool_calls'] = toolBlocks.map((block) => ({
      id: block.id || `call_${Date.now()}`,
      type: 'function',
      function: {
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      },
    }));
  }

  // Determine finish_reason
  let finishReason = 'stop';
  if (anthropicData.stop_reason === 'tool_use') {
    finishReason = 'tool_calls';
  } else if (anthropicData.stop_reason === 'end_turn') {
    finishReason = 'stop';
  } else if (anthropicData.stop_reason) {
    finishReason = anthropicData.stop_reason;
  }

  return {
    id: anthropicData.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicData.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: anthropicData.usage?.input_tokens ?? 0,
      completion_tokens: anthropicData.usage?.output_tokens ?? 0,
      total_tokens: (anthropicData.usage?.input_tokens ?? 0) + (anthropicData.usage?.output_tokens ?? 0),
    },
  };
}

/**
 * Streaming state for tracking tool calls across events
 */
interface StreamingToolState {
  currentToolIndex: number;
  tools: Map<number, { id: string; name: string; arguments: string }>;
}

/**
 * Convert Anthropic streaming event to OpenAI streaming chunk format
 * Handles both text content and tool_use streaming
 */
function convertAnthropicStreamEvent(
  eventType: string,
  eventData: Record<string, unknown>,
  messageId: string,
  model: string,
  toolState: StreamingToolState
): string | null {
  const choice = { index: 0, delta: {} as Record<string, unknown>, finish_reason: null as string | null };
  const baseChunk = {
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [choice],
  };

  switch (eventType) {
    case 'message_start': {
      // First chunk: include role and input token usage
      const msg = eventData['message'] as Record<string, unknown> | undefined;
      baseChunk.id = (msg?.['id'] as string) || messageId;
      choice.delta = { role: 'assistant', content: '' };
      // Pass through input token count from message_start (including cache tokens)
      const msgUsage = msg?.['usage'] as Record<string, unknown> | undefined;
      if (msgUsage) {
        (baseChunk as Record<string, unknown>)['usage'] = {
          prompt_tokens: msgUsage['input_tokens'] ?? 0,
          cache_creation_tokens: msgUsage['cache_creation_input_tokens'] ?? 0,
          cache_read_tokens: msgUsage['cache_read_input_tokens'] ?? 0,
        };
      }
      return `data: ${JSON.stringify(baseChunk)}\n\n`;
    }

    case 'content_block_start': {
      // New content block starting - could be text or tool_use
      const contentBlock = eventData['content_block'] as Record<string, unknown> | undefined;
      const blockIndex = eventData['index'] as number | undefined;
      
      if (contentBlock?.['type'] === 'tool_use') {
        // Tool use starting - send first chunk with tool info
        const toolId = contentBlock['id'] as string;
        const toolName = contentBlock['name'] as string;
        
        toolState.tools.set(blockIndex ?? toolState.currentToolIndex, {
          id: toolId,
          name: toolName,
          arguments: '',
        });
        toolState.currentToolIndex = blockIndex ?? toolState.currentToolIndex;
        
        choice.delta = {
          tool_calls: [{
            index: blockIndex ?? 0,
            id: toolId,
            type: 'function',
            function: { name: toolName, arguments: '' },
          }],
        };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      return null;
    }

    case 'content_block_delta': {
      // Content chunk - text or tool arguments
      const delta = eventData['delta'] as Record<string, unknown> | undefined;
      const blockIndex = eventData['index'] as number | undefined;
      
      if (delta?.['type'] === 'text_delta') {
        choice.delta = { content: delta['text'] as string };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      
      if (delta?.['type'] === 'input_json_delta') {
        // Tool arguments streaming
        const partialJson = delta['partial_json'] as string || '';
        const tool = toolState.tools.get(blockIndex ?? toolState.currentToolIndex);
        if (tool) {
          tool.arguments += partialJson;
        }
        
        choice.delta = {
          tool_calls: [{
            index: blockIndex ?? 0,
            function: { arguments: partialJson },
          }],
        };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      return null;
    }

    case 'message_delta': {
      // Final chunk with stop reason and usage
      const delta = eventData['delta'] as Record<string, unknown> | undefined;
      const stopReason = delta?.['stop_reason'] as string | undefined;
      const usage = eventData['usage'] as Record<string, unknown> | undefined;
      
      if (stopReason === 'tool_use') {
        choice.finish_reason = 'tool_calls';
      } else if (stopReason === 'end_turn') {
        choice.finish_reason = 'stop';
      } else {
        choice.finish_reason = stopReason || 'stop';
      }
      choice.delta = {};
      // Pass through usage data (output_tokens from message_delta)
      if (usage) {
        (baseChunk as Record<string, unknown>)['usage'] = {
          completion_tokens: usage['output_tokens'] ?? 0,
        };
      }
      return `data: ${JSON.stringify(baseChunk)}\n\n`;
    }

    case 'message_stop': {
      // Stream complete
      return 'data: [DONE]\n\n';
    }

    default:
      return null;
  }
}

/**
 * Parse SSE stream from Anthropic and convert to OpenAI format
 */
async function* convertAnthropicStream(
  response: Response,
  model: string
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let messageId = `chatcmpl-${Date.now()}`;
  
  // Tool state for tracking streaming tool calls
  const toolState: StreamingToolState = {
    currentToolIndex: 0,
    tools: new Map(),
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6);
        } else if (line === '' && eventType && eventData) {
          // Complete event, process it
          try {
            const parsed = JSON.parse(eventData) as Record<string, unknown>;
            const converted = convertAnthropicStreamEvent(eventType, parsed, messageId, model, toolState);
            if (converted) {
              yield converted;
            }
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
          eventData = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pipe OpenAI streaming response directly (already in correct format)
 */
async function* pipeOpenAIStream(
  response: Response
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse preferred model string (format: "provider:model")
 */
function parsePreferredModel(
  preferredModel: string
): { provider: Provider; model: string } | null {
  const [provider, model] = preferredModel.split(':');
  if (!provider || !model) return null;

  // Validate provider
  const validProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'deepseek', 'groq', 'local'];
  if (!validProviders.includes(provider as Provider)) return null;

  return { provider: provider as Provider, model };
}

/**
 * Resolve explicit model name to provider and model.
/**
 * Add provider prefix to bare model names for aggregator routing (e.g., OpenRouter).
 * Complexity routing produces bare names like 'claude-sonnet-4-6' — aggregators need
 * the full 'anthropic/claude-sonnet-4-6' format to identify the upstream provider.
 * If the model already has a prefix (contains '/'), it's returned unchanged.
 */
function addProviderPrefix(model: string, detectedProvider: string): string {
  // Already has a prefix (e.g., 'anthropic/claude-sonnet-4-6')
  if (model.includes('/')) return model;

  // Map detected provider to OpenRouter-style prefix
  const prefixMap: Record<string, string> = {
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google',
    deepseek: 'deepseek',
    mistral: 'mistralai',
    together: 'together',
    groq: 'groq',
  };

  const prefix = prefixMap[detectedProvider];
  if (prefix) return `${prefix}/${model}`;

  // Fallback: infer from model name patterns
  if (model.startsWith('claude') || model.startsWith('claude-')) return `anthropic/${model}`;
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return `openai/${model}`;
  if (model.startsWith('gemini')) return `google/${model}`;

  return model;
}

/**
 * When `defaultProvider` is set, ALL models are routed to that provider
 * regardless of model name prefix — the model name is preserved as-is
 * so OpenRouter receives the full `anthropic/claude-sonnet-4-6` format.
 */
export function resolveExplicitModel(
  modelName: string,
  defaultProvider?: string
): { provider: Provider; model: string } | null {
  if (defaultProvider) {
    return { provider: defaultProvider as Provider, model: modelName };
  }

  // Resolve aliases first (e.g., relayplane:auto → rp:balanced)
  const resolvedAlias = resolveModelAlias(modelName);

  // Check SMART_ALIASES (rp:best, rp:fast, etc.)
  if (SMART_ALIASES[resolvedAlias]) {
    return SMART_ALIASES[resolvedAlias];
  }

  // Check MODEL_MAPPING (aliases)
  if (MODEL_MAPPING[resolvedAlias]) {
    return MODEL_MAPPING[resolvedAlias];
  }

  // If alias was resolved but not in mappings, try original name
  if (resolvedAlias !== modelName && MODEL_MAPPING[modelName]) {
    return MODEL_MAPPING[modelName];
  }

  // Anthropic models (claude-*)
  if (modelName.startsWith('claude-')) {
    return { provider: 'anthropic', model: modelName };
  }

  // OpenAI models (gpt-*, o1-*, chatgpt-*, text-*, dall-e-*, whisper-*, tts-*)
  if (
    modelName.startsWith('gpt-') ||
    modelName.startsWith('o1-') ||
    modelName.startsWith('o3-') ||
    modelName.startsWith('chatgpt-') ||
    modelName.startsWith('text-') ||
    modelName.startsWith('dall-e') ||
    modelName.startsWith('whisper') ||
    modelName.startsWith('tts-')
  ) {
    return { provider: 'openai', model: modelName };
  }

  // Google models (gemini-*, palm-*)
  if (modelName.startsWith('gemini-') || modelName.startsWith('palm-')) {
    return { provider: 'google', model: modelName };
  }

  // xAI models (grok-*)
  if (modelName.startsWith('grok-')) {
    return { provider: 'xai', model: modelName };
  }

  // OpenRouter/DeepSeek/Groq models
  if (modelName.startsWith('openrouter/')) {
    // Strip the "openrouter/" prefix — OpenRouter expects just "google/gemini-2.5-pro" not "openrouter/google/gemini-2.5-pro"
    return { provider: 'openrouter', model: modelName.slice('openrouter/'.length) };
  }
  if (modelName.startsWith('deepseek-') || modelName.startsWith('groq-')) {
    return { provider: 'openrouter', model: modelName };
  }

  // Ollama models: "ollama/llama3.2" or direct model names when Ollama config exists
  if (modelName.startsWith('ollama/')) {
    return { provider: 'ollama', model: modelName.slice('ollama/'.length) };
  }

  // Provider-prefixed format: "anthropic/claude-3-5-sonnet-latest"
  if (modelName.includes('/')) {
    const [provider, model] = modelName.split('/');
    const validProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'deepseek', 'groq', 'local', 'ollama'];
    if (provider && model && validProviders.includes(provider as Provider)) {
      return { provider: provider as Provider, model };
    }
  }

  return null;
}

function resolveConfigModel(modelName: string, defaultProvider?: string): { provider: Provider; model: string } | null {
  if (defaultProvider) {
    return { provider: defaultProvider as Provider, model: modelName };
  }
  return resolveExplicitModel(modelName) ?? parsePreferredModel(modelName);
}

function extractResponseTextAuto(responseData: Record<string, unknown>): string {
  const openAiChoices = responseData['choices'] as Array<Record<string, unknown>> | undefined;
  if (openAiChoices && openAiChoices.length > 0) {
    const first = openAiChoices[0] as { message?: { content?: string | null } };
    const content = first?.message?.content;
    return typeof content === 'string' ? content : '';
  }
  
  const anthropicContent = responseData['content'] as Array<{ type?: string; text?: string }> | undefined;
  if (anthropicContent) {
    return anthropicContent
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }
  
  const geminiCandidates = responseData['candidates'] as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  if (geminiCandidates) {
    const text = geminiCandidates[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text;
  }
  
  return '';
}

/**
 * Build x-relayplane-* response headers for routing transparency
 */
function buildRelayPlaneResponseHeaders(
  routedModel: string,
  requestedModel: string,
  complexity: string,
  provider: string,
  routingMode: string
): Record<string, string> {
  return {
    'x-relayplane-routed-model': routedModel,
    'x-relayplane-requested-model': requestedModel,
    'x-relayplane-complexity': complexity,
    'x-relayplane-provider': provider,
    'x-relayplane-routing-mode': routingMode,
  };
}

/**
 * Check if the upstream response body contains a model field that differs from what we requested.
 * Logs a warning if a mismatch is detected.
 */
function checkResponseModelMismatch(
  responseData: Record<string, unknown>,
  requestedModel: string,
  provider: string,
  log: (msg: string) => void
): string | undefined {
  const responseModel = responseData['model'] as string | undefined;
  if (responseModel && responseModel !== requestedModel) {
    log(`[RelayPlane] ⚠️ Model mismatch: requested "${requestedModel}" from ${provider}, but response contains model "${responseModel}"`);
  }
  return responseModel;
}

/**
 * Extract a human-readable error message from a provider error payload.
 * Handles Anthropic ({ error: { type, message } }) and OpenAI ({ error: { message } }) formats.
 */
/**
 * Convert a native Anthropic messages request body into the OpenAI-compatible
 * ChatRequest format used by forwardToOpenAICompatible and related helpers.
 *
 * This allows cross-provider cascade from Anthropic → OpenRouter (and others)
 * without losing the original request content. (GH #38)
 */
function convertNativeAnthropicBodyToChatRequest(
  body: Record<string, unknown>,
  mappedModel: string
): ChatRequest {
  const rawMessages = Array.isArray(body['messages'])
    ? (body['messages'] as Array<Record<string, unknown>>)
    : [];

  const messages: ChatRequest['messages'] = [];

  // Prepend system message if present
  if (body['system'] && typeof body['system'] === 'string') {
    messages.push({ role: 'system', content: body['system'] });
  } else if (Array.isArray(body['system'])) {
    // Anthropic structured system (array of {type, text}) — flatten to text
    const systemText = (body['system'] as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  for (const msg of rawMessages) {
    const role = msg['role'] as string;
    const content = msg['content'];

    if (typeof content === 'string') {
      messages.push({ role: role as 'user' | 'assistant', content });
    } else if (Array.isArray(content)) {
      // Anthropic content blocks — extract text parts
      const text = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      messages.push({ role: role as 'user' | 'assistant', content: text });
    } else {
      messages.push({ role: role as 'user' | 'assistant', content: String(content ?? '') });
    }
  }

  return {
    model: mappedModel,
    messages,
    max_tokens: (body['max_tokens'] as number | undefined) ?? 4096,
    temperature: body['temperature'] as number | undefined,
    stream: false,
  };
}

function extractProviderErrorMessage(payload: Record<string, unknown>, statusCode?: number): string {
  const err = payload['error'] as Record<string, unknown> | string | undefined;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const errType = err['type'] as string | undefined;
    const errMsg = err['message'] as string | undefined;
    if (errType && errMsg) return `${errType}: ${errMsg}`;
    if (errMsg) return errMsg;
    if (errType) return errType;
  }
  if (statusCode) return `HTTP ${statusCode}`;
  return 'Unknown error';
}

class ProviderResponseError extends Error {
  status: number;
  payload: Record<string, unknown>;
  
  constructor(status: number, payload: Record<string, unknown>) {
    super(`Provider response error: ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

class CooldownError extends Error {
  provider: Provider;
  
  constructor(provider: Provider) {
    super(`Provider ${provider} is in cooldown`);
    this.provider = provider;
  }
}

/**
 * Extract request context (auth headers) from incoming HTTP request
 */
function extractRequestContext(req: http.IncomingMessage): RequestContext {
  return {
    authHeader: req.headers['authorization'] as string | undefined,
    betaHeaders: req.headers['anthropic-beta'] as string | undefined,
    versionHeader: req.headers['anthropic-version'] as string | undefined,
    apiKeyHeader: req.headers['x-api-key'] as string | undefined,
    userAgent: req.headers['user-agent'] as string | undefined,
    xApp: req.headers['x-app'] as string | undefined,
  };
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB max request body

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error('Request body too large (max 10MB)');
    }
    body += chunk;
  }
  return body;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRequestBody(req);
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Check if we have valid Anthropic auth (either passthrough or env)
 */
function hasAnthropicAuth(ctx: RequestContext, envApiKey?: string): boolean {
  return !!(ctx.authHeader || ctx.apiKeyHeader || envApiKey);
}

function resolveProviderApiKey(
  provider: Provider,
  ctx: RequestContext,
  envApiKey?: string
): { apiKey?: string; error?: { status: number; payload: Record<string, unknown> } } {
  if (provider === 'anthropic') {
    if (!hasAnthropicAuth(ctx, envApiKey)) {
      return {
        error: {
          status: 401,
          payload: {
            error: 'Missing Anthropic authentication. Provide Authorization header or set ANTHROPIC_API_KEY.',
            hint: 'For Claude Code: auth is passed through automatically. For API: set ANTHROPIC_API_KEY env var.',
          },
        },
      };
    }
    // Prefer env key when available; fall back to incoming auth (x-api-key or Authorization header).
    // This handles local proxy setups where ANTHROPIC_API_KEY is not set but the caller
    // forwards their token via x-api-key (e.g. OpenClaw relayplane provider).
    if (envApiKey) return { apiKey: envApiKey };
    if (ctx.apiKeyHeader) return { apiKey: ctx.apiKeyHeader };
    if (ctx.authHeader) {
      const token = ctx.authHeader.replace(/^Bearer\s+/i, '');
      return { apiKey: token };
    }
    return { apiKey: undefined };
  }

  // Ollama doesn't need an API key — it's local
  if (provider === 'ollama') {
    return { apiKey: 'ollama-local' };
  }

  const apiKeyEnv = DEFAULT_ENDPOINTS[provider]?.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`;
  const apiKey = process.env[apiKeyEnv];
  if (apiKey) {
    return { apiKey };
  }

  // Auth passthrough: use incoming Authorization: Bearer token when no env key is configured.
  // This supports defaultProvider scenarios where the caller passes the API key in the request
  // (e.g., OpenRouter users who pass their key via Authorization header).
  if (ctx.authHeader) {
    const bearerMatch = ctx.authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      return { apiKey: bearerMatch[1] };
    }
  }

  return {
    error: {
      status: 500,
      payload: {
        error: `Missing ${apiKeyEnv} environment variable`,
        hint: `Cross-provider routing requires API keys for each provider. Set ${apiKeyEnv} to enable ${provider} models.`,
      },
    },
  };
}

function getCascadeModels(config: RelayPlaneProxyConfigFile): string[] {
  return config.routing?.cascade?.models ?? [];
}

function getCascadeConfig(config: RelayPlaneProxyConfigFile): CascadeConfig {
  const c = config.routing?.cascade;
  return {
    enabled: c?.enabled ?? true,
    models: c?.models ?? ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
    escalateOn: c?.escalateOn ?? 'uncertainty',
    maxEscalations: c?.maxEscalations ?? 1,
  };
}

function getCooldownConfig(config: RelayPlaneProxyConfigFile): CooldownConfig {
  const defaults: CooldownConfig = {
    enabled: true,
    allowedFails: 3,
    windowSeconds: 60,
    cooldownSeconds: 120,
  };
  return { ...defaults, ...config.reliability?.cooldowns };
}

function complexityValToString(val: string | { provider: string; model: string } | undefined): string | undefined {
  if (val == null) return undefined;
  if (typeof val === 'string') return val;
  return `${val.provider}/${val.model}`;
}

function getCostModel(config: RelayPlaneProxyConfigFile): string {
  return (
    complexityValToString(config.routing?.complexity?.simple) ||
    config.routing?.cascade?.models?.[0] ||
    'claude-haiku-4-5'
  );
}

function getFastModel(config: RelayPlaneProxyConfigFile): string {
  return (
    complexityValToString(config.routing?.complexity?.simple) ||
    config.routing?.cascade?.models?.[0] ||
    'claude-haiku-4-5'
  );
}

function getQualityModel(config: RelayPlaneProxyConfigFile): string {
  return (
    complexityValToString(config.routing?.complexity?.complex) ||
    config.routing?.cascade?.models?.[config.routing?.cascade?.models?.length ? config.routing.cascade.models.length - 1 : 0] ||
    process.env['RELAYPLANE_QUALITY_MODEL'] ||
    'claude-sonnet-4-6'
  );
}

async function cascadeRequest(
  config: CascadeConfig,
  makeRequest: (model: string) => Promise<{ responseData: Record<string, unknown>; provider: Provider; model: string }>,
  log: (msg: string) => void
): Promise<{ responseData: Record<string, unknown>; provider: Provider; model: string; escalations: number }> {
  let escalations = 0;
  
  for (let i = 0; i < config.models.length; i++) {
    const model = config.models[i]!; // Safe: i is always < length
    const isLastModel = i === config.models.length - 1;
    
    try {
      const { responseData, provider, model: resolvedModel } = await makeRequest(model);
      const text = extractResponseTextAuto(responseData);
      
      if (isLastModel || escalations >= config.maxEscalations) {
        return { responseData, provider, model: resolvedModel, escalations };
      }
      
      if (shouldEscalate(text, config.escalateOn)) {
        log(`[RelayPlane] Escalating from ${model} due to ${config.escalateOn}`);
        escalations++;
        continue;
      }
      
      return { responseData, provider, model: resolvedModel, escalations };
    } catch (err) {
      if (err instanceof CooldownError) {
        log(`[RelayPlane] Skipping ${model} due to cooldown`);
        continue;
      }
      if (config.escalateOn === 'error' && !isLastModel) {
        log(`[RelayPlane] Escalating from ${model} due to error`);
        escalations++;
        continue;
      }
      throw err;
    }
  }
  
  throw new Error('All cascade models exhausted');
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RelayPlane Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0b0d;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;max-width:1600px;margin:0 auto}
a{color:#34d399}h1{font-size:1.5rem;font-weight:600}
.header{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid #1e293b;margin-bottom:24px}
.header .meta{font-size:.8rem;color:#64748b}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.card{background:#111318;border:1px solid #1e293b;border-radius:12px;padding:20px}
.card .label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card .value{font-size:1.75rem;font-weight:700}.green{color:#34d399}
.tooltip-wrap{position:relative;display:inline-block}
.tooltip-wrap .tooltip-box{visibility:hidden;opacity:0;background:#1e293b;color:#e2e8f0;font-size:.8rem;font-weight:400;text-transform:none;letter-spacing:0;line-height:1.5;border:1px solid #334155;border-radius:8px;padding:10px 14px;position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:280px;z-index:999;pointer-events:none;transition:opacity .15s;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.tooltip-wrap .tooltip-box::after{content:'';position:absolute;bottom:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-bottom-color:#334155}
.tooltip-wrap:hover .tooltip-box{visibility:visible;opacity:1}
.info-icon{cursor:help;color:#64748b;font-size:.75rem;vertical-align:middle;margin-left:4px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#64748b;font-weight:500;padding:8px 12px;border-bottom:1px solid #1e293b;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
td{padding:8px 12px;border-bottom:1px solid #111318}
.section{margin-bottom:32px}.section h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:#94a3b8}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dot.up{background:#34d399}.dot.warn{background:#fbbf24}.dot.down{background:#ef4444}
.section.collapsible h2{cursor:pointer;user-select:none;display:flex;align-items:center;gap:8px}.section.collapsible h2::after{content:'▾';font-size:.8rem;color:#475569;transition:transform .2s}.section.collapsed h2::after{transform:rotate(-90deg)}.section.collapsed>*:not(h2){display:none!important}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75rem;font-weight:500}
.badge.ok{background:#052e1633;color:#34d399}.badge.err{background:#2d0a0a;color:#ef4444}.badge.err-auth{background:#2d0a0a;color:#ef4444}.badge.err-rate{background:#2d2a0a;color:#fbbf24}.badge.err-timeout{background:#2d1a0a;color:#fb923c}
.badge.tt-code{background:#1e3a5f;color:#60a5fa}.badge.tt-analysis{background:#3b1f6e;color:#a78bfa}.badge.tt-summarization{background:#1a3a2a;color:#6ee7b7}.badge.tt-qa{background:#3a2f1e;color:#fbbf24}.badge.tt-general{background:#1e293b;color:#94a3b8}
.badge.cx-simple{background:#052e1633;color:#34d399}.badge.cx-moderate{background:#2d2a0a;color:#fbbf24}.badge.cx-complex{background:#2d0a0a;color:#ef4444}
.vstat{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:1px 8px;border-radius:999px;border:1px solid #334155;font-size:.72rem}
.vstat.current{color:#94a3b8;border-color:#334155;background:#0f172a66}
.vstat.outdated{color:#fbbf24;border-color:#f59e0b55;background:#3a2f1e66}
.vstat.unavailable{color:#a3a3a3;border-color:#52525b66;background:#18181b66}
@media(max-width:768px){.col-tt,.col-cx{display:none}}
.prov{display:flex;gap:16px;flex-wrap:wrap}.prov-item{display:flex;align-items:center;font-size:.85rem;background:#111318;padding:8px 14px;border-radius:8px;border:1px solid #1e293b}
.rename-btn{background:none;border:none;cursor:pointer;font-size:.75rem;opacity:.5;padding:2px}.rename-btn:hover{opacity:1}
</style></head><body>
<div class="header"><div><h1>⚡ RelayPlane Dashboard</h1></div><div class="meta"><a href="/dashboard/config">Config</a> · <span id="ver"></span><span id="vstat" class="vstat unavailable">Unable to check</span> · up <span id="uptime"></span> · refreshes every 5s</div></div>
<div class="cards">
  <div class="card"><div class="label">Requests (7d window, max 10k)</div><div class="value" id="totalReq">—</div><div id="totalReqDetail" style="font-size:.75rem;color:#64748b;margin-top:4px">—</div></div>
  <div class="card"><div class="label">Total Cost</div><div class="value" id="totalCost">—</div></div>
  <div class="card"><div class="label">Routing Savings <span class="tooltip-wrap"><span class="info-icon">ⓘ</span><span class="tooltip-box" id="savings-tooltip">Loading...</span></span></div><div class="value green" id="savings">—</div><div id="savings-detail" style="font-size:.75rem;color:#64748b;margin-top:4px">—</div></div>
  <div class="card"><div class="label">Avg Latency</div><div class="value" id="avgLat">—</div><div id="avgLatDetail" style="font-size:.75rem;color:#64748b;margin-top:4px">—</div></div>
</div>
<div class="section collapsible collapsed"><h2>Model Breakdown <span style="font-size:.75rem;color:#64748b;font-weight:400">(7d window, history-capped)</span></h2>
<table><thead><tr><th>Provider</th><th>Model</th><th>Requests</th><th>Cost</th><th>% of Total Cost</th></tr></thead><tbody id="models"></tbody></table></div>
<div class="section collapsible collapsed"><h2>Agent Cost Breakdown</h2>
<table><thead><tr><th>Agent</th><th>Requests</th><th>Total Cost</th><th>Last Active</th><th></th></tr></thead><tbody id="agents"></tbody></table></div>
<div class="section"><h2>Provider Status</h2><div class="prov" id="providers"></div></div>
<div class="section collapsible collapsed"><h2>Learning</h2><div id="learning-panel" style="display:flex;flex-direction:column;gap:12px"><div id="learning-stats" style="display:flex;gap:12px;flex-wrap:wrap"></div><div id="learning-recent"></div></div></div>
<div class="section collapsible" id="sessions-section"><h2>Sessions <span id="sessionsLabel" style="font-size:.75rem;color:#64748b;font-weight:400">(last 7d)</span></h2>
<table><thead><tr><th>Session ID</th><th>Source</th><th>Started</th><th>Duration</th><th>Requests</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th><th>Models</th><th>Status</th></tr></thead><tbody id="sessions"></tbody></table>
</div>
<div class="section collapsible collapsed" id="token-pool-section"><h2>Token Pool</h2><div id="token-pool-panel"></div></div>
<div class="section"><h2>Recent Runs <span id="historyLabel" style="font-size:.75rem;color:#64748b;font-weight:400">(7d window, history-capped)</span></h2>
<table><thead><tr><th>Time</th><th>Agent</th><th>Model</th><th class="col-tt">Task Type</th><th class="col-cx">Complexity</th><th>Tokens In</th><th>Tokens Out</th><th class="col-cache">Cache Create</th><th class="col-cache">Cache Read</th><th>Cost</th><th>Latency</th><th>Status</th></tr></thead><tbody id="runs"></tbody></table></div>
<script>
const $ = id => document.getElementById(id);
function esc(s){if(!s)return'';return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
document.querySelectorAll('.section.collapsible h2').forEach(h2=>h2.addEventListener('click',()=>h2.parentElement.classList.toggle('collapsed')));
function fmt(n,d=2){return typeof n==='number'?n.toFixed(d):'-'}
function fmtTime(s){const d=new Date(s);return d.toLocaleTimeString()}
function dur(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m+'m'}
async function loadSessions(){
  try{
    const [sessR,activeR]=await Promise.all([
      fetch('/v1/sessions?limit=20&days=7').then(r=>r.json()).catch(()=>({sessions:[]})),
      fetch('/v1/sessions/active').then(r=>r.json()).catch(()=>({sessions:[]}))
    ]);
    const activeIds=new Set((activeR.sessions||[]).map(s=>s.id));
    const sessions=sessR.sessions||[];
    const el=$('sessions');
    if(!el)return;
    el.innerHTML=sessions.length?sessions.map(s=>{
      const isActive=activeIds.has(s.id)||s.active;
      const dur=s.duration_ms>0?Math.round(s.duration_ms/1000)+'s':'—';
      const badge=isActive?'<span class="badge ok" style="font-size:.7rem">LIVE</span>':'<span style="color:#64748b;font-size:.75rem">idle</span>';
      const srcBadge=s.session_source==='claude-code'?'<span style="color:#60a5fa;font-size:.75rem">claude-code</span>':'<span style="color:#94a3b8;font-size:.75rem">proxy</span>';
      const sid=s.id.length>20?s.id.slice(0,20)+'…':s.id;
      const mix=s.model_mix&&Object.keys(s.model_mix).length?Object.entries(s.model_mix).map(([m,c])=>{const short=m.replace('claude-','').replace(/-\d{8}$/,'').replace('sonnet','Sonnet').replace('opus','Opus').replace('haiku','Haiku');return '<span style="font-size:.72rem;color:#94a3b8">'+short+'<span style="color:#475569">×</span>'+c+'</span>';}).join(' '):'<span style="color:#475569;font-size:.72rem">—</span>';
      return '<tr><td style="font-family:monospace;font-size:.8rem" title="'+esc(s.id)+'">'+sid+'</td><td>'+srcBadge+'</td><td>'+fmtTime(new Date(s.started_at).toISOString())+'</td><td>'+dur+'</td><td>'+s.request_count+'</td><td>'+(s.total_tokens_in||0)+'</td><td>'+(s.total_tokens_out||0)+'</td><td>$'+fmt(s.total_cost_usd,4)+'</td><td>'+mix+'</td><td>'+badge+'</td></tr>';
    }).join(''):'<tr><td colspan=10 style="color:#64748b">No sessions recorded yet</td></tr>';
    const totalCost=sessions.reduce((s,r)=>s+(r.total_cost_usd||0),0);
  }catch(e){console.error('sessions load error',e)}
}
async function load(){
  try{
    const [health,stats,runsR,sav,provH,agentsR]=await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/v1/telemetry/stats').then(r=>r.json()),
      fetch('/v1/telemetry/runs?limit=20').then(r=>r.json()),
      fetch('/v1/telemetry/savings').then(r=>r.json()),
      fetch('/v1/telemetry/health').then(r=>r.json()),
      fetch('/api/agents').then(r=>r.json()).catch(()=>({agents:[]}))
    ]);
    $('ver').textContent='v'+health.version;
    $('uptime').textContent=dur(health.uptime);

    const versionStatus = await fetch('/v1/version-status').then(r=>r.json()).catch(()=>({state:'unavailable', current: health.version, latest: null}));
    const vEl = $('vstat');
    if (vEl) {
      vEl.className = 'vstat ' + (versionStatus.state === 'outdated' ? 'outdated' : versionStatus.state === 'up-to-date' ? 'current' : 'unavailable');
      if (versionStatus.state === 'outdated') {
        vEl.textContent = 'Update available · v' + versionStatus.current + ' → v' + versionStatus.latest;
      } else if (versionStatus.state === 'up-to-date') {
        vEl.textContent = 'Up to date · v' + versionStatus.current;
      } else {
        vEl.textContent = 'Unable to check · v' + versionStatus.current;
      }
    }
    const lifetimeTotal=stats.summary?.totalRequests ?? stats.summary?.totalEvents ?? 0;
    const historyTotal=stats.summary?.totalEvents ?? 0;
    const historyLimit=stats.summary?.historyLimit ?? 10000;
    const retentionDays=stats.summary?.retentionDays ?? 7;
    $('totalReq').textContent=historyTotal;
    $('totalReqDetail').textContent='Process lifetime: '+lifetimeTotal.toLocaleString()+' (resets on restart)';
    $('historyLabel').textContent='('+retentionDays+'d window, max '+historyLimit.toLocaleString()+' requests)';
    $('totalCost').textContent='$'+fmt(stats.summary?.totalCostUsd??0,4);
    const savAmt=sav.savedAmount??sav.savings??0;
    const cacheSav=sav.cacheSavings??0;
    const routeSav=sav.routingSavings??0;
    const actual=sav.actualCost??0;
    const hasAnthropic=sav.hasAnthropicCalls!==false;
    const baseline=sav.potentialSavings??sav.total??0;
    // Headline = routing savings % (RelayPlane's actual contribution)
    const routeBaseline=baseline>0?baseline:1;
    const routePct=hasAnthropic?Math.round((routeSav/routeBaseline)*100):0;
    const totalPct=sav.percentage??0;
    $('savings').textContent='$'+fmt(routeSav,2);
    // Secondary: show total % including cache as context
    if(hasAnthropic){
      $('savings-detail').innerHTML='<span style="color:#60a5fa">routing savings</span> · <span style="color:#64748b" title="Includes Anthropic prompt cache hits which happen regardless of routing">'+totalPct+'% total incl. cache</span>';
    } else {
      $('savings-detail').innerHTML='<span style="color:#a78bfa">$'+fmt(cacheSav,2)+' cache</span> · <span style="color:#64748b">'+totalPct+'% total</span>';
    }
    const tipEl=$('savings-tooltip');
    if(tipEl){
      let tip='<strong>How savings are calculated</strong><br><br>';
      if(hasAnthropic){
        tip+='<span style="color:#60a5fa">🔀 Routing savings: $'+fmt(routeSav,2)+'</span><br><small>Requests routed to cheaper models (e.g. Sonnet) vs always using Opus. RelayPlane contribution.</small><br><br>';
        tip+='<span style="color:#a78bfa">💾 Cache savings: $'+fmt(cacheSav,2)+'</span><br><small>Anthropic prompt cache hits (10× cheaper reads). This would happen without RelayPlane too.</small><br><br>';
      } else {
        tip+='<span style="color:#a78bfa">💾 Cache savings: $'+fmt(cacheSav,2)+'</span><br><small>Provider cache hits. Happens automatically, not specific to RelayPlane.</small><br><br>';
      }
      tip+='💳 Actual cost: <b>$'+fmt(actual,2)+'</b><br>✅ Total saved: <b>$'+fmt(savAmt,2)+'</b>';
      tipEl.innerHTML=tip;
    }
    $('avgLat').textContent=(stats.summary?.avgLatencyMs??0)+'ms';
    $('avgLatDetail').textContent='7d window metric (history-capped)';
    const modelTotalCost=(stats.byModel||[]).reduce((s,m)=>s+(m.costUsd||0),0);
    $('models').innerHTML=(stats.byModel||[]).map(m=>
      '<tr><td style="color:#94a3b8;font-size:.85rem">'+(m.provider||'—')+'</td><td>'+m.model+'</td><td>'+m.count+'</td><td>$'+fmt(m.costUsd,4)+'</td><td>'+fmt(modelTotalCost>0?m.costUsd/modelTotalCost*100:0,1)+'%</td></tr>'
    ).join('')||'<tr><td colspan=5 style="color:#64748b">No data yet</td></tr>';
    function ttCls(t){const m={code_generation:'tt-code',analysis:'tt-analysis',summarization:'tt-summarization',question_answering:'tt-qa'};return m[t]||'tt-general'}
    function cxCls(c){const m={simple:'cx-simple',moderate:'cx-moderate',complex:'cx-complex'};return m[c]||'cx-simple'}
    const agents=(agentsR.agents||[]).sort((a,b)=>(b.totalCost||0)-(a.totalCost||0));
    $('runs').innerHTML=(runsR.runs||[]).map((r,i)=>{
      function errBadge(r){if(r.status==='success')return '<span class="badge ok">success</span>';var cls='err';var label=r.error||'error';if(r.statusCode===401||r.statusCode===403||(r.error&&/auth/i.test(r.error)))cls='err-auth';else if(r.statusCode===429||(r.error&&/rate.?limit/i.test(r.error)))cls='err-rate';else if(r.error&&/timeout/i.test(r.error))cls='err-timeout';return '<span class="badge '+cls+'" title="'+esc(r.error||'')+' (HTTP '+( r.statusCode||'?')+')">'+(r.statusCode?r.statusCode+' ':'')+ (label.length>40?label.slice(0,40)+'…':label)+'</span>';}
      const agentName=agents.find(a=>a.fingerprint===r.agentFingerprint)?.name||(r.agentId||'—');
      const row='<tr style="cursor:pointer" onclick="toggleDetail('+i+')"><td><span id="arrow-'+i+'" style="color:#64748b;font-size:.7rem;margin-right:6px">▶</span>'+fmtTime(r.started_at)+'</td><td style="font-size:.85rem">'+esc(agentName)+'</td><td>'+r.model+'</td><td class="col-tt"><span class="badge '+ttCls(r.taskType)+'">'+(r.taskType||'general').replace(/_/g,' ')+'</span></td><td class="col-cx"><span class="badge '+cxCls(r.complexity)+'">'+(r.complexity||'simple')+'</span></td><td>'+(r.tokensIn||0)+'</td><td>'+(r.tokensOut||0)+'</td><td class="col-cache" style="color:#60a5fa">'+(r.cacheCreationTokens||0)+'</td><td class="col-cache" style="color:#34d399">'+(r.cacheReadTokens||0)+'</td><td>$'+fmt(r.costUsd,4)+'</td><td>'+r.latencyMs+'ms</td><td>'+errBadge(r)+'</td></tr>';
      const c=r.requestContent||{};
      let detail='<tr id="run-detail-'+i+'" style="display:none"><td colspan="12" style="padding:16px;background:#111217;border-bottom:1px solid #1e293b">';
      if(c.systemPrompt||c.userMessage||c.responsePreview){
        if(c.systemPrompt) detail+='<div style="color:#64748b;font-size:.85rem;margin-bottom:10px;font-style:italic"><strong style="color:#94a3b8">System:</strong> '+esc(c.systemPrompt)+'</div>';
        if(c.userMessage) detail+='<div style="background:#1a1c23;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:10px"><strong style="color:#94a3b8;font-size:.8rem">User Message</strong><div style="margin-top:6px;white-space:pre-wrap">'+esc(c.userMessage)+'</div></div>';
        if(c.responsePreview) detail+='<div style="background:#1a1c23;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:10px"><strong style="color:#94a3b8;font-size:.8rem">Response Preview</strong><div style="margin-top:6px;white-space:pre-wrap">'+esc(c.responsePreview)+'</div></div>';
        const btnAttrs='id="full-btn-'+i+'" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 12px;border-radius:6px;font-size:.8rem"';
        detail+=(r.tokensOut>0?'<button onclick="event.stopPropagation();loadFullResponse(&quot;'+r.id+'&quot;,'+i+')" '+btnAttrs+'>Show full response</button>':'<button disabled '+btnAttrs+' style="opacity:.4;cursor:default">Response not available (streaming)</button>')+'<pre id="full-resp-'+i+'" style="display:none;white-space:pre-wrap;margin-top:10px;background:#0d0e11;border:1px solid #1e293b;border-radius:8px;padding:12px;max-height:400px;overflow:auto;font-size:.8rem"></pre>';
      } else {
        detail+='<span style="color:#64748b">No content captured for this request</span>';
      }
      detail+='</td></tr>';
      return row+detail;
    }).join('')||'<tr><td colspan=12 style="color:#64748b">No runs yet</td></tr>';
    restoreExpanded();
    $('agents').innerHTML=agents.length?agents.map(a=>
      '<tr><td><span class="agent-name" data-fp="'+a.fingerprint+'">'+esc(a.name)+'</span> <button class="rename-btn" onclick="renameAgent(&quot;'+a.fingerprint+'&quot;,&quot;'+a.name.replace(/"/g,'')+'&quot;)">✏️</button></td><td>'+a.totalRequests+'</td><td>$'+fmt(a.totalCost,4)+'</td><td>'+fmtTime(a.lastSeen)+'</td><td style="font-size:.7rem;color:#64748b" title="'+esc(a.systemPromptPreview||'')+'">'+a.fingerprint+'</td></tr>'
    ).join(''):'<tr><td colspan=5 style="color:#64748b">No agents detected yet</td></tr>';
    $('providers').innerHTML=(provH.providers||[]).map(p=>{
      const dotClass = p.status==='healthy'?'up':(p.status==='degraded'?'warn':'down');
      const rate = p.successRate!==undefined?(' '+Math.round(p.successRate*100)+'%'):'';
      return '<div class="prov-item"><span class="dot '+dotClass+'"></span>'+p.provider+rate+'</div>';
    }).join('');
  }catch(e){console.error(e)}
}
async function renameAgent(fp,currentName){
  const name=prompt('Rename agent:',currentName);
  if(!name||name===currentName)return;
  await fetch('/api/agents/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fingerprint:fp,name:name})});
  load();
}
const expandedRows=new Set();
function toggleDetail(i){var d=document.getElementById('run-detail-'+i);var arrow=document.getElementById('arrow-'+i);if(d.style.display==='none'){d.style.display='table-row';expandedRows.add(i);if(arrow)arrow.textContent='▼'}else{d.style.display='none';expandedRows.delete(i);if(arrow)arrow.textContent='▶'}}
function restoreExpanded(){expandedRows.forEach(i=>{var d=document.getElementById('run-detail-'+i);var arrow=document.getElementById('arrow-'+i);if(d)d.style.display='table-row';if(arrow)arrow.textContent='▼'})}
async function loadFullResponse(runId,i){
  const btn=document.getElementById('full-btn-'+i);
  const pre=document.getElementById('full-resp-'+i);
  if(pre.style.display!=='none'){pre.style.display='none';btn.textContent='Show full response';return}
  btn.textContent='Loading...';
  try{
    const data=await fetch('/api/runs/'+runId).then(r=>r.json());
    const full=data.requestContent&&data.requestContent.fullResponse;
    if(full){pre.textContent=full;pre.style.display='block';btn.textContent='Hide full response'}
    else{btn.textContent='No full response available'}
  }catch{btn.textContent='Error loading response'}
}
async function loadLearning(){
  try{
    const k=await fetch('/v1/knowledge/stats').then(r=>r.json()).catch(()=>null);
    if(!k)return;
    const statsEl=$('learning-stats');
    const recentEl=$('learning-recent');
    if(statsEl){
      statsEl.innerHTML='<div class="card" style="flex:1;min-width:140px"><div class="label">Total Learnings</div><div class="value">'+k.totalLearnings+'</div></div>'+
        '<div class="card" style="flex:1;min-width:140px"><div class="label">Recent (7d)</div><div class="value">'+k.recentLearnings.length+'</div></div>'+
        '<div class="card" style="flex:2;min-width:200px"><div class="label">Knowledge Files</div><div class="value" style="font-size:.9rem;line-height:1.6">'+
        (k.fileStats.length?k.fileStats.map(function(f){return '<span style="color:#94a3b8;font-weight:400">'+f.file+'</span> <span style="color:#34d399">'+f.learnings+'</span>'}).join(' &middot; '):'—')+'</div></div>';
    }
    if(recentEl){
      if(k.recentLearnings.length){
        recentEl.innerHTML='<div style="font-size:.8rem;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Recent Learnings (7d)</div>'+
          k.recentLearnings.map(function(l){return '<div style="padding:8px 12px;background:#111318;border:1px solid #1e293b;border-radius:8px;margin-bottom:6px;font-size:.85rem"><span style="color:#64748b;font-size:.75rem">'+l.date+' · @'+l.agent+'</span><div style="margin-top:4px">'+l.preview+'</div></div>'}).join('');
      }else{
        recentEl.innerHTML='<div style="color:#64748b;font-size:.85rem">No learnings recorded yet. Run <code style="background:#1e293b;padding:2px 6px;border-radius:4px">node packages/proxy/scripts/extract-knowledge.js</code> after agent sessions.</div>';
      }
    }
  }catch(e){console.error('learning load error',e)}
}
async function loadTokenPool(){
  try{
    const data=await fetch('/v1/token-pool/status').then(r=>r.json()).catch(()=>null);
    const el=$('token-pool-panel');
    if(!el)return;
    if(!data||!data.accounts||data.accounts.length===0){
      el.innerHTML='<div style="color:#64748b;font-size:.85rem">No accounts registered. Add accounts under <code style="background:#1e293b;padding:2px 6px;border-radius:4px">providers.anthropic.accounts[]</code> in ~/.relayplane/config.json for multi-account pooling.</div>';
      return;
    }
    el.innerHTML='<table><thead><tr><th>Label</th><th>Source</th><th>Priority</th><th>Type</th><th>Req/min</th><th>RPM Limit</th><th>Status</th></tr></thead><tbody>'+
      data.accounts.map(function(a){
        const rl=a.rateLimitedUntil?'<span class="badge err">rate-limited until '+new Date(a.rateLimitedUntil).toLocaleTimeString()+'</span>':
          a.available?'<span class="badge ok">available</span>':'<span class="badge err-rate">throttled</span>';
        const type=a.isOat?'<span style="color:#60a5fa;font-size:.75rem">OAT/Max</span>':'<span style="color:#94a3b8;font-size:.75rem">API key</span>';
        const src=a.source==='config'?'<span style="color:#34d399;font-size:.75rem">config</span>':'<span style="color:#64748b;font-size:.75rem">auto</span>';
        const pct=a.knownRpmLimit>0?Math.round(a.requestsThisMinute/a.knownRpmLimit*100):0;
        const bar='<div style="background:#1e293b;border-radius:4px;height:6px;width:80px;display:inline-block;vertical-align:middle"><div style="background:'+(pct>=90?'#ef4444':pct>=70?'#fbbf24':'#34d399')+';height:100%;border-radius:4px;width:'+Math.min(pct,100)+'%"></div></div>';
        return '<tr><td>'+esc(a.label)+'</td><td>'+src+'</td><td>'+a.priority+'</td><td>'+type+'</td><td>'+a.requestsThisMinute+' '+bar+'</td><td>'+a.knownRpmLimit+' rpm</td><td>'+rl+'</td></tr>';
      }).join('')+'</tbody></table>';
  }catch(e){console.error('token pool load error',e)}
}
load();loadLearning();loadSessions();loadTokenPool();setInterval(load,5000);setInterval(loadLearning,30000);setInterval(loadSessions,10000);setInterval(loadTokenPool,10000);
</script><footer style="text-align:center;padding:20px 0;color:#475569;font-size:.75rem;border-top:1px solid #1e293b;margin-top:20px">🔒 Request content stays on your machine. Never sent to cloud.</footer></body></html>`;
}

// ── Knowledge stats ─────────────────────────────────────────────────────────
interface KnowledgeLearning {
  date: string;
  agent: string;
  preview: string;
}

interface KnowledgeStats {
  totalLearnings: number;
  recentLearnings: KnowledgeLearning[];
  fileStats: { file: string; learnings: number }[];
  knowledgeDir: string;
}

async function getKnowledgeStats(): Promise<KnowledgeStats> {
  const knowledgeDir = path.join(os.homedir(), '.openclaw', 'workspace', 'knowledge');
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  let totalLearnings = 0;
  const recentLearnings: KnowledgeLearning[] = [];
  const fileStats: { file: string; learnings: number }[] = [];

  let files: string[] = [];
  try {
    files = await fs.promises.readdir(knowledgeDir);
  } catch {
    // directory may not exist yet
    return { totalLearnings: 0, recentLearnings: [], fileStats: [], knowledgeDir };
  }

  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const filePath = path.join(knowledgeDir, file);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    // Count <!-- [YYYY-MM-DD] agent:xxx --> markers as learning entries
    const markerRegex = /<!--\s*\[(\d{4}-\d{2}-\d{2})\]\s*agent:(\w+)\s*-->\n([\s\S]*?)(?=<!--|\s*$)/g;
    let match: RegExpExecArray | null;
    let fileCount = 0;

    while ((match = markerRegex.exec(content)) !== null) {
      const dateStr = match[1];
      const agent = match[2];
      const body = match[3].trim();
      fileCount++;
      totalLearnings++;

      const entryDate = new Date(dateStr);
      if (entryDate >= sevenDaysAgo) {
        // Extract first bullet as preview
        const firstLine = body.split('\n').find((l) => l.trim().startsWith('-')) || body.split('\n')[0] || '';
        recentLearnings.push({
          date: dateStr,
          agent,
          preview: firstLine.replace(/^-\s*/, '').slice(0, 100),
        });
      }
    }

    fileStats.push({ file, learnings: fileCount });
  }

  recentLearnings.sort((a, b) => b.date.localeCompare(a.date));

  return { totalLearnings, recentLearnings: recentLearnings.slice(0, 10), fileStats, knowledgeDir };
}

function getConfigDashboardHTML(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RelayPlane Config</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0b0d;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;max-width:1600px;margin:0 auto}
a{color:#34d399}h1{font-size:1.5rem;font-weight:600}
.header{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid #1e293b;margin-bottom:24px}
.header .meta{font-size:.8rem;color:#64748b}
.section{margin-bottom:32px}.section h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:#94a3b8}
.card{background:#111318;border:1px solid #1e293b;border-radius:12px;padding:20px;margin-bottom:16px}
.card .label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card .value{font-size:1.75rem;font-weight:700}
.green{color:#34d399}.yellow{color:#fbbf24}.red{color:#ef4444}
.badge{display:inline-block;padding:4px 12px;border-radius:6px;font-size:.8rem;font-weight:500}
.badge.ok{background:#052e1633;color:#34d399}.badge.warn{background:#2d2a0a;color:#fbbf24}.badge.off{background:#1e293b;color:#64748b}
.config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.config-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e293b}
.config-row:last-child{border-bottom:none}
.config-key{color:#94a3b8;font-size:.85rem}.config-val{font-weight:600;font-size:.9rem}
.model-pill{display:inline-block;background:#1e293b;padding:4px 10px;border-radius:6px;font-size:.8rem;margin:2px}
pre.raw{background:#111318;border:1px solid #1e293b;border-radius:8px;padding:16px;overflow-x:auto;font-size:.8rem;color:#94a3b8;max-height:400px;overflow-y:auto}
</style></head><body>
<div class="header"><div><h1>⚡ RelayPlane Config</h1></div><div class="meta"><a href="/dashboard">← Dashboard</a> · read-only view of ~/.relayplane/config.json</div></div>
<div id="content"><p style="color:#64748b">Loading config...</p></div>
<script>
async function load(){
  try{
    const cfg=await fetch('/v1/config').then(r=>r.json());
    const r=cfg.routing||{};const c=r.cascade||{};const rel=cfg.reliability||{};const mesh=cfg.mesh||{};
    const mode=r.mode||'auto';
    const modeColor=mode==='auto'?'green':mode==='cascade'?'yellow':'';
    const cx=r.complexity||{};
    const cascadeEnabled=c.enabled!==false&&(c.models||[]).length>0;
    const meshEnabled=mesh.enabled===true;

    let html='<div class="config-grid">';
    html+='<div class="card"><div class="label">Routing Mode</div><div class="value '+modeColor+'">'+mode+'</div></div>';
    html+='<div class="card"><div class="label">Cascade</div><div class="value">'+(cascadeEnabled?'<span class="green">Enabled</span>':'<span style="color:#64748b">Disabled</span>')+'</div></div>';
    html+='<div class="card"><div class="label">Mesh</div><div class="value">'+(meshEnabled?'<span class="green">Enabled</span>':'<span style="color:#64748b">Disabled</span>')+'</div></div>';
    html+='</div>';

    // Complexity model mapping
    html+='<div class="section"><h2>Complexity Model Mapping</h2><div class="card">';
    if(cx.simple||cx.moderate||cx.complex){
      html+='<div class="config-row"><span class="config-key">Simple →</span><span class="config-val"><span class="model-pill">'+(cx.simple||'default')+'</span></span></div>';
      html+='<div class="config-row"><span class="config-key">Moderate →</span><span class="config-val"><span class="model-pill">'+(cx.moderate||'default')+'</span></span></div>';
      html+='<div class="config-row"><span class="config-key">Complex →</span><span class="config-val"><span class="model-pill">'+(cx.complex||'default')+'</span></span></div>';
      html+='<div class="config-row"><span class="config-key">Enabled</span><span class="config-val">'+(cx.enabled!==false?'<span class="badge ok">Yes</span>':'<span class="badge off">No</span>')+'</span></div>';
    }else{html+='<p style="color:#64748b">No complexity mapping configured</p>';}
    html+='</div></div>';

    // Cascade settings
    html+='<div class="section"><h2>Cascade Settings</h2><div class="card">';
    if(cascadeEnabled){
      html+='<div class="config-row"><span class="config-key">Models</span><span class="config-val">'+(c.models||[]).map(function(m){return '<span class="model-pill">'+m+'</span>'}).join(' → ')+'</span></div>';
      html+='<div class="config-row"><span class="config-key">Escalate On</span><span class="config-val">'+(c.escalateOn||'uncertainty')+'</span></div>';
      if(c.maxEscalations)html+='<div class="config-row"><span class="config-key">Max Escalations</span><span class="config-val">'+c.maxEscalations+'</span></div>';
    }else{html+='<p style="color:#64748b">Cascade not configured</p>';}
    html+='</div></div>';

    // Reliability
    html+='<div class="section"><h2>Reliability Settings</h2><div class="card">';
    const cool=rel.cooldown||{};
    html+='<div class="config-row"><span class="config-key">Cooldown Duration</span><span class="config-val">'+(cool.durationMs||(cool.duration??'default'))+'</span></div>';
    html+='<div class="config-row"><span class="config-key">Max Failures</span><span class="config-val">'+(cool.maxFailures||'default')+'</span></div>';
    html+='</div></div>';

    // Mesh
    html+='<div class="section"><h2>Mesh Settings</h2><div class="card">';
    html+='<div class="config-row"><span class="config-key">Enabled</span><span class="config-val">'+(meshEnabled?'<span class="badge ok">Yes</span>':'<span class="badge off">No</span>')+'</span></div>';
    if(mesh.peers)html+='<div class="config-row"><span class="config-key">Peers</span><span class="config-val">'+(mesh.peers||[]).map(function(p){return '<span class="model-pill">'+p+'</span>'}).join(' ')+'</span></div>';
    html+='</div></div>';

    // Raw JSON
    html+='<div class="section"><h2>Raw Config</h2><pre class="raw">'+JSON.stringify(cfg,null,2)+'</pre></div>';

    document.getElementById('content').innerHTML=html;
  }catch(e){document.getElementById('content').innerHTML='<p style="color:#ef4444">Error loading config: '+e.message+'</p>';}
}
load();
</script></body></html>`;
}

/**
 * Start the RelayPlane proxy server
 */
export async function startProxy(config: ProxyConfig = {}): Promise<http.Server> {
  const port = config.port ?? 4801;
  const host = config.host ?? '127.0.0.1';
  const verbose = config.verbose ?? false;
  const anthropicAuthMode = config.anthropicAuth ?? 'auto';

  const log = (msg: string) => {
    if (verbose) console.log(`[relayplane] ${msg}`);
  };

  // Resolve smart aliases based on available env vars
  const { aliases: resolvedAliases, via: aliasVia } = buildSmartAliases();
  SMART_ALIASES = resolvedAliases;
  console.log(`[RelayPlane] Smart aliases resolved via: ${aliasVia}`);

  // Load persistent history from disk
  loadHistoryFromDisk();
  loadAgentRegistry();

  // Check once at startup whether the nudges have already been shown
  initNudge();
  initStarNudge();

  // Lifecycle event: daily session heartbeat
  setImmediate(() => maybeSendSessionHeartbeat());

  // Flush history on shutdown
  const handleShutdown = () => {
    flushAgentRegistry();
    meshHandle.stop();
    shutdownHistory();
    TraceWriter.getInstance().shutdown();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  const configPath = getProxyConfigPath();
  let proxyConfig = await loadProxyConfig(configPath, log);

  // ── Deterministic Traces: initialise TraceWriter with loaded config ──
  TraceWriter.getInstance({
    ...(defaultTracesConfig()),
    ...(proxyConfig.traces ?? {}),
  });

  // ── Tool Router: initialise deny-by-default tool authorization ──
  getToolRouter();

  // Auto-config on startup: detect available auth and set optimal routing.
  //
  // Bug fix: `configExists` was always true because loadConfig() (CLI init) creates
  // config.json before startProxy() runs. Instead, check whether routing was explicitly
  // written to the raw file (by the auto-config itself or by the user).
  // If not, this is a first-run scenario and we should write optimal routing.
  {
    let rawFileHasRouting = false;
    try {
      const rawData = await fs.promises.readFile(configPath, 'utf8');
      const rawJson = JSON.parse(rawData) as Record<string, unknown>;
      rawFileHasRouting = !!(rawJson['routing']);
    } catch { /* file missing or parse error = treat as first run */ }

    const userConfig = loadUserConfig();
    configureRateLimiter();
    // ── Cross-provider cascade: configure from proxy config (GH #38) ──
    if (proxyConfig.crossProviderCascade?.enabled && (proxyConfig.crossProviderCascade.providers?.length ?? 0) > 1) {
      crossProviderCascade.configure({
        enabled: true,
        providers: proxyConfig.crossProviderCascade.providers!,
        triggerStatuses: proxyConfig.crossProviderCascade.triggerStatuses,
        modelMapping: proxyConfig.crossProviderCascade.modelMapping,
      });
      log(`[CROSS-CASCADE] Enabled. Provider order: ${proxyConfig.crossProviderCascade.providers!.join(' → ')}`);
    }
    const isFirstRun = !rawFileHasRouting || !userConfig.first_run_complete;

    // Always detect available providers and update DEFAULT_ROUTING at startup
    const availableProviders = detectAvailableProviders(userConfig as unknown as Record<string, unknown> | undefined);
    {
      // Build human-readable provider labels for startup log
      const providerLabels = availableProviders.map((p) => {
        if (p === 'anthropic') {
          const key = process.env['ANTHROPIC_API_KEY'] || '';
          return key.startsWith('sk-ant-api') ? '✓ Anthropic' : '✓ Anthropic (Max)';
        }
        return `✓ ${p.charAt(0).toUpperCase() + p.slice(1)}`;
      });
      if (providerLabels.length > 0) {
        console.log(`[RelayPlane] ${providerLabels.join(', ')}`);
      }

      // Build default tiers, respecting any existing user config overrides
      const existingComplexity = proxyConfig.routing?.complexity as Partial<ComplexityConfig> | undefined;
      const defaultProviders: Provider[] = availableProviders.length > 0 ? availableProviders : ['openrouter'];
      const tiers = buildDefaultComplexityTiers(defaultProviders, existingComplexity);

      // Update DEFAULT_ROUTING with detected provider's moderate tier
      const moderateRoute = tiers.moderate;
      const allTaskTypes: TaskType[] = ['code_generation', 'code_review', 'summarization', 'analysis', 'creative_writing', 'data_extraction', 'translation', 'question_answering', 'general'];
      for (const tt of allTaskTypes) {
        DEFAULT_ROUTING[tt] = moderateRoute;
      }

      console.log(`[RelayPlane] Auto-routing: simple=${tiers.simple.model}, moderate=${tiers.moderate.model}, complex=${tiers.complex.model}`);
    }

    if (isFirstRun || proxyConfig.routing?.mode === 'auto') {
      const envAnthropicKey = process.env['ANTHROPIC_API_KEY'];
      const hasRegularApiKey = !!envAnthropicKey && envAnthropicKey.startsWith('sk-ant-api');

      if (isFirstRun) {
        let existingRaw: Record<string, unknown> = {};
        try {
          existingRaw = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        } catch { /* fresh start, no existing config */ }

        let autoComplexity: { simple: string; moderate: string; complex: string };
        if (availableProviders.includes('anthropic') && hasRegularApiKey) {
          // Full Anthropic API key — enable haiku 3-tier routing
          console.log('[RelayPlane] Auto-config: ANTHROPIC_API_KEY detected — enabling 3-tier routing (haiku/sonnet/opus)');
          autoComplexity = { simple: 'claude-haiku-4-5', moderate: 'claude-sonnet-4-6', complex: 'claude-opus-4-6' };
        } else if (availableProviders.length > 0 && !availableProviders.includes('anthropic')) {
          // Non-Anthropic provider — use detected provider's tiers
          const providerTiers = buildDefaultComplexityTiers(availableProviders);
          console.log(`[RelayPlane] Auto-config: ${availableProviders[0]} detected — enabling provider-aware 3-tier routing`);
          autoComplexity = {
            simple: `${providerTiers.simple.provider}/${providerTiers.simple.model}`,
            moderate: `${providerTiers.moderate.provider}/${providerTiers.moderate.model}`,
            complex: `${providerTiers.complex.provider}/${providerTiers.complex.model}`,
          };
        } else {
          // OAuth only or no API key — skip Haiku (OAuth not supported for Haiku)
          console.warn('[RelayPlane] ⚠️  No ANTHROPIC_API_KEY (sk-ant-api*) — Haiku disabled. Set ANTHROPIC_API_KEY to enable 3-tier routing.');
          autoComplexity = { simple: 'claude-sonnet-4-6', moderate: 'claude-sonnet-4-6', complex: 'claude-opus-4-6' };
        }

        const autoRouting = {
          mode: 'complexity',
          cascade: { enabled: false, models: [], escalateOn: 'uncertainty', maxEscalations: 1 },
          complexity: { enabled: true, ...autoComplexity },
        };
        const updatedConfig = { ...existingRaw, routing: autoRouting, first_run_complete: true };
        await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');
        proxyConfig = await loadProxyConfig(configPath, log);
        console.log(`[RelayPlane] Auto-config: wrote routing config to ${configPath}`);
      }
    }
  }

  _activeProxyConfig = proxyConfig;
  _activeOllamaConfig = proxyConfig.ollama;
  const cooldownManager = new CooldownManager(getCooldownConfig(proxyConfig));

  // === Token pool: register explicit config accounts ===
  {
    const userCfg = loadUserConfig();
    const anthropicAccounts = userCfg.providers?.['anthropic']?.accounts;
    if (anthropicAccounts && anthropicAccounts.length > 0) {
      const poolAccounts: PoolAccountConfig[] = anthropicAccounts.map((a) => ({
        label: a.label,
        apiKey: a.apiKey,
        priority: a.priority ?? 0,
      }));
      getTokenPool().registerConfigAccounts(poolAccounts);
      console.log(`[RelayPlane] Token pool: ${anthropicAccounts.length} configured account(s) registered`);
    }
  }

  // === Ollama provider initialization ===
  if (_activeOllamaConfig?.enabled !== false && _activeOllamaConfig?.models?.length) {
    const ollamaUrl = _activeOllamaConfig.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
    console.log(`[RelayPlane] Ollama provider configured: ${ollamaUrl}`);
    console.log(`[RelayPlane] Ollama models: ${_activeOllamaConfig.models.join(', ')}`);
    if (_activeOllamaConfig.routeWhen) {
      const routeInfo: string[] = [];
      if (_activeOllamaConfig.routeWhen.complexity?.length) {
        routeInfo.push(`complexity: ${_activeOllamaConfig.routeWhen.complexity.join(', ')}`);
      }
      if (_activeOllamaConfig.routeWhen.taskTypes?.length) {
        routeInfo.push(`taskTypes: ${_activeOllamaConfig.routeWhen.taskTypes.join(', ')}`);
      }
      if (routeInfo.length) {
        console.log(`[RelayPlane] Ollama routing rules: ${routeInfo.join('; ')}`);
      }
    }
    // Async health check (non-blocking)
    checkOllamaHealthCached(ollamaUrl).then((health) => {
      if (health.available) {
        console.log(`[RelayPlane] ✓ Ollama is online (${health.models.length} models available, ${health.responseTimeMs}ms)`);
      } else {
        console.warn(`[RelayPlane] ⚠️  Ollama not available: ${health.error} — will fall back to cloud providers`);
      }
    }).catch(() => {
      console.warn('[RelayPlane] ⚠️  Ollama health check failed — will fall back to cloud providers');
    });
  }

  // === Startup config validation (Task 4) ===
  try {
    const userConfig = loadUserConfig();
    
    // Check if config was just created (created_at within 5s of now)
    const createdAt = new Date(userConfig.created_at).getTime();
    const now = Date.now();
    if (Math.abs(now - createdAt) < 5000) {
      console.warn('[RelayPlane] WARNING: Fresh config detected — previous config may have been deleted');
    }
    
    // Check if credentials exist but config doesn't reference them
    if (hasValidCredentials() && !userConfig.api_key) {
      console.warn('[RelayPlane] WARNING: credentials.json exists but config has no API key reference');
    }
    
    // Auto-enable telemetry for authenticated users
    if (hasValidCredentials() && !userConfig.telemetry_enabled) {
      // Already handled in loadConfig() for fresh configs, but handle existing configs too
    }
    
    // Validate expected fields
    if (!userConfig.device_id || !userConfig.created_at || userConfig.config_version === undefined) {
      console.warn('[RelayPlane] WARNING: Config is missing expected fields');
    }
  } catch (err) {
    console.warn(`[RelayPlane] Config validation error: ${err}`);
  }

  // Initialize mesh learning layer
  const meshConfig = getMeshConfig();
  const userConfig = loadUserConfig();
  const meshHandle: MeshHandle = _meshHandle = initMeshLayer(
    {
      enabled: meshConfig.enabled,
      endpoint: meshConfig.endpoint,
      sync_interval_ms: meshConfig.sync_interval_ms,
      contribute: meshConfig.contribute,
    },
    userConfig.api_key,
  );

  // Initialize budget manager
  const budgetManager = getBudgetManager(proxyConfig.budget);
  if (proxyConfig.budget?.enabled) {
    try {
      budgetManager.init();
      log('Budget manager initialized');
    } catch (err) {
      log(`Budget manager init failed: ${err}`);
    }
  }

  // Initialize anomaly detector
  const anomalyDetector = getAnomalyDetector(proxyConfig.anomaly);

  // Initialize alert manager
  const alertManager = getAlertManager(proxyConfig.alerts);
  if (proxyConfig.alerts?.enabled) {
    try {
      alertManager.init();
      log('Alert manager initialized');
    } catch (err) {
      log(`Alert manager init failed: ${err}`);
    }
  }

  // Downgrade config
  let downgradeConfig: DowngradeConfig = {
    ...DEFAULT_DOWNGRADE_CONFIG,
    ...(proxyConfig.downgrade ?? {}),
  };

  /**
   * Pre-request budget check + auto-downgrade.
   * Returns the (possibly downgraded) model and extra response headers.
   * If the request should be blocked, returns { blocked: true }.
   */
  function preRequestBudgetCheck(
    model: string,
    estimatedCost?: number,
  ): { blocked: boolean; model: string; headers: Record<string, string>; downgraded: boolean } {
    const headers: Record<string, string> = {};
    let finalModel = model;
    let downgraded = false;

    // Budget check
    const budgetResult = budgetManager.checkBudget(estimatedCost);
    if (budgetResult.breached) {
      // Fire breach alert
      const limit = budgetResult.breachType === 'hourly'
        ? budgetManager.getConfig().hourlyUsd
        : budgetManager.getConfig().dailyUsd;
      const spend = budgetResult.breachType === 'hourly'
        ? budgetResult.currentHourlySpend
        : budgetResult.currentDailySpend;
      alertManager.fireBreach(budgetResult.breachType, spend, limit);

      if (budgetResult.action === 'block') {
        return { blocked: true, model: finalModel, headers, downgraded: false };
      }
      if (budgetResult.action === 'downgrade') {
        const dr = checkDowngrade(finalModel, 100, downgradeConfig);
        if (dr.downgraded) {
          finalModel = dr.newModel;
          downgraded = true;
          applyDowngradeHeaders(headers, dr);
        }
      }
    }

    // Fire threshold alerts
    for (const threshold of budgetResult.thresholdsCrossed) {
      alertManager.fireThreshold(
        threshold,
        (budgetResult.currentDailySpend / budgetManager.getConfig().dailyUsd) * 100,
        budgetResult.currentDailySpend,
        budgetManager.getConfig().dailyUsd,
      );
      budgetManager.markThresholdFired(threshold);
    }

    // Auto-downgrade based on budget percentage (even if not breached)
    if (!downgraded && downgradeConfig.enabled) {
      const pct = budgetManager.getConfig().dailyUsd > 0
        ? (budgetResult.currentDailySpend / budgetManager.getConfig().dailyUsd) * 100
        : 0;
      const dr = checkDowngrade(finalModel, pct, downgradeConfig);
      if (dr.downgraded) {
        finalModel = dr.newModel;
        downgraded = true;
        applyDowngradeHeaders(headers, dr);
      }
    }

    return { blocked: false, model: finalModel, headers, downgraded };
  }

  /**
   * Post-request: record spend, run anomaly detection, fire anomaly alerts.
   */
  function postRequestRecord(
    model: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): void {
    // Record spend
    budgetManager.recordSpend(costUsd, model);

    // Anomaly detection
    const anomalyResult = anomalyDetector.recordAndAnalyze({
      model,
      tokensIn,
      tokensOut,
      costUsd,
    });
    if (anomalyResult.detected) {
      for (const anomaly of anomalyResult.anomalies) {
        alertManager.fireAnomaly(anomaly);
      }
    }
  }

  // Initialize response cache
  const responseCache = getResponseCache(proxyConfig.cache);
  if (proxyConfig.cache?.enabled !== false) {
    try {
      responseCache.init();
      log('Response cache initialized');
    } catch (err) {
      log(`Response cache init failed: ${err}`);
    }
  }

  let configWatcher: fs.FSWatcher | null = null;
  let configReloadTimer: NodeJS.Timeout | null = null;

  const reloadConfig = async () => {
    proxyConfig = await loadProxyConfig(configPath, log);
    cooldownManager.updateConfig(getCooldownConfig(proxyConfig));
    budgetManager.updateConfig({ ...budgetManager.getConfig(), ...(proxyConfig.budget ?? {}) });
    anomalyDetector.updateConfig({ ...anomalyDetector.getConfig(), ...(proxyConfig.anomaly ?? {}) });
    alertManager.updateConfig({ ...alertManager.getConfig(), ...(proxyConfig.alerts ?? {}) });
    downgradeConfig = { ...DEFAULT_DOWNGRADE_CONFIG, ...(proxyConfig.downgrade ?? {}) };
    _activeOllamaConfig = proxyConfig.ollama;
    clearOllamaHealthCache(); // Invalidate cached health on config change
    log(`Reloaded config from ${configPath}`);
  };

  const scheduleConfigReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      reloadConfig().catch(() => {});
    }, 50);
  };

  const startConfigWatcher = () => {
    if (configWatcher) return;
    try {
      configWatcher = fs.watch(configPath, scheduleConfigReload);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      log(`Config watch error: ${error.message}`);
    }
  };

  startConfigWatcher();

  // Initialize RelayPlane
  const relay = new RelayPlane({ dbPath: config.dbPath });

  // Startup migration: clear default routing rules so complexity config takes priority
  const clearDefaultRules = (relay.routing as { clearDefaultRules?: () => number }).clearDefaultRules;
  const clearedCount = typeof clearDefaultRules === 'function' ? clearDefaultRules.call(relay.routing) : 0;
  if (clearedCount > 0) {
    log(`Cleared ${clearedCount} default routing rules (complexity config takes priority)`);
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-api-key, anthropic-beta, anthropic-version, X-RelayPlane-Bypass, X-RelayPlane-Model'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'x-relayplane-routed-model, x-relayplane-requested-model, x-relayplane-complexity, x-relayplane-provider, x-relayplane-routing-mode'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';

    // === Stats collector endpoint ===
    if (req.method === 'GET' && pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(proxyStatsCollector.getStats()));
      return;
    }

    // === Health endpoint ===
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      const uptimeMs = Date.now() - globalStats.startedAt;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: PROXY_VERSION,
        uptime: Math.floor(uptimeMs / 1000),
        uptimeMs,
        requests: globalStats.totalRequests,
        successRate: globalStats.totalRequests > 0
          ? parseFloat(((globalStats.successfulRequests / globalStats.totalRequests) * 100).toFixed(1))
          : null,
        stats: {
          totalRequests: globalStats.totalRequests,
          successfulRequests: globalStats.successfulRequests,
          failedRequests: globalStats.failedRequests,
          escalations: globalStats.escalations,
          routingCounts: globalStats.routingCounts,
          modelCounts: globalStats.modelCounts,
        },
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/version-status') {
      const latest = await getLatestProxyVersion();
      const status = getVersionStatus(PROXY_VERSION, latest);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
      res.end(JSON.stringify(status));
      return;
    }

    // === Control endpoints ===
    if (pathname.startsWith('/control/')) {
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Control endpoints are localhost-only' }));
        return;
      }
      if (req.method === 'POST' && pathname === '/control/enable') {
        proxyConfig = normalizeProxyConfig({ ...proxyConfig, enabled: true });
        await saveProxyConfig(configPath, proxyConfig);
        startConfigWatcher();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: true }));
        return;
      }

      if (req.method === 'POST' && pathname === '/control/disable') {
        proxyConfig = normalizeProxyConfig({ ...proxyConfig, enabled: false });
        await saveProxyConfig(configPath, proxyConfig);
        startConfigWatcher();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: false }));
        return;
      }

      if (req.method === 'GET' && pathname === '/control/status') {
        const enabled = proxyConfig.enabled !== false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            enabled,
            mode: proxyConfig.mode ?? (enabled ? 'enabled' : 'disabled'),
            modelOverrides: proxyConfig.modelOverrides ?? {},
          })
        );
        return;
      }

      if (req.method === 'GET' && pathname === '/control/stats') {
        const uptimeMs = Date.now() - globalStats.startedAt;
        const avgLatencyMs = globalStats.totalRequests > 0 
          ? Math.round(globalStats.totalLatencyMs / globalStats.totalRequests) 
          : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            uptimeMs,
            uptimeFormatted: `${Math.floor(uptimeMs / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
            totalRequests: globalStats.totalRequests,
            successfulRequests: globalStats.successfulRequests,
            failedRequests: globalStats.failedRequests,
            successRate: globalStats.totalRequests > 0 
              ? `${((globalStats.successfulRequests / globalStats.totalRequests) * 100).toFixed(1)}%`
              : 'N/A',
            avgLatencyMs,
            escalations: globalStats.escalations,
            routingCounts: globalStats.routingCounts,
            modelCounts: globalStats.modelCounts,
          })
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/control/config') {
        try {
          const patch = await readJsonBody(req);
          proxyConfig = mergeProxyConfig(proxyConfig, patch);
          await saveProxyConfig(configPath, proxyConfig);
          startConfigWatcher();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: proxyConfig }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        return;
      }

      // === Budget endpoints ===

      if (req.method === 'GET' && pathname === '/control/budget') {
        const status = budgetManager.getStatus();
        const cfg = budgetManager.getConfig();
        const now = Date.now();
        const weekCutoff = now - 7 * 86400000;
        const monthCutoff = now - 30 * 86400000;
        const weekCost = requestHistory
          .filter(r => new Date(r.timestamp).getTime() >= weekCutoff)
          .reduce((s, r) => s + r.costUsd, 0);
        const monthCost = requestHistory
          .filter(r => new Date(r.timestamp).getTime() >= monthCutoff)
          .reduce((s, r) => s + r.costUsd, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          today_usd: Math.round(status.dailySpend * 10000) / 10000,
          limit_usd: status.dailyLimit,
          pct_used: Math.round(status.dailyPercent * 10) / 10,
          remaining_usd: Math.max(0, Math.round((status.dailyLimit - status.dailySpend) * 10000) / 10000),
          this_week_usd: Math.round(weekCost * 10000) / 10000,
          this_month_usd: Math.round(monthCost * 10000) / 10000,
          enabled: cfg.enabled,
          on_breach: cfg.onBreach,
          alert_thresholds: cfg.alertThresholds,
          hourly_usd: Math.round(status.hourlySpend * 10000) / 10000,
          hourly_limit_usd: status.hourlyLimit,
          hourly_pct_used: Math.round(status.hourlyPercent * 10) / 10,
          breached: status.breached,
          breach_type: status.breachType,
        }));
        return;
      }

      if (req.method === 'POST' && pathname === '/control/budget/set') {
        try {
          const body = await readJsonBody(req) as { dailyUsd?: number };
          const amount = Number(body.dailyUsd);
          if (!body.dailyUsd || isNaN(amount) || amount <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'dailyUsd must be a positive number' }));
            return;
          }
          budgetManager.setLimits({ dailyUsd: amount });
          budgetManager.updateConfig({ enabled: true });
          proxyConfig = normalizeProxyConfig({
            ...proxyConfig,
            budget: { ...proxyConfig.budget, dailyUsd: amount, enabled: true },
          });
          await saveProxyConfig(configPath, proxyConfig);
          startConfigWatcher();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, dailyUsd: amount }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/control/budget/set-alert') {
        try {
          const body = await readJsonBody(req) as { threshold?: number };
          const pct = Number(body.threshold);
          if (!body.threshold || isNaN(pct) || pct <= 0 || pct > 100) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'threshold must be 1-100' }));
            return;
          }
          const current = budgetManager.getConfig();
          const thresholds = [...new Set([...current.alertThresholds, pct])].sort((a, b) => a - b);
          budgetManager.updateConfig({ alertThresholds: thresholds });
          proxyConfig = normalizeProxyConfig({
            ...proxyConfig,
            budget: { ...proxyConfig.budget, alertThresholds: thresholds },
          });
          await saveProxyConfig(configPath, proxyConfig);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, alertThresholds: thresholds }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/control/budget/reset') {
        budgetManager.reset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Daily spend counter reset' }));
        return;
      }

      // === Session Budget endpoints ===

      if (req.method === 'GET' && pathname === '/control/session-budget') {
        const sbQs = url.includes('?') ? url.split('?')[1] ?? '' : '';
        const sbParams = new URLSearchParams(sbQs);
        const sessionId = sbParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId query parameter required' }));
          return;
        }
        const record = budgetManager.getSessionBudget(sessionId);
        if (!record) {
          const cap = budgetManager.getConfig().sessionCapUsd;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sessionId,
            capUsd: cap,
            spentUsd: 0,
            remainingUsd: cap,
            pctUsed: 0,
            modelUsed: '',
            status: 'ok',
          }));
          return;
        }
        const remaining = Math.max(0, record.capUsd - record.spentUsd);
        const pctUsed = record.capUsd > 0 ? (record.spentUsd / record.capUsd) * 100 : 0;
        const status = pctUsed >= 100 ? 'exceeded' : pctUsed >= 80 ? 'warning' : 'ok';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId: record.sessionId,
          capUsd: record.capUsd,
          spentUsd: record.spentUsd,
          remainingUsd: remaining,
          pctUsed: Math.round(pctUsed * 10) / 10,
          modelUsed: record.modelUsed,
          createdAt: new Date(record.createdAt).toISOString(),
          updatedAt: new Date(record.updatedAt).toISOString(),
          status,
        }));
        return;
      }

      if (req.method === 'POST' && pathname === '/control/session-budget/set') {
        try {
          const body = await readJsonBody(req) as { sessionId?: string; capUsd?: number };
          if (!body.sessionId || typeof body.capUsd !== 'number' || !isFinite(body.capUsd) || body.capUsd <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessionId (string) and capUsd (positive number) required' }));
            return;
          }
          budgetManager.setSessionCap(body.sessionId, body.capUsd);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId: body.sessionId, capUsd: body.capUsd }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/control/session-budgets') {
        const slQs = url.includes('?') ? url.split('?')[1] ?? '' : '';
        const slParams = new URLSearchParams(slQs);
        const limitParam = slParams.get('limit');
        const limit = limitParam ? Math.min(50, Math.max(1, parseInt(limitParam, 10) || 50)) : 50;
        const records = budgetManager.listSessionBudgets(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessions: records.map(r => ({
            sessionId: r.sessionId,
            capUsd: r.capUsd,
            spentUsd: r.spentUsd,
            remainingUsd: Math.max(0, r.capUsd - r.spentUsd),
            pctUsed: r.capUsd > 0 ? Math.round((r.spentUsd / r.capUsd) * 1000) / 10 : 0,
            modelUsed: r.modelUsed,
            createdAt: new Date(r.createdAt).toISOString(),
            updatedAt: new Date(r.updatedAt).toISOString(),
            status: r.spentUsd >= r.capUsd ? 'exceeded' : (r.spentUsd / r.capUsd) >= 0.8 ? 'warning' : 'ok',
          })),
          count: records.length,
        }));
        return;
      }

      if (req.method === 'POST' && pathname === '/control/model') {
        try {
          const body = await readJsonBody(req) as { model?: string; reason?: string };
          if (!body.model) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'model required' }));
            return;
          }
          if (body.model.length > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(body.model)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'model must be ≤128 characters and contain only [a-zA-Z0-9._:/-]' }));
            return;
          }
          const previousRouting = proxyConfig.routing;
          const target = body.model;
          // Update all complexity tiers to the requested model
          proxyConfig = normalizeProxyConfig({
            ...proxyConfig,
            routing: {
              ...proxyConfig.routing,
              complexity: {
                enabled: proxyConfig.routing?.complexity?.enabled ?? true,
                simple: target,
                moderate: target,
                complex: target,
              },
            },
          });
          await saveProxyConfig(configPath, proxyConfig);
          startConfigWatcher();
          const prevModel = previousRouting?.complexity?.complex ?? previousRouting?.complexity?.moderate ?? 'unknown';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            switched: true,
            previous: prevModel,
            current: target,
            reason: body.reason ?? '',
          }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/control/kill') {
      try {
        const body = await readJsonBody(req) as { sessionKey?: string; all?: boolean };
        
        if (body.all) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            killed: 0, 
            sessions: [],
            note: 'Local proxy mode: session kill not applicable'
          }));
        } else if (body.sessionKey) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            killed: 1, 
            sessions: [body.sessionKey],
            note: 'Rate limits reset for session'
          }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Provide sessionKey or all=true' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }

    // === Telemetry endpoints for dashboard ===
    if (pathname.startsWith('/v1/telemetry/')) {
      const telemetryPath = pathname.replace('/v1/telemetry/', '');
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);

      if (req.method === 'GET' && telemetryPath === 'stats') {
        const days = parseInt(params.get('days') || '7', 10);
        const cutoff = Date.now() - days * 86400000;
        const recent = requestHistory.filter(r => new Date(r.timestamp).getTime() >= cutoff);
        
        // Model breakdown (keyed by provider/model for disambiguation)
        const modelMap = new Map<string, { count: number; cost: number; provider: string; model: string }>();
        for (const r of recent) {
          const key = `${r.provider || 'unknown'}/${r.targetModel}`;
          const cur = modelMap.get(key) || { count: 0, cost: 0, provider: r.provider || 'unknown', model: r.targetModel };
          cur.count++;
          cur.cost += r.costUsd;
          modelMap.set(key, cur);
        }
        
        // Daily stats
        const dailyMap = new Map<string, { requests: number; cost: number }>();
        for (const r of recent) {
          const date = r.timestamp.slice(0, 10);
          const cur = dailyMap.get(date) || { requests: 0, cost: 0 };
          cur.requests++;
          cur.cost += r.costUsd;
          dailyMap.set(date, cur);
        }

        const totalCost = recent.reduce((s, r) => s + r.costUsd, 0);
        const totalLatency = recent.reduce((s, r) => s + r.latencyMs, 0);
        
        const result = {
          summary: {
            totalCostUsd: totalCost,
            // totalEvents is limited by requestHistory retention/MAX_HISTORY.
            // totalRequests is process-lifetime and continues beyond 10k.
            totalEvents: recent.length,
            totalRequests: globalStats.totalRequests,
            historyLimit: MAX_HISTORY,
            retentionDays: HISTORY_RETENTION_DAYS,
            avgLatencyMs: recent.length ? Math.round(totalLatency / recent.length) : 0,
            successRate: recent.length ? recent.filter(r => r.success).length / recent.length : 0,
          },
          byModel: Array.from(modelMap.entries()).map(([, v]) => ({ model: v.model, provider: v.provider, count: v.count, costUsd: v.cost, savings: 0 })),
          dailyCosts: Array.from(dailyMap.entries()).map(([date, v]) => ({ date, costUsd: v.cost, requests: v.requests })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'GET' && telemetryPath === 'runs') {
        const limit = parseInt(params.get('limit') || '50', 10);
        const offset = parseInt(params.get('offset') || '0', 10);
        const sorted = [...requestHistory].reverse();
        const runs = sorted.slice(offset, offset + limit).map(r => {
          // Savings should reflect routing decisions only — pass same cache tokens to baseline
          // so the cache discount doesn't get counted as "savings from routing"
          const origCost = estimateCost('claude-opus-4-6', r.tokensIn, r.tokensOut, r.cacheCreationTokens || undefined, r.cacheReadTokens || undefined);
          const perRunSavings = Math.max(0, origCost - r.costUsd);
          return {
            id: r.id,
            workflow_name: r.mode,
            mode: r.mode,
            status: r.success ? 'success' : 'error',
            success: r.success,
            started_at: r.timestamp,
            timestamp: r.timestamp,          // used by the run detail view
            model: r.targetModel,
            provider: r.provider,            // used by the run detail view
            routed_to: `${r.provider}/${r.targetModel}`,
            original_model: r.originalModel,
            taskType: r.taskType || 'general',
            complexity: r.complexity || 'simple',
            costUsd: r.costUsd,
            latencyMs: r.latencyMs,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            cacheCreationTokens: r.cacheCreationTokens ?? 0,
            cacheReadTokens: r.cacheReadTokens ?? 0,
            savings: Math.round(perRunSavings * 10000) / 10000,
            escalated: r.escalated,
            error: r.error ?? null,
            statusCode: r.statusCode ?? null,
            agentFingerprint: r.agentFingerprint ?? null,
            agentId: r.agentId ?? null,
            requestContent: r.requestContent ? {
              systemPrompt: r.requestContent.systemPrompt,
              userMessage: r.requestContent.userMessage,
              responsePreview: r.requestContent.responsePreview,
              // fullResponse excluded from list endpoint to keep payloads small
            } : undefined,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runs, pagination: { total: requestHistory.length } }));
        return;
      }

      if (req.method === 'GET' && telemetryPath === 'savings') {
        // Routing savings: cost at same model with no cache vs actual cost
        // Cache savings: what cache hits saved vs paying full input price
        // Baseline: each request at full input price (no cache, no routing)
        let totalActualCost = 0;
        let totalCacheSavings = 0;   // savings from cache hits (Anthropic feature)
        let totalRoutingSavings = 0; // savings from routing to cheaper model
        let hasAnthropicCalls = false;
        const byDayMap = new Map<string, { savedAmount: number; originalCost: number; actualCost: number }>();

        for (const r of requestHistory) {
          const actualCost = r.costUsd;
          totalActualCost += actualCost;

          // Cache savings: full input price vs what was paid with cache
          const fullInputCost = estimateCost(r.targetModel, r.tokensIn + (r.cacheCreationTokens||0) + (r.cacheReadTokens||0), r.tokensOut);
          const cachedCost = r.costUsd;
          const cacheSaved = Math.max(0, fullInputCost - cachedCost);
          totalCacheSavings += cacheSaved;

          // Routing savings: what would this request cost at full Opus price (no cache)
          // vs what the routed model cost (no cache). Only meaningful for Anthropic.
          if (r.provider === 'anthropic') {
            hasAnthropicCalls = true;
            const opusCost = estimateCost('claude-opus-4-6', r.tokensIn, r.tokensOut);
            const modelCost = estimateCost(r.targetModel, r.tokensIn, r.tokensOut);
            const routingSaved = Math.max(0, opusCost - modelCost);
            totalRoutingSavings += routingSaved;
          }

          const date = r.timestamp.slice(0, 10);
          const day = byDayMap.get(date) || { savedAmount: 0, originalCost: 0, actualCost: 0 };
          // Baseline = what this request would cost on Opus with no cache
          const opusNoCacheCost = estimateCost('claude-opus-4-6', r.tokensIn + (r.cacheCreationTokens||0) + (r.cacheReadTokens||0), r.tokensOut);
          day.savedAmount += Math.max(0, opusNoCacheCost - actualCost);
          day.originalCost += opusNoCacheCost;
          day.actualCost += actualCost;
          byDayMap.set(date, day);
        }

        const byDay = Array.from(byDayMap.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, v]) => ({
            date,
            savedAmount: Math.round(v.savedAmount * 10000) / 10000,
            originalCost: Math.round(v.originalCost * 10000) / 10000,
            actualCost: Math.round(v.actualCost * 10000) / 10000,
          }));

        const totalSaved = totalCacheSavings + totalRoutingSavings;
        const baseline = totalActualCost + totalSaved;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          actualCost: Math.round(totalActualCost * 10000) / 10000,
          savedAmount: Math.round(totalSaved * 10000) / 10000,
          savings: Math.round(totalSaved * 10000) / 10000,
          cacheSavings: Math.round(totalCacheSavings * 10000) / 10000,
          routingSavings: Math.round(totalRoutingSavings * 10000) / 10000,
          hasAnthropicCalls,
          potentialSavings: Math.round(baseline * 10000) / 10000,
          total: Math.round(baseline * 10000) / 10000,
          percentage: baseline > 0 ? Math.round((totalSaved / baseline) * 100) : 0,
          byDay,
        }));
        return;
      }

      if (req.method === 'GET' && telemetryPath === 'health') {
        // Calculate per-provider success rates from recent history (last 50 requests per provider)
        const providerStats: Record<string, { success: number; total: number }> = {};
        const recentHistory = requestHistory.slice(-200); // Look at last 200 requests
        
        for (const r of recentHistory) {
          const provider = r.provider || 'unknown';
          if (!providerStats[provider]) {
            providerStats[provider] = { success: 0, total: 0 };
          }
          providerStats[provider].total++;
          if (r.success) {
            providerStats[provider].success++;
          }
        }
        
        const providers: Array<{ provider: string; status: string; latency: number; successRate: number; lastChecked: string }> = [];
        for (const [name, ep] of Object.entries(DEFAULT_ENDPOINTS)) {
          // Skip Ollama from normal key-based health check — it's handled separately
          if (name === 'ollama') continue;
          const hasKey = !!process.env[ep.apiKeyEnv];
          const stats = providerStats[name.toLowerCase()];
          const successRate = stats && stats.total > 0 ? stats.success / stats.total : (hasKey ? 1 : 0);
          
          // Mark as unhealthy if success rate < 80% and has had requests
          let status = 'healthy';
          if (!hasKey) {
            status = 'down';
          } else if (stats && stats.total >= 5 && successRate < 0.8) {
            status = 'degraded';
          }
          
          providers.push({
            provider: name,
            status,
            latency: 0,
            successRate: Math.round(successRate * 100) / 100,
            lastChecked: new Date().toISOString(),
          });
        }

        // Add Ollama status if configured
        if (_activeOllamaConfig && _activeOllamaConfig.enabled !== false) {
          const ollamaStats = providerStats['ollama'];
          const ollamaSuccessRate = ollamaStats && ollamaStats.total > 0 ? ollamaStats.success / ollamaStats.total : 0;
          const ollamaHealth = await checkOllamaHealthCached(_activeOllamaConfig.baseUrl);
          providers.push({
            provider: 'ollama',
            status: ollamaHealth.available ? 'healthy' : 'down',
            latency: ollamaHealth.responseTimeMs ?? 0,
            successRate: ollamaHealth.available ? (ollamaSuccessRate || 1) : 0,
            lastChecked: new Date().toISOString(),
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // === Agent tracking API ===
    // === /api/runs/:id — full request/response content for a single run ===
    const runsIdMatch = pathname.match(/^\/api\/runs\/(.+)$/);
    if (req.method === 'GET' && runsIdMatch) {
      const runId = runsIdMatch[1];
      const run = requestHistory.find(r => r.id === runId);
      if (!run) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: run.id,
        model: run.targetModel,
        provider: run.provider,
        timestamp: run.timestamp,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costUsd: run.costUsd,
        latencyMs: run.latencyMs,
        success: run.success,
        requestContent: run.requestContent,
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/agents') {
      const summaries = getAgentSummaries(requestHistory);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: summaries }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/agents/rename') {
      try {
        const body = await readJsonBody(req);
        const fingerprint = body['fingerprint'] as string;
        const name = body['name'] as string;
        if (!fingerprint || !name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing fingerprint or name' }));
          return;
        }
        const ok = renameAgent(fingerprint, name);
        if (!ok) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }

    // === Dashboard ===
    if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/config') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getConfigDashboardHTML());
      return;
    }

    // === Token pool status endpoint ===
    if (req.method === 'GET' && pathname === '/v1/token-pool/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTokenPool().getStatus()));
      return;
    }

    // === Mesh stats endpoint ===
    // === Ollama status endpoint ===
    if (req.method === 'GET' && pathname === '/v1/ollama/status') {
      const ollamaBaseUrl = _activeOllamaConfig?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
      const health = await checkOllamaHealthCached(ollamaBaseUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: !!_activeOllamaConfig,
        enabled: _activeOllamaConfig?.enabled !== false,
        baseUrl: ollamaBaseUrl,
        health,
        routeWhen: _activeOllamaConfig?.routeWhen ?? null,
        configuredModels: _activeOllamaConfig?.models ?? [],
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/mesh/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(meshHandle.getStats()));
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/mesh/sync') {
      try {
        const result = await meshHandle.forceSync();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sync: result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sync: { error: err.message } }));
      }
      return;
    }

    // === Knowledge stats endpoint ===
    if (req.method === 'GET' && pathname === '/v1/knowledge/stats') {
      try {
        const stats = await getKnowledgeStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/config') {
      try {
        const raw = await fs.promises.readFile(getProxyConfigPath(), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
      return;
    }

    // === Session Intelligence endpoints ===
    if (req.method === 'GET' && (pathname === '/v1/sessions' || pathname === '/v1/sessions/active')) {
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session endpoints are localhost-only' }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/v1/sessions') {
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);
      const rawLimit = parseInt(params.get('limit') || '20', 10);
      const rawDays = parseInt(params.get('days') || '7', 10);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 100);
      const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 7;
      const sessions = getSessions({ limit, days });
      const now = Date.now();
      const activeCutoff = now - 5 * 60 * 1000;
      // Build model_mix per session from episodic_events in osmosis.db
      const modelMixMap = new Map<string, Record<string, number>>();
      try {
        const osmDb = getOsmosisDb();
        if (osmDb && sessions.length > 0) {
          const placeholders = sessions.map(() => '?').join(',');
          const sessionIds = sessions.map(s => s.id);
          const rows = osmDb.prepare(
            `SELECT session_id, model_used, COUNT(*) as cnt
             FROM episodic_events
             WHERE session_id IN (${placeholders})
             GROUP BY session_id, model_used`
          ).all(...sessionIds) as { session_id: string; model_used: string; cnt: number }[];
          for (const row of rows) {
            if (!modelMixMap.has(row.session_id)) modelMixMap.set(row.session_id, {});
            modelMixMap.get(row.session_id)![row.model_used] = row.cnt;
          }
        }
      } catch { /* best-effort */ }
      const result = sessions.map(s => ({
        ...s,
        active: s.last_seen_at >= activeCutoff,
        duration_ms: s.last_seen_at - s.started_at,
        model_mix: modelMixMap.get(s.id) ?? {},
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: result, total: result.length }));
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/sessions/active') {
      const active = getActiveSessions();
      const now = Date.now();
      const result = active.map(s => ({
        ...s,
        active: true,
        duration_ms: s.last_seen_at - s.started_at,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: result, total: result.length }));
      return;
    }

    // === Trace endpoints (CAP 3) ===
    if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/v1/traces' || (pathname ?? '').startsWith('/v1/traces/'))) {
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Trace endpoints are localhost-only' }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/v1/traces') {
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);
      const limit = Math.min(parseInt(params.get('limit') ?? '20', 10) || 20, 100);
      const traceWriter = TraceWriter.getInstance();
      const traces = traceWriter.getRecentTraces(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ traces, total: traces.length }));
      return;
    }

    if (req.method === 'GET' && (pathname ?? '').match(/^\/v1\/traces\/([^/]+)\/graph$/)) {
      const sessionId = (pathname ?? '').split('/')[3] ?? '';
      const traceWriter = TraceWriter.getInstance();
      const graph = traceWriter.getSessionGraph(sessionId);
      if (!graph) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No graph found for session: ${sessionId}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(graph));
      return;
    }

    if (req.method === 'GET' && (pathname ?? '').match(/^\/v1\/traces\/([^/]+)\/events$/)) {
      const traceId = (pathname ?? '').split('/')[3] ?? '';
      const tw = TraceWriter.getInstance();
      const events = tw.getTraceEvents(traceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ traceId, events, total: events.length }));
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/traces/export') {
      try {
        const exportOptions = await readJsonBody(req) as {
          format?: string;
          sessionIds?: string[];
          fromTimestamp?: number;
          toTimestamp?: number;
          includeToolInputs?: boolean;
        };
        const format = exportOptions.format ?? 'jsonl';
        if (!['jsonl', 'csv', 'markdown', 'traceops'].includes(format)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'format must be one of: jsonl, csv, markdown, traceops' }));
          return;
        }
        const tw = TraceWriter.getInstance();
        const exported = await tw.export({
          format: format as 'jsonl' | 'csv' | 'markdown' | 'traceops',
          sessionIds: exportOptions.sessionIds,
          fromTimestamp: exportOptions.fromTimestamp,
          toTimestamp: exportOptions.toTimestamp,
          includeToolInputs: exportOptions.includeToolInputs,
        });
        const contentType = format === 'markdown' ? 'text/markdown' : 'application/x-ndjson';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(exported);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      return;
    }

    // === Memory endpoints (Session 4 — localhost-only) ===
    if ((pathname ?? '').startsWith('/v1/memory')) {
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory endpoints are localhost-only' }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/v1/memory/semantic') {
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);
      const sessionId = params.get('session_id') ?? undefined;
      const limit = Math.min(parseInt(params.get('limit') ?? '20', 10) || 20, 100);
      try {
        const db = getOsmosisDb();
        if (!db) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ atoms: [], total: 0 }));
          return;
        }
        let atoms: unknown[];
        if (sessionId) {
          atoms = db.prepare(
            `SELECT id, type, model, task_type, latency_ms, input_tokens, output_tokens, confidence, observation_count, timestamp, session_id
             FROM knowledge_atoms WHERE session_id = ? ORDER BY confidence DESC, timestamp DESC LIMIT ?`
          ).all(sessionId, limit);
        } else {
          atoms = db.prepare(
            `SELECT id, type, model, task_type, latency_ms, input_tokens, output_tokens, confidence, observation_count, timestamp, session_id
             FROM knowledge_atoms ORDER BY confidence DESC, timestamp DESC LIMIT ?`
          ).all(limit);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ atoms, total: atoms.length }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory query failed' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/memory/episodic') {
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);
      const sessionId = params.get('session_id') ?? undefined;
      const limit = Math.min(parseInt(params.get('limit') ?? '50', 10) || 50, 200);
      try {
        const db = getOsmosisDb();
        if (!db) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: [], total: 0 }));
          return;
        }
        let events: unknown[];
        if (sessionId) {
          events = db.prepare(
            `SELECT id, session_id, event_type, timestamp, duration_ms, model_used, tokens_in, tokens_out, cost_usd, outcome, outcome_detail, trace_id
             FROM episodic_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`
          ).all(sessionId, limit);
        } else {
          events = db.prepare(
            `SELECT id, session_id, event_type, timestamp, duration_ms, model_used, tokens_in, tokens_out, cost_usd, outcome, outcome_detail, trace_id
             FROM episodic_events ORDER BY timestamp DESC LIMIT ?`
          ).all(limit);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, total: events.length }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory query failed' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/memory/procedural') {
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : '';
      const params = new URLSearchParams(queryString);
      const limit = Math.min(parseInt(params.get('limit') ?? '10', 10) || 10, 50);
      try {
        // Read from mesh.db (procedural atom store)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        const meshDbPath = require('node:path').join(getRelayplaneDir(), 'mesh.db');
        let atoms: unknown[] = [];
        try {
          const meshDb = new Database(meshDbPath, { readonly: true });
          atoms = meshDb.prepare(
            `SELECT id, type, observation, confidence, fitness_score, trust_tier, evidence_count, created_at, updated_at
             FROM atoms ORDER BY fitness_score DESC, confidence DESC LIMIT ?`
          ).all(limit);
          meshDb.close();
        } catch { /* mesh.db may not exist yet */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ atoms, total: atoms.length }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Procedural memory query failed' }));
      }
      return;
    }

    // Extract auth context from incoming request
    const ctx = extractRequestContext(req);
    const anthropicEnvKey = process.env['ANTHROPIC_API_KEY'];
    const relayplaneBypass = parseHeaderBoolean(getHeaderValue(req, 'x-relayplane-bypass'));
    const headerModelOverride = getHeaderValue(req, 'x-relayplane-model');
    const relayplaneEnabled = proxyConfig.enabled !== false;
    const recordTelemetry = relayplaneEnabled && !relayplaneBypass;

    // === Token pool: auto-detect incoming token ===
    {
      const incomingToken = ctx.authHeader
        ? ctx.authHeader.replace(/^Bearer\s+/i, '')
        : ctx.apiKeyHeader;
      if (incomingToken) {
        getTokenPool().autoDetect(incomingToken);
      }
    }

    // Determine which Anthropic auth to use based on mode.
    // When the token pool has registered accounts, select the best token from
    // the pool and use it as the effective key (overrides env and passthrough).
    let useAnthropicEnvKey: string | undefined;
    let _poolSelectedToken: string | undefined; // tracks the token chosen from the pool for this request
    if (getTokenPool().size() > 0) {
      const poolToken = getTokenPool().selectToken();
      if (poolToken) {
        _poolSelectedToken = poolToken.apiKey;
        useAnthropicEnvKey = poolToken.apiKey;
      } else {
        // All tokens exhausted — fall back to normal resolution
        useAnthropicEnvKey = anthropicAuthMode === 'passthrough' ? undefined : anthropicEnvKey;
      }
    } else if (anthropicAuthMode === 'env') {
      useAnthropicEnvKey = anthropicEnvKey;
    } else if (anthropicAuthMode === 'passthrough') {
      useAnthropicEnvKey = undefined; // Only use incoming auth
    } else {
      // 'auto': Use incoming auth if present, fallback to env
      // ALWAYS keep env key available — OAuth (sk-ant-oat) doesn't work for all models (e.g. Haiku)
      useAnthropicEnvKey = anthropicEnvKey;
    }

    // === Native Anthropic /v1/messages endpoint (for Claude Code) ===
    if (req.method === 'POST' && (url.endsWith('/v1/messages') || url.includes('/v1/messages?'))) {
      log('Native Anthropic /v1/messages request');
      
      // Check auth
      if (!hasAnthropicAuth(ctx, useAnthropicEnvKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing authentication. Provide Authorization header or set ANTHROPIC_API_KEY.' }));
        return;
      }

      // Read body
      let requestBody: Record<string, unknown>;
      try {
        requestBody = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Extract session ID (X-Claude-Code-Session-Id or synthetic)
      const { sessionId: nativeSessionId, sessionSource: nativeSessionSource } = getSessionId(
        req,
        requestBody['model'] as string | undefined,
      );

      // Extract agent fingerprint and explicit agent ID
      const nativeSystemPrompt = extractSystemPromptFromBody(requestBody);
      const nativeExplicitAgentId = getHeaderValue(req, 'x-relayplane-agent') || undefined;
      let nativeAgentFingerprint: string | undefined;
      if (nativeSystemPrompt) {
        const agentResult = trackAgent(nativeSystemPrompt, 0, nativeExplicitAgentId);
        nativeAgentFingerprint = agentResult.fingerprint;
      }

      const originalModel = requestBody['model'] as string | undefined;
      let requestedModel = headerModelOverride ?? originalModel ?? '';
      if (headerModelOverride) {
        log(`Header model override: ${originalModel ?? 'unknown'} → ${headerModelOverride}`);
      }

      const parsedModel = parseModelSuffix(requestedModel);
      let routingSuffix = parsedModel.suffix;
      requestedModel = parsedModel.baseModel;

      // ── CAP 3: Deterministic Traces — allocate traceId + emit request.start ──
      const nativeTraceId = randomUUID();
      {
        const tw = TraceWriter.getInstance();
        if (tw.isEnabled() && recordTelemetry) {
          const sysHash = nativeSystemPrompt ? sha256Hex(nativeSystemPrompt) : undefined;
          const messages = requestBody['messages'] as unknown[] | undefined;
          const reqTools = Array.isArray(requestBody['tools'])
            ? (requestBody['tools'] as { name?: string }[]).map(t => t?.name ?? '').filter(Boolean)
            : undefined;
          void tw.write(nativeSessionId, nativeTraceId, {
            eventType: 'request.start',
            parentTraceId: getHeaderValue(req, 'x-parent-trace-id') || undefined,
            agentId: getHeaderValue(req, 'x-agent-id') || nativeExplicitAgentId || undefined,
            payload: {
              model: requestedModel,
              messageCount: messages?.length,
              requestedTools: reqTools,
              systemPromptHash: sysHash,
            },
          });
        }
      }

      if (relayplaneEnabled && !relayplaneBypass && requestedModel) {
        const override = proxyConfig.modelOverrides?.[requestedModel];
        if (override) {
          log(`Model override: ${requestedModel} → ${override}`);
          const overrideParsed = parseModelSuffix(override);
          if (!routingSuffix && overrideParsed.suffix) {
            routingSuffix = overrideParsed.suffix;
          }
          requestedModel = overrideParsed.baseModel;
        }
      }

      // Resolve aliases (e.g., relayplane:auto → rp:balanced)
      const resolvedModel = resolveModelAlias(requestedModel);
      if (resolvedModel !== requestedModel) {
        log(`Alias resolution: ${requestedModel} → ${resolvedModel}`);
        requestedModel = resolvedModel;
      }

      if (requestedModel && requestedModel !== originalModel) {
        requestBody['model'] = requestedModel;
      }

      let routingMode: 'auto' | 'cost' | 'fast' | 'quality' | 'passthrough' = 'auto';
      if (!relayplaneEnabled || relayplaneBypass) {
        routingMode = 'passthrough';
      } else if (routingSuffix) {
        routingMode = routingSuffix;
      } else if (requestedModel.startsWith('relayplane:')) {
        if (requestedModel.includes(':cost')) {
          routingMode = 'cost';
        } else if (requestedModel.includes(':fast')) {
          routingMode = 'fast';
        } else if (requestedModel.includes(':quality')) {
          routingMode = 'quality';
        }
        // relayplane:auto stays as 'auto'
      } else if (requestedModel.startsWith('rp:')) {
        if (requestedModel === 'rp:cost' || requestedModel === 'rp:cheap') {
          routingMode = 'cost';
        } else if (requestedModel === 'rp:fast') {
          routingMode = 'fast';
        } else if (requestedModel === 'rp:quality' || requestedModel === 'rp:best') {
          routingMode = 'quality';
        } else if (requestedModel === 'rp:balanced') {
          // rp:balanced uses complexity-based routing (auto mode)
          routingMode = 'auto';
        } else {
          routingMode = 'passthrough';
        }
      } else if (requestedModel === 'auto' || requestedModel === 'relayplane:auto') {
        routingMode = 'auto';
      } else if (requestedModel === 'cost') {
        routingMode = 'cost';
      } else if (requestedModel === 'fast') {
        routingMode = 'fast';
      } else if (requestedModel === 'quality') {
        routingMode = 'quality';
      } else {
        routingMode = 'passthrough';
      }

      // KEY: When routing.mode is "auto", ALWAYS classify and route based on complexity,
      // even when the user sends a specific model like "claude-opus-4-6".
      // This is the core UX: user flips routing.mode to "auto" and the proxy handles the rest.
      if (routingMode === 'passthrough' && (proxyConfig.routing?.mode === 'auto' || proxyConfig.routing?.mode === 'complexity' || proxyConfig.routing?.mode === 'cascade')) {
        routingMode = 'auto';
        log(`Config routing.mode=${proxyConfig.routing?.mode}: overriding passthrough → auto for model ${requestedModel}`);
      }

      const isStreaming = requestBody['stream'] === true;

      // ── Response Cache: check for cached response ──
      const cacheBypass = responseCache.shouldBypass(requestBody);
      let cacheHash: string | undefined;
      if (!cacheBypass) {
        cacheHash = responseCache.computeKey(requestBody);
        const cached = responseCache.get(cacheHash);
        if (cached) {
          try {
            const cachedData = JSON.parse(cached);
            const cacheUsage = (cachedData as any)?.usage;
              const cacheCost = estimateCost(
                requestBody['model'] as string ?? '',
                cacheUsage?.input_tokens ?? 0,
                cacheUsage?.output_tokens ?? 0
              );
              responseCache.recordHit(cacheCost, 0);
              // Replay cached streaming response as SSE
              if (isStreaming && cachedData._relayplaneStreamCache) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-RelayPlane-Cache': 'HIT',
                });
                res.end(cachedData.ssePayload);
              } else {
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'X-RelayPlane-Cache': 'HIT',
                });
                res.end(cached);
              }
              log(`Cache HIT for ${requestBody['model']} (hash: ${cacheHash.slice(0, 8)})`);
              return;
          } catch {
            // Corrupt cache entry, continue to provider
          }
        }
        responseCache.recordMiss();
      } else {
        responseCache.recordBypass();
      }
      // ── End cache check ──

      const messages = Array.isArray(requestBody['messages'])
        ? (requestBody['messages'] as Array<{ role?: string; content?: unknown }>)
        : [];

      let promptText = '';
      let taskType: TaskType = 'general';
      let confidence = 0;
      let complexity: Complexity = 'simple';

      // Always classify — needed for taskType display, telemetry, and routing decisions
      // even in passthrough mode we want accurate task type data
      if (messages.length > 0) {
        promptText = extractMessageText(messages);
        taskType = inferTaskType(promptText);
        confidence = getInferenceConfidence(promptText, taskType);
        complexity = classifyComplexity(messages);
        log(`Inferred task: ${taskType} (confidence: ${confidence.toFixed(2)})`);
      }

      const cascadeConfig = getCascadeConfig(proxyConfig);
      let useCascade =
        routingMode === 'auto' &&
        proxyConfig.routing?.mode === 'cascade' &&
        cascadeConfig.enabled === true;

      let targetModel = '';
      let targetProvider: Provider = 'anthropic';

      // Enable cascade for streaming requests (complexity-based routing)
      if (useCascade && isStreaming) {
        log('Using complexity-based routing for streaming request');
        useCascade = false; // Disable full cascade, use complexity routing instead
        
        let selectedModel: string | null = null;
        if (proxyConfig.routing?.complexity?.enabled) {
          const complexityVal = proxyConfig.routing?.complexity?.[complexity];
          if (complexityVal != null) {
            const parsed = parseComplexityModel(complexityVal);
            selectedModel = `${parsed.provider}/${parsed.model}`;
          }
        } else {
          selectedModel = getCascadeModels(proxyConfig)[0] || getCostModel(proxyConfig);
        }
        
        if (selectedModel) {
          const resolved = resolveConfigModel(selectedModel);
          if (resolved) {
            targetProvider = resolved.provider;
            targetModel = resolved.model;
          }
        }
      }

      if (routingMode === 'passthrough') {
        const resolved = resolveExplicitModel(requestedModel);
        if (!resolved) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(buildModelNotFoundError(requestedModel, getAvailableModelNames())));
          return;
        }
        if (resolved.provider !== 'anthropic') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Native /v1/messages only supports Anthropic models.' }));
          return;
        }
        targetProvider = resolved.provider;
        targetModel = resolved.model;
      } else if (!useCascade) {
        let selectedModel: string | null = null;
        if (routingMode === 'cost') {
          selectedModel = getCostModel(proxyConfig);
        } else if (routingMode === 'fast') {
          selectedModel = getFastModel(proxyConfig);
        } else if (routingMode === 'quality') {
          selectedModel = getQualityModel(proxyConfig);
        } else {
          // Complexity-based routing takes priority when enabled
          if (proxyConfig.routing?.complexity?.enabled) {
            const complexityVal = proxyConfig.routing?.complexity?.[complexity];
            if (complexityVal != null) {
              const parsed = parseComplexityModel(complexityVal);
              selectedModel = `${parsed.provider}/${parsed.model}`;
              log(`Complexity routing: ${complexity} → ${parsed.provider}/${parsed.model}`);
            }
          }
          // Fall back to learned routing rules (non-default only)
          if (!selectedModel) {
            const rule = relay.routing.get(taskType);
            const parsedRule = rule?.preferredModel ? parsePreferredModel(rule.preferredModel) : null;
            if (parsedRule?.provider === 'anthropic' && rule?.source !== 'default') {
              selectedModel = parsedRule.model;
            }
          }
          // Final fallback to DEFAULT_ROUTING
          if (!selectedModel) {
            selectedModel = DEFAULT_ROUTING[taskType].model;
          }
        }

        if (!selectedModel) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to resolve routing model' }));
          return;
        }

        const resolved = resolveConfigModel(selectedModel);
        if (!resolved || resolved.provider !== 'anthropic') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Resolved model is not supported for /v1/messages' }));
          return;
        }
        targetProvider = resolved.provider;
        targetModel = resolved.model;
      }

      // Guard: Sonnet has a 200K standard context window. Requests larger than that
      // require "extra usage" on Max plan, which most users haven't enabled.
      // If we routed to Sonnet but the conversation exceeds 200K tokens, upgrade to Opus
      // so the request doesn't fail. Opus 1M context is included in Max plan.
      if (
        targetProvider === 'anthropic' &&
        targetModel.includes('sonnet') &&
        messages.length > 0
      ) {
        const allText = extractMessageText(messages);
        const estimatedTokens = Math.ceil(allText.length / 4);
        if (estimatedTokens > 180000) { // 180K buffer below 200K limit
          const opusModel = proxyConfig.routing?.complexity?.complex
            ? parseComplexityModel(proxyConfig.routing.complexity.complex).model
            : 'claude-opus-4-6';
          log(`Context guard: ${estimatedTokens} estimated tokens exceeds Sonnet 200K limit → upgrading to ${opusModel}`);
          targetModel = opusModel;
        }
      }

      // Strip 1M context beta header when routing to Sonnet.
      // Sonnet 1M requires "extra usage" on Max plan; without it Anthropic rejects the request.
      // Opus 1M is included in Max plan. Stripping the beta falls back to Sonnet's 200K window.
      let effectiveCtx = ctx;
      if (targetModel.includes('sonnet') && ctx.betaHeaders?.includes('context-1m')) {
        effectiveCtx = {
          ...ctx,
          betaHeaders: ctx.betaHeaders
            .split(',')
            .map(b => b.trim())
            .filter(b => !b.startsWith('context-1m'))
            .join(',') || undefined,
        };
        log(`Stripped 1M context beta from Sonnet request (requires extra usage on Max plan)`);
      }

      if (
        proxyConfig.reliability?.cooldowns?.enabled &&
        !useCascade &&
        !cooldownManager.isAvailable(targetProvider)
      ) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider ${targetProvider} is temporarily cooled down` }));
        return;
      }

      // ── Budget check + auto-downgrade ──
      const budgetExtraHeaders: Record<string, string> = {};
      {
        const budgetCheck = preRequestBudgetCheck(targetModel || requestedModel);
        if (budgetCheck.blocked) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Budget limit exceeded. Request blocked.',
            type: 'budget_exceeded',
          }));
          return;
        }
        if (budgetCheck.downgraded) {
          log(`Budget downgrade: ${targetModel || requestedModel} → ${budgetCheck.model}`);
          targetModel = budgetCheck.model;
          if (requestBody) requestBody['model'] = targetModel;
        }
        Object.assign(budgetExtraHeaders, budgetCheck.headers);
      }
      // ── End budget check ──

      // ── Session budget check (only when X-Claude-Code-Session-Id is present) ──
      let nativeSessionBudgetResult: SessionBudgetCheckResult | null = null;
      if (nativeSessionSource === 'claude-code') {
        nativeSessionBudgetResult = budgetManager.checkSessionBudget(nativeSessionId, targetModel || requestedModel);
        if (!nativeSessionBudgetResult.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'session_budget_exceeded',
            spent: nativeSessionBudgetResult.spent,
            cap: nativeSessionBudgetResult.cap,
            type: 'session_budget_exceeded',
          }));
          return;
        }
        if (nativeSessionBudgetResult.model !== (targetModel || requestedModel)) {
          log(`Session budget downgrade: ${targetModel || requestedModel} → ${nativeSessionBudgetResult.model}`);
          // CAP 3: emit model.switch before we overwrite targetModel
          {
            const tw = TraceWriter.getInstance();
            if (tw.isEnabled() && recordTelemetry) {
              void tw.write(nativeSessionId, nativeTraceId, {
                eventType: 'model.switch',
                payload: {
                  fromModel: targetModel || requestedModel,
                  toModel: nativeSessionBudgetResult.model,
                  switchReason: 'session_budget',
                },
              });
            }
          }
          targetModel = nativeSessionBudgetResult.model;
          if (requestBody) requestBody['model'] = targetModel;
        }
        // CAP 3: emit budget.checkpoint after every budget check
        {
          const tw = TraceWriter.getInstance();
          if (tw.isEnabled() && recordTelemetry) {
            void tw.write(nativeSessionId, nativeTraceId, {
              eventType: 'budget.checkpoint',
              payload: {
                sessionCostUsd: nativeSessionBudgetResult.spent,
                sessionCapUsd: nativeSessionBudgetResult.cap,
                sessionPct:
                  nativeSessionBudgetResult.cap > 0
                    ? nativeSessionBudgetResult.spent / nativeSessionBudgetResult.cap
                    : 0,
              },
            });
          }
        }
      }
      // ── End session budget check ──

      // ── Tool authorization check (deny-by-default, after budget gate) ──
      {
        const reqTools = Array.isArray(requestBody?.['tools'])
          ? (requestBody['tools'] as { name?: string }[]).map(t => t?.name ?? '').filter(Boolean)
          : [];
        if (reqTools.length > 0) {
          const tr = getToolRouter();
          const toolCtx = extractToolContext(
            req.headers as Record<string, string | string[] | undefined>,
            nativeSessionId,
            reqTools,
            tr,
          );
          const authResult = tr.checkTools(toolCtx);
          if (authResult.denied.length > 0) {
            for (const toolName of authResult.denied) {
              tr.recordDenied(nativeSessionId, toolName, 'not_in_active_pack');
            }
            // Emit tool.denied trace event
            const tw = TraceWriter.getInstance();
            if (tw.isEnabled() && recordTelemetry) {
              for (const toolName of authResult.denied) {
                void tw.write(nativeSessionId, nativeTraceId, {
                  eventType: 'tool.denied',
                  payload: { toolName },
                });
              }
            }
            // If ALL requested tools are denied, block the request
            if (authResult.allowed.length === 0) {
              res.writeHead(403, {
                'Content-Type': 'application/json',
                'X-Relay-Tools-Denied': authResult.deniedHeader,
              });
              res.end(JSON.stringify({
                error: 'tool_not_authorized',
                denied: authResult.denied,
                message: 'All requested tools are denied by the active tool pack policy.',
              }));
              return;
            }
          }
          // Strip denied tools from the forwarded request body so the model
          // cannot call them even when only a partial set of tools was denied.
          if (Array.isArray(requestBody['tools'])) {
            const allowedSet = new Set(authResult.allowed);
            requestBody['tools'] = (requestBody['tools'] as { name?: string }[]).filter(
              t => allowedSet.has(t?.name ?? ''),
            );
          }
          // Set response header so callers know which tools were denied
          if (authResult.deniedHeader) {
            // Stash for later use when writing response headers
            budgetExtraHeaders['X-Relay-Tools-Denied'] = authResult.deniedHeader;
          }
        }
      }
      // ── End tool authorization check ──

      // ── Rate limit check ──
      const workspaceId = 'local'; // Local proxy uses single workspace
      try {
        // Pass targetProvider so per-provider limits are applied and limits don't
        // cascade across providers (e.g. Anthropic hitting its cap won't block OpenAI).
        await acquireSlot(workspaceId, targetModel, targetProvider);
      } catch (err) {
        const rlErr = err as RateLimitError;
        console.error(`[RATE LIMIT] ${targetModel}: ${rlErr.message}`);
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(rlErr.retryAfter ?? 60),
          'X-RelayPlane-RateLimit-Limit': String(rlErr.limit),
          'X-RelayPlane-RateLimit-Remaining': '0',
          'X-RelayPlane-RateLimit-Reset': String(Math.ceil(rlErr.resetAt / 1000)),
        });
        res.end(JSON.stringify({
          error: rlErr.message,
          type: 'rate_limit_exceeded',
          retry_after: rlErr.retryAfter ?? 60,
        }));
        return;
      }
      // ── End rate limit check ──

      const startTime = Date.now();
      let nativeResponseData: Record<string, unknown> | undefined;
      let _strippedThinking = false;
      let _strippedBetaFlags: string[] = [];

      try {
        if (useCascade && cascadeConfig) {
          const cascadeResult = await cascadeRequest(
            cascadeConfig,
            async (modelName) => {
              const resolved = resolveConfigModel(modelName);
              if (!resolved) {
                throw new Error(`Invalid cascade model: ${modelName}`);
              }
              if (resolved.provider !== 'anthropic') {
                throw new Error(`Cascade model ${modelName} is not Anthropic-compatible`);
              }
              if (proxyConfig.reliability?.cooldowns?.enabled && !cooldownManager.isAvailable(resolved.provider)) {
                throw new CooldownError(resolved.provider);
              }
              let attemptBody: Record<string, unknown> = { ...requestBody, model: resolved.model };
              if ((isHaikuModel(resolved.model) || isHaikuModel(requestedModel)) && 'thinking' in attemptBody) {
                const { thinking: _t, ...rest } = attemptBody;
                attemptBody = rest;
                _strippedThinking = true;
                log(`Stripped thinking from request (${resolved.model} does not support extended thinking, originally requested: ${requestedModel})`);
              }
              // Hybrid auth: use MAX token for Opus models, API key for others
              const modelAuth = getAuthForModel(resolved.model, proxyConfig.auth, useAnthropicEnvKey);
              if (modelAuth.isMax) {
                log(`Using MAX token for ${resolved.model}`);
              }
              // Log OAT beta flag stripping if applicable
              const cascadeEffectiveToken = ctx.authHeader?.replace(/^Bearer\s+/i, '') ?? ctx.apiKeyHeader ?? modelAuth.apiKey ?? '';
              const cascadeLocalStrippedBeta = cascadeEffectiveToken.startsWith('sk-ant-oat') && ctx.betaHeaders
                ? ctx.betaHeaders.split(',').map(b => b.trim()).filter(b => OAT_UNSUPPORTED_BETA_FLAGS.has(b))
                : [];
              if (cascadeLocalStrippedBeta.length > 0) {
                _strippedBetaFlags = cascadeLocalStrippedBeta;
                log(`Stripped OAT-unsupported beta flags from request: ${cascadeLocalStrippedBeta.join(', ')}`);
              }
              const isCascadeRerouted = resolved.model !== originalModel;
              const providerResponse = await forwardNativeAnthropicRequest(attemptBody, ctx, modelAuth.apiKey, modelAuth.isMax, isCascadeRerouted);
              const responseData = (await providerResponse.json()) as Record<string, unknown>;
              if (!providerResponse.ok) {
                if (proxyConfig.reliability?.cooldowns?.enabled) {
                  cooldownManager.recordFailure(resolved.provider, JSON.stringify(responseData));
                }
                throw new ProviderResponseError(providerResponse.status, responseData);
              }
              if (proxyConfig.reliability?.cooldowns?.enabled) {
                cooldownManager.recordSuccess(resolved.provider);
              }
              return { responseData, provider: resolved.provider, model: resolved.model };
            },
            log
          );

          const cascadeResponseModel = checkResponseModelMismatch(cascadeResult.responseData, cascadeResult.model, cascadeResult.provider, log);
          const cascadeRpHeaders = buildRelayPlaneResponseHeaders(
            cascadeResult.model, originalModel ?? 'unknown', complexity, cascadeResult.provider, 'cascade'
          );
          const cascadeStrippedRpHeaders: Record<string, string> = {};
          if (_strippedThinking) cascadeStrippedRpHeaders['X-RelayPlane-Stripped-Thinking'] = 'true';
          if (_strippedBetaFlags.length > 0) cascadeStrippedRpHeaders['X-RelayPlane-Stripped-Beta'] = _strippedBetaFlags.join(',');
          res.writeHead(200, { 'Content-Type': 'application/json', ...cascadeRpHeaders, ...cascadeStrippedRpHeaders });
          res.end(JSON.stringify(cascadeResult.responseData));
          targetProvider = cascadeResult.provider;
          targetModel = cascadeResult.model;
        } else {
          // Hybrid auth: use MAX token for Opus models, API key for others
          const finalModel = targetModel || requestedModel;
          const modelAuth = getAuthForModel(finalModel, proxyConfig.auth, useAnthropicEnvKey);
          if (modelAuth.isMax) {
            log(`Using MAX token for ${finalModel}`);
          }
          // isRerouted: true when auto-routing changed the model from what the user requested
          const isRerouted = routingMode !== 'passthrough' && finalModel !== originalModel;
          if (isRerouted) {
            log(`Rerouted: ${originalModel} → ${finalModel} (auth fallback enabled)`);
          }
          // Build pool-aware context: when the pool is managing auth, clear incoming
          // auth headers so buildAnthropicHeadersWithAuth uses the pool token instead.
          const _nativeReqCtx: RequestContext = _poolSelectedToken
            ? { ...effectiveCtx, authHeader: undefined, apiKeyHeader: undefined }
            : effectiveCtx;

          // Strip thinking from body when routing to (or from) Haiku models.
          // Haiku does not support extended thinking. Also strip when the original
          // requested model was Haiku but routing.mode overrode it to a different
          // model — the user's intent was a non-thinking model, so thinking params
          // (which may also be malformed, e.g. budget_tokens < 1024) should be dropped.
          let _nativeReqBody: Record<string, unknown> = { ...requestBody, model: finalModel };
          if ((isHaikuModel(finalModel) || isHaikuModel(requestedModel)) && 'thinking' in _nativeReqBody) {
            const { thinking: _t, ...rest } = _nativeReqBody;
            _nativeReqBody = rest;
            _strippedThinking = true;
            log(`Stripped thinking from request (${finalModel} does not support extended thinking, originally requested: ${requestedModel})`);
          }

          // Log OAT beta flag stripping if applicable
          const _nativeEffectiveToken = _poolSelectedToken
            || effectiveCtx.authHeader?.replace(/^Bearer\s+/i, '')
            || effectiveCtx.apiKeyHeader
            || modelAuth.apiKey
            || '';
          const _nativeStrippedBeta = _nativeEffectiveToken.startsWith('sk-ant-oat') && effectiveCtx.betaHeaders
            ? effectiveCtx.betaHeaders.split(',').map(b => b.trim()).filter(b => OAT_UNSUPPORTED_BETA_FLAGS.has(b))
            : [];
          if (_nativeStrippedBeta.length > 0) {
            _strippedBetaFlags = _nativeStrippedBeta;
            log(`Stripped OAT-unsupported beta flags from request: ${_nativeStrippedBeta.join(', ')}`);
          }

          let providerResponse = await forwardNativeAnthropicRequest(
            _nativeReqBody,
            _nativeReqCtx,
            modelAuth.apiKey,
            modelAuth.isMax,
            isRerouted
          );

          // Token pool: on 429, record and retry with next available token
          if (providerResponse.status === 429 && _poolSelectedToken) {
            const _poolRetryAfterHeader = providerResponse.headers.get('retry-after');
            const _poolRetryAfterS = _poolRetryAfterHeader ? parseInt(_poolRetryAfterHeader, 10) : undefined;
            getTokenPool().record429(
              _poolSelectedToken,
              _poolRetryAfterS !== undefined && !isNaN(_poolRetryAfterS) ? _poolRetryAfterS : undefined,
            );
            const _nextPoolToken = getTokenPool().selectToken();
            if (_nextPoolToken) {
              log(`[TokenPool] 429 on token …${_poolSelectedToken.slice(-8)} — retrying with "${_nextPoolToken.label}"`);
              _poolSelectedToken = _nextPoolToken.apiKey;
              const _retryCtx: RequestContext = { ...ctx, authHeader: undefined, apiKeyHeader: undefined };
              providerResponse = await forwardNativeAnthropicRequest(
                _nativeReqBody,
                _retryCtx,
                _nextPoolToken.apiKey,
                _nextPoolToken.isOat,
                isRerouted
              );
            }
          }

          // Token pool: learn rate limits from upstream response headers
          if (_poolSelectedToken && providerResponse.ok) {
            const _upstreamHeaders: Record<string, string | undefined> = {};
            providerResponse.headers.forEach((v, k) => { _upstreamHeaders[k] = v; });
            getTokenPool().recordResponseHeaders(_poolSelectedToken, _upstreamHeaders);
          }

          if (!providerResponse.ok) {
            const errorPayload = (await providerResponse.json()) as Record<string, unknown>;
            if (proxyConfig.reliability?.cooldowns?.enabled) {
              cooldownManager.recordFailure(targetProvider, JSON.stringify(errorPayload));
            }

            // ── Cross-provider cascade for /v1/messages path (GH #38) ──
            if (
              !isStreaming &&
              crossProviderCascade.enabled &&
              crossProviderCascade.shouldCascade(providerResponse.status)
            ) {
              const { result: cascResult, data: cascData } = await crossProviderCascade.execute<Record<string, unknown>>(
                targetProvider,
                targetModel || requestedModel,
                providerResponse.status,
                async (hop: CascadeHop) => {
                  const apiKeyResult = resolveProviderApiKey(hop.provider as Provider, ctx, useAnthropicEnvKey);
                  if (apiKeyResult.error) {
                    return { status: apiKeyResult.error.status, data: apiKeyResult.error.payload as Record<string, unknown> };
                  }
                  // Respect per-provider rate limits before attempting the hop
                  try {
                    await acquireSlot('local', hop.model, hop.provider);
                  } catch {
                    return { status: 429, data: { error: `Local rate limit for ${hop.provider}` } };
                  }
                  // Convert native Anthropic body to ChatRequest for OpenAI-compatible providers
                  const chatReq = convertNativeAnthropicBodyToChatRequest(requestBody, hop.model);
                  const hopResult = await executeNonStreamingProviderRequest(
                    chatReq,
                    hop.provider as Provider,
                    hop.model,
                    apiKeyResult.apiKey,
                    ctx
                  );
                  return { status: hopResult.status, data: hopResult.responseData };
                },
                log
              );

              if (cascResult.success && cascData) {
                // Cascade succeeded — update provider/model and respond
                const cascDurationMs = Date.now() - startTime;
                const cascProvider = cascResult.provider as Provider;
                const cascModel = cascResult.model;
                logRequest(
                  originalModel ?? 'unknown',
                  cascModel,
                  cascProvider,
                  cascDurationMs,
                  true,
                  `${routingMode}+cross-cascade`,
                  undefined,
                  taskType, complexity
                );
                const cascRpHeaders = buildRelayPlaneResponseHeaders(
                  cascModel, originalModel ?? 'unknown', complexity, cascProvider, `${routingMode}+cross-cascade`
                );
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'X-RelayPlane-Cascade-Provider': cascProvider,
                  'X-RelayPlane-Cascade-Model': cascModel,
                  ...cascRpHeaders,
                });
                res.end(JSON.stringify(cascData));
                return;
              }
              // All fallbacks exhausted — fall through to original error response
            }
            // ── End cross-provider cascade ──

            const durationMs = Date.now() - startTime;
            const errMsg = extractProviderErrorMessage(errorPayload, providerResponse.status);
            logRequest(
              originalModel ?? 'unknown',
              targetModel || requestedModel,
              targetProvider,
              durationMs,
              false,
              routingMode,
              undefined,
              taskType, complexity,
              nativeAgentFingerprint, nativeExplicitAgentId,
              errMsg, providerResponse.status
            );
            res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorPayload));
            return;
          }
          if (proxyConfig.reliability?.cooldowns?.enabled) {
            cooldownManager.recordSuccess(targetProvider);
          }

          if (isStreaming) {
            const nativeStreamRpHeaders = buildRelayPlaneResponseHeaders(
              targetModel || requestedModel, originalModel ?? 'unknown', complexity, targetProvider, routingMode
            );
            const nativeStreamStrippedHeaders: Record<string, string> = {};
            if (_strippedThinking) nativeStreamStrippedHeaders['X-RelayPlane-Stripped-Thinking'] = 'true';
            if (_strippedBetaFlags.length > 0) nativeStreamStrippedHeaders['X-RelayPlane-Stripped-Beta'] = _strippedBetaFlags.join(',');
            res.writeHead(providerResponse.status, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-RelayPlane-Cache': cacheBypass ? 'BYPASS' : 'MISS',
              'X-Relay-Trace-Id': nativeTraceId,
              'X-Relay-Memory-Hits': String(countAtomsForSession(nativeSessionId)),
              ...nativeStreamRpHeaders,
              ...nativeStreamStrippedHeaders,
            });
            const reader = providerResponse.body?.getReader();
            let streamTokensIn = 0;
            let streamTokensOut = 0;
            let streamCacheCreation = 0;
            let streamCacheRead = 0;
            // Buffer raw SSE chunks for cache storage
            const rawChunks: string[] = [];
            if (reader) {
              const decoder = new TextDecoder();
              let sseBuffer = '';
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  res.write(chunk);
                  if (cacheHash && !cacheBypass) rawChunks.push(chunk);
                  // Parse SSE events to extract usage from message_delta / message_stop
                  sseBuffer += chunk;
                  const lines = sseBuffer.split('\n');
                  sseBuffer = lines.pop() ?? '';
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      try {
                        const evt = JSON.parse(line.slice(6));
                        // Anthropic: message_delta has usage.output_tokens
                        if (evt.type === 'message_delta' && evt.usage) {
                          streamTokensOut = evt.usage.output_tokens ?? streamTokensOut;
                        }
                        // Anthropic: message_start has usage.input_tokens + cache tokens
                        if (evt.type === 'message_start' && evt.message?.usage) {
                          streamTokensIn = evt.message.usage.input_tokens ?? streamTokensIn;
                          streamCacheCreation = evt.message.usage.cache_creation_input_tokens ?? 0;
                          streamCacheRead = evt.message.usage.cache_read_input_tokens ?? 0;
                        }
                        // OpenAI format: choices with usage
                        if (evt.usage) {
                          streamTokensIn = evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? streamTokensIn;
                          streamTokensOut = evt.usage.completion_tokens ?? evt.usage.output_tokens ?? streamTokensOut;
                        }
                      } catch {
                        // not JSON, skip
                      }
                    }
                  }
                }
              } finally {
                reader.releaseLock();
              }
            }
            // ── Cache: store streaming response as raw SSE payload ──
            if (cacheHash && !cacheBypass && rawChunks.length > 0) {
              const streamPayload = JSON.stringify({
                _relayplaneStreamCache: true,
                ssePayload: rawChunks.join(''),
                usage: { input_tokens: streamTokensIn, output_tokens: streamTokensOut, cache_creation_input_tokens: streamCacheCreation, cache_read_input_tokens: streamCacheRead },
              });
              responseCache.set(cacheHash, streamPayload, {
                model: targetModel || requestedModel,
                tokensIn: streamTokensIn,
                tokensOut: streamTokensOut,
                costUsd: estimateCost(targetModel || requestedModel, streamTokensIn, streamTokensOut, streamCacheCreation || undefined, streamCacheRead || undefined),
                taskType,
              });
              log(`Cache STORE (stream) for ${targetModel || requestedModel} (hash: ${cacheHash.slice(0, 8)})`);
            }
            // Store streaming token counts so telemetry can use them
            nativeResponseData = { usage: { input_tokens: streamTokensIn, output_tokens: streamTokensOut, cache_creation_input_tokens: streamCacheCreation, cache_read_input_tokens: streamCacheRead } } as Record<string, unknown>;
            res.end();
          } else {
            nativeResponseData = await providerResponse.json() as Record<string, unknown>;
            const nativeRespModel = checkResponseModelMismatch(nativeResponseData, targetModel || requestedModel, targetProvider, log);
            const nativeRpHeaders = buildRelayPlaneResponseHeaders(
              targetModel || requestedModel, originalModel ?? 'unknown', complexity, targetProvider, routingMode
            );
            // ── Cache: store non-streaming response ──
            const nativeCacheHeader = cacheBypass ? 'BYPASS' : 'MISS';
            if (cacheHash && !cacheBypass) {
              const nativeRespJson = JSON.stringify(nativeResponseData);
              const nativeUsage = (nativeResponseData as any)?.usage;
              responseCache.set(cacheHash, nativeRespJson, {
                model: targetModel || requestedModel,
                tokensIn: nativeUsage?.input_tokens ?? 0,
                tokensOut: nativeUsage?.output_tokens ?? 0,
                costUsd: estimateCost(targetModel || requestedModel, nativeUsage?.input_tokens ?? 0, nativeUsage?.output_tokens ?? 0, nativeUsage?.cache_creation_input_tokens || undefined, nativeUsage?.cache_read_input_tokens || undefined),
                taskType,
              });
              log(`Cache STORE for ${targetModel || requestedModel} (hash: ${cacheHash.slice(0, 8)})`);
            }
            const nativeStrippedHeaders: Record<string, string> = {};
            if (_strippedThinking) nativeStrippedHeaders['X-RelayPlane-Stripped-Thinking'] = 'true';
            if (_strippedBetaFlags.length > 0) nativeStrippedHeaders['X-RelayPlane-Stripped-Beta'] = _strippedBetaFlags.join(',');
            res.writeHead(providerResponse.status, { 'Content-Type': 'application/json', 'X-RelayPlane-Cache': nativeCacheHeader, 'X-Relay-Trace-Id': nativeTraceId, 'X-Relay-Memory-Hits': String(countAtomsForSession(nativeSessionId)), ...nativeRpHeaders, ...nativeStrippedHeaders });
            res.end(JSON.stringify(nativeResponseData));
          }
        }

        const durationMs = Date.now() - startTime;
        logRequest(
          originalModel ?? 'unknown',
          targetModel || requestedModel,
          targetProvider,
          durationMs,
          true,
          routingMode,
          useCascade && cascadeConfig ? undefined : false,
          taskType, complexity
        );

        // Always extract and persist token counts — this is what the telemetry endpoints read
        // nativeResponseData holds response JSON for non-streaming, or { usage: { input_tokens, output_tokens } }
        // synthesised from SSE events for streaming
        const nativeUsageData = (nativeResponseData as any)?.usage;
        const nativeBaseTokIn = nativeUsageData?.input_tokens ?? nativeUsageData?.prompt_tokens ?? 0;
        const nativeTokOut = nativeUsageData?.output_tokens ?? nativeUsageData?.completion_tokens ?? 0;
        const nativeCacheCreation = nativeUsageData?.cache_creation_input_tokens ?? 0;
        const nativeCacheRead = nativeUsageData?.cache_read_input_tokens ?? 0;
        // Include cache tokens in displayed/recorded token count
        const nativeTokIn = nativeBaseTokIn + nativeCacheCreation + nativeCacheRead;
        // Cost calculation expects inputTokens to include cache tokens when cache params are provided
        const nativeCostUsd = estimateCost(targetModel || requestedModel, nativeTokIn, nativeTokOut, nativeCacheCreation || undefined, nativeCacheRead || undefined);
        // Build request content if logging enabled
        let nativeContentData: RequestContentData | undefined;
        if (isContentLoggingEnabled()) {
          const extracted = extractRequestContent(requestBody, true);
          const responseText = nativeResponseData ? extractResponseText(nativeResponseData, true) : '';
          nativeContentData = {
            ...extracted,
            responsePreview: responseText ? responseText.slice(0, 500) : undefined,
            fullResponse: responseText || undefined,
          };
        }
        updateLastHistoryEntry(
          nativeTokIn,
          nativeTokOut,
          nativeCostUsd,
          undefined,
          nativeCacheCreation || undefined,
          nativeCacheRead || undefined,
          nativeAgentFingerprint,
          nativeExplicitAgentId,
          nativeContentData,
        );

        // Update agent cost now that we know the actual cost
        if (nativeAgentFingerprint && nativeAgentFingerprint !== 'unknown') {
          updateAgentCost(nativeAgentFingerprint, nativeCostUsd);
        }

        // ── Session Intelligence: upsert session record ──
        upsertSession(nativeSessionId, nativeSessionSource, nativeCostUsd, nativeTokIn, nativeTokOut);

        // ── Session 4: Episodic memory write (fire-and-forget) ──
        try {
          writeEpisode(nativeSessionId, {
            eventType: 'model-response',
            modelUsed: targetModel || requestedModel,
            tokensIn: nativeTokIn,
            tokensOut: nativeTokOut,
            costUsd: nativeCostUsd,
            outcome: 'success',
            traceId: nativeTraceId,
            durationMs,
          });
        } catch { /* never block hot path */ }

        // ── CAP 3: Deterministic Traces — emit request.end + finalize ──
        {
          const tw = TraceWriter.getInstance();
          if (tw.isEnabled() && recordTelemetry) {
            const finishReason =
              (nativeResponseData as Record<string, unknown> | undefined)?.['stop_reason'] as string | undefined
              ?? (((nativeResponseData as Record<string, unknown> | undefined)?.['choices'] as Record<string, unknown>[] | undefined)?.[0]?.['finish_reason']) as string | undefined;
            void tw.write(nativeSessionId, nativeTraceId, {
              eventType: 'request.end',
              durationMs,
              payload: {
                modelUsed: targetModel || requestedModel,
                tokensIn: nativeTokIn,
                tokensOut: nativeTokOut,
                costUsd: nativeCostUsd,
                finishReason,
              },
            });
            void tw.finalizeTrace(nativeTraceId, nativeSessionId, {
              costUsd: nativeCostUsd,
              modelUsed: targetModel || requestedModel,
              durationMs,
            });
          }
        }

        // ── Session budget: record spend (fire-and-forget, only for claude-code sessions) ──
        if (nativeSessionSource === 'claude-code') {
          budgetManager.updateSessionBudget(nativeSessionId, nativeCostUsd, targetModel || requestedModel);
        }

        // ── Post-request: budget spend + anomaly detection ──
        postRequestRecord(targetModel || requestedModel, nativeTokIn, nativeTokOut, nativeCostUsd);

        if (recordTelemetry) {
          relay
            .run({
              prompt: promptText.slice(0, 500),
              taskType,
              model: `${targetProvider}:${targetModel || requestedModel}`,
            })
            .then((runResult) => {
              // Backfill token/cost data — relay.run() has no adapters so records NULLs
              relay.patchRunTokens(runResult.runId, nativeTokIn, nativeTokOut, nativeCostUsd);
            })
            .catch(() => {});
          sendCloudTelemetry(taskType, targetModel || requestedModel, nativeTokIn, nativeTokOut, durationMs, true, undefined, originalModel ?? undefined, nativeCacheCreation || undefined, nativeCacheRead || undefined);
          meshCapture(targetModel || requestedModel, targetProvider, taskType, nativeTokIn, nativeTokOut, estimateCost(targetModel || requestedModel, nativeTokIn, nativeTokOut, nativeCacheCreation || undefined, nativeCacheRead || undefined), durationMs, true);
        }
      } catch (err) {
        const durationMs = Date.now() - startTime;
        let catchErrMsg: string;
        let catchErrStatus: number;
        if (err instanceof ProviderResponseError) {
          catchErrMsg = extractProviderErrorMessage(err.payload, err.status);
          catchErrStatus = err.status;
        } else {
          catchErrMsg = err instanceof Error ? err.message : String(err);
          catchErrStatus = 500;
        }
        logRequest(
          originalModel ?? 'unknown',
          targetModel || requestedModel,
          targetProvider,
          durationMs,
          false,
          routingMode,
          undefined,
          taskType, complexity,
          nativeAgentFingerprint, nativeExplicitAgentId,
          catchErrMsg, catchErrStatus
        );
        // ── CAP 3: Deterministic Traces — emit request.end (error) + finalize ──
        {
          const tw = TraceWriter.getInstance();
          if (tw.isEnabled() && recordTelemetry) {
            void tw.write(nativeSessionId, nativeTraceId, {
              eventType: 'request.end',
              durationMs,
              error: { code: String(catchErrStatus), message: catchErrMsg, retryable: catchErrStatus >= 500 },
              payload: { modelUsed: targetModel || requestedModel },
            });
            void tw.finalizeTrace(nativeTraceId, nativeSessionId, { durationMs, modelUsed: targetModel || requestedModel });
          }
        }
        if (recordTelemetry) {
          sendCloudTelemetry(taskType, targetModel || requestedModel, 0, 0, durationMs, false, 0, originalModel ?? undefined);
          meshCapture(targetModel || requestedModel, targetProvider, taskType, 0, 0, 0, durationMs, false, catchErrMsg);
        }
        if (err instanceof ProviderResponseError) {
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.payload));
          return;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
      }
      return;
    }

    // === Pre-flight cost estimation endpoint (Pro-tier) ===
    if (req.method === 'POST' && (url === '/v1/estimate' || url.endsWith('/v1/estimate'))) {
      log('Pre-flight estimate request');

      // --- Per-IP rate limit: 60 requests/minute ---
      // Fix B: Use only the raw socket address — never x-forwarded-for.
      // x-forwarded-for is a client-controlled header and is trivially spoofed;
      // any attacker can send "X-Forwarded-For: 1.2.3.4" to bypass per-IP limits.
      // The socket remoteAddress reflects the actual TCP connection and cannot be faked.
      const clientIp = req.socket?.remoteAddress ?? 'unknown';
      const now = Date.now();
      // Fix C: Delegate rate limit logic to the testable checkEstimateRateLimit() function
      // (extracted in estimate.ts so it can be unit-tested in isolation).
      const rateLimitResult = checkEstimateRateLimit(estimateRateMap, clientIp, now);
      if (!rateLimitResult.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'rate_limit_exceeded', message: 'Too many estimate requests. Limit: 60/minute.' }));
        return;
      }

      // --- Read body with size limit (uses existing MAX_BODY_SIZE helper) ---
      let body: string;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large', message: 'Request body too large (max 10MB)' }));
        return;
      }

      const result = handleEstimateRequest(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    // === Token counting endpoint ===
    if (req.method === 'POST' && url.includes('/v1/messages/count_tokens')) {
      log('Token count request');
      
      if (!hasAnthropicAuth(ctx, useAnthropicEnvKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing authentication' }));
        return;
      }

      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      try {
        const headers = buildAnthropicHeaders(ctx, useAnthropicEnvKey);
        const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
          method: 'POST',
          headers,
          body,
        });
        
        const data = await response.json();
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg }));
      }
      return;
    }

    // === Model list endpoint ===
    if (req.method === 'GET' && url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'relayplane:auto', object: 'model', owned_by: 'relayplane' },
            { id: 'relayplane:cost', object: 'model', owned_by: 'relayplane' },
            { id: 'relayplane:fast', object: 'model', owned_by: 'relayplane' },
            { id: 'relayplane:quality', object: 'model', owned_by: 'relayplane' },
          ],
        })
      );
      return;
    }

    // === OpenAI-compatible /v1/chat/completions endpoint ===
    if (req.method !== 'POST' || !url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Supported: POST /v1/messages, POST /v1/chat/completions, POST /v1/estimate, GET /v1/models' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let request: ChatRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const isStreaming = request.stream === true;

    // Extract session ID for chat/completions
    const { sessionId: chatSessionId, sessionSource: chatSessionSource } = getSessionId(
      req,
      request.model,
    );

    // Extract agent fingerprint for chat/completions
    const chatSystemPrompt = extractSystemPromptFromBody(request as unknown as Record<string, unknown>);
    const chatExplicitAgentId = getHeaderValue(req, 'x-relayplane-agent') || undefined;
    let chatAgentFingerprint: string | undefined;
    if (chatSystemPrompt) {
      const agentResult = trackAgent(chatSystemPrompt, 0, chatExplicitAgentId);
      chatAgentFingerprint = agentResult.fingerprint;
    }

    // ── CAP 3: Deterministic Traces — allocate chatTraceId + emit request.start ──
    const chatTraceId = randomUUID();
    {
      const tw = TraceWriter.getInstance();
      if (tw.isEnabled() && recordTelemetry) {
        const chatSysHash = chatSystemPrompt ? sha256Hex(chatSystemPrompt) : undefined;
        void tw.write(chatSessionId, chatTraceId, {
          eventType: 'request.start',
          parentTraceId: getHeaderValue(req, 'x-parent-trace-id') || undefined,
          agentId: getHeaderValue(req, 'x-agent-id') || chatExplicitAgentId || undefined,
          payload: {
            model: request.model,
            messageCount: request.messages?.length,
            systemPromptHash: chatSysHash,
          },
        });
      }
    }

    // ── Response Cache: check for cached response (chat/completions) ──
    const chatCacheBypass = responseCache.shouldBypass(request as unknown as Record<string, unknown>);
    let chatCacheHash: string | undefined;
    if (!chatCacheBypass) {
      chatCacheHash = responseCache.computeKey(request as unknown as Record<string, unknown>);
      const chatCached = responseCache.get(chatCacheHash);
      if (chatCached) {
        try {
          const chatCachedData = JSON.parse(chatCached);
          const chatCacheUsage = (chatCachedData as any)?.usage;
            const chatCacheCost = estimateCost(
              request.model ?? '',
              chatCacheUsage?.prompt_tokens ?? chatCacheUsage?.input_tokens ?? 0,
              chatCacheUsage?.completion_tokens ?? chatCacheUsage?.output_tokens ?? 0
            );
            responseCache.recordHit(chatCacheCost, 0);
            if (isStreaming && chatCachedData._relayplaneStreamCache) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-RelayPlane-Cache': 'HIT',
              });
              res.end(chatCachedData.ssePayload);
            } else {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-RelayPlane-Cache': 'HIT',
              });
              res.end(chatCached);
            }
            log(`Cache HIT for chat/completions ${request.model} (hash: ${chatCacheHash.slice(0, 8)})`);
            return;
        } catch {
          // Corrupt, continue
        }
      }
      responseCache.recordMiss();
    } else {
      responseCache.recordBypass();
    }
    // ── End cache check ──

    const bypassRouting = !relayplaneEnabled || relayplaneBypass;

    // Extract routing mode from model name
    const originalRequestedModel = request.model;
    let requestedModel = headerModelOverride ?? originalRequestedModel;

    if (headerModelOverride) {
      log(`Header model override: ${originalRequestedModel} → ${headerModelOverride}`);
    }

    if (!requestedModel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing model in request' }));
      return;
    }

    if (!request.messages || !Array.isArray(request.messages)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid messages array in request' }));
      return;
    }

    const parsedModel = parseModelSuffix(requestedModel);
    let routingSuffix = parsedModel.suffix;
    requestedModel = parsedModel.baseModel;

    if (!bypassRouting) {
      const override = proxyConfig.modelOverrides?.[requestedModel];
      if (override) {
        log(`Model override: ${requestedModel} → ${override}`);
        const overrideParsed = parseModelSuffix(override);
        if (!routingSuffix && overrideParsed.suffix) {
          routingSuffix = overrideParsed.suffix;
        }
        requestedModel = overrideParsed.baseModel;
      }
    }

    // Resolve aliases (e.g., relayplane:auto → rp:balanced)
    const resolvedModel = resolveModelAlias(requestedModel);
    if (resolvedModel !== requestedModel) {
      log(`Alias resolution: ${requestedModel} → ${resolvedModel}`);
      requestedModel = resolvedModel;
    }

    let routingMode: 'auto' | 'cost' | 'fast' | 'quality' | 'passthrough' = 'auto';
    let targetModel: string = '';
    let targetProvider: Provider = 'anthropic';

    if (bypassRouting) {
      routingMode = 'passthrough';
    } else if (routingSuffix) {
      routingMode = routingSuffix;
    } else if (requestedModel.startsWith('relayplane:')) {
      if (requestedModel.includes(':cost')) {
        routingMode = 'cost';
      } else if (requestedModel.includes(':fast')) {
        routingMode = 'fast';
      } else if (requestedModel.includes(':quality')) {
        routingMode = 'quality';
      }
      // relayplane:auto stays as 'auto'
    } else if (requestedModel.startsWith('rp:')) {
      if (requestedModel === 'rp:cost' || requestedModel === 'rp:cheap') {
        routingMode = 'cost';
      } else if (requestedModel === 'rp:fast') {
        routingMode = 'fast';
      } else if (requestedModel === 'rp:quality' || requestedModel === 'rp:best') {
        routingMode = 'quality';
      } else if (requestedModel === 'rp:balanced') {
        // rp:balanced uses complexity-based routing (auto mode)
        routingMode = 'auto';
      } else {
        routingMode = 'passthrough';
      }
    } else if (requestedModel === 'auto' || requestedModel === 'relayplane:auto') {
      routingMode = 'auto';
    } else if (requestedModel === 'cost') {
      routingMode = 'cost';
    } else if (requestedModel === 'fast') {
      routingMode = 'fast';
    } else if (requestedModel === 'quality') {
      routingMode = 'quality';
    } else {
      routingMode = 'passthrough';
    }

    // KEY: When routing.mode is "auto", "complexity", or "cascade", ALWAYS classify and route,
    // even when the user sends a specific model like "claude-opus-4-6".
    // This is the core UX: user flips routing.mode and the proxy handles the rest.
    if (routingMode === 'passthrough' && (proxyConfig.routing?.mode === 'auto' || proxyConfig.routing?.mode === 'complexity' || proxyConfig.routing?.mode === 'cascade')) {
      routingMode = 'auto';
      log(`Config routing.mode=${proxyConfig.routing?.mode}: overriding passthrough → auto for model ${requestedModel}`);
    }

    log(`Received request for model: ${requestedModel} (mode: ${routingMode}, stream: ${isStreaming})`);

    let promptText = '';
    let taskType: TaskType = 'general';
    let confidence = 0;
    let complexity: Complexity = 'simple';

    // Always classify — taskType is needed for display, routing decisions, and telemetry
    if (request.messages && request.messages.length > 0) {
      promptText = extractPromptText(request.messages);
      taskType = inferTaskType(promptText);
      confidence = getInferenceConfidence(promptText, taskType);
      complexity = classifyComplexity(request.messages);
      log(`Inferred task: ${taskType} (confidence: ${confidence.toFixed(2)})`);
    }

    const cascadeConfig = getCascadeConfig(proxyConfig);
    let useCascade =
      routingMode === 'auto' &&
      proxyConfig.routing?.mode === 'cascade' &&
      cascadeConfig.enabled === true;

    if (useCascade && isStreaming) {
      log('Cascade disabled for streaming request; using first cascade model');
      useCascade = false;
      const fallbackModel = getCascadeModels(proxyConfig)[0] || getCostModel(proxyConfig);
      const resolvedFallback = resolveConfigModel(fallbackModel);
      if (resolvedFallback) {
        targetProvider = resolvedFallback.provider;
        targetModel = resolvedFallback.model;
      }
    }

    if (routingMode === 'passthrough') {
      const resolved = resolveExplicitModel(requestedModel);
      if (resolved) {
        targetProvider = resolved.provider;
        targetModel = resolved.model;
        log(`Pass-through mode: ${requestedModel} → ${targetProvider}/${targetModel}`);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        if (bypassRouting) {
          const modelError = buildModelNotFoundError(requestedModel, getAvailableModelNames());
          res.end(
            JSON.stringify({
              error: `RelayPlane disabled or bypassed. Use an explicit model instead of ${requestedModel}.`,
              suggestions: modelError.suggestions,
              hint: modelError.hint,
            })
          );
        } else {
          res.end(JSON.stringify(buildModelNotFoundError(requestedModel, getAvailableModelNames())));
        }
        return;
      }
    } else if (!useCascade) {
      let selectedModel: string | null = null;
      if (routingMode === 'cost') {
        selectedModel = getCostModel(proxyConfig);
      } else if (routingMode === 'fast') {
        selectedModel = getFastModel(proxyConfig);
      } else if (routingMode === 'quality') {
        selectedModel = getQualityModel(proxyConfig);
      } else {
        // Complexity-based routing takes priority when enabled
        if (proxyConfig.routing?.complexity?.enabled) {
          const complexityVal = proxyConfig.routing?.complexity?.[complexity];
          if (complexityVal != null) {
            const parsed = parseComplexityModel(complexityVal);
            selectedModel = `${parsed.provider}/${parsed.model}`;
            log(`Complexity routing: ${complexity} → ${parsed.provider}/${parsed.model}`);
          }
        }
        // Fall back to learned routing rules (non-default only)
        if (!selectedModel && !targetModel) {
          const rule = relay.routing.get(taskType);
          if (rule && rule.preferredModel && rule.source !== 'default') {
            const parsedRule = parsePreferredModel(rule.preferredModel);
            if (parsedRule) {
              targetProvider = parsedRule.provider;
              targetModel = parsedRule.model;
              log(`Using learned rule: ${rule.preferredModel}`);
            }
          }
        }
        // Final fallback
        if (!selectedModel && !targetModel) {
          selectedModel = DEFAULT_ROUTING[taskType].model;
        }
      }

      if (selectedModel) {
        const resolved = resolveConfigModel(selectedModel);
        if (resolved) {
          targetProvider = resolved.provider;
          targetModel = resolved.model;
        }
      }

      if (!targetModel) {
        const defaultRoute = DEFAULT_ROUTING[taskType];
        targetProvider = defaultRoute.provider;
        targetModel = defaultRoute.model;
      }
    }

    // Guard: Sonnet 200K context limit — upgrade to Opus for large contexts
    if (
      targetProvider === 'anthropic' &&
      targetModel.includes('sonnet') &&
      request.messages?.length > 0
    ) {
      const allText = extractMessageText(request.messages as Array<{ role?: string; content?: unknown }>);
      const estimatedTokens = Math.ceil(allText.length / 4);
      if (estimatedTokens > 180000) {
        const opusModel = proxyConfig.routing?.complexity?.complex
          ? parseComplexityModel(proxyConfig.routing.complexity.complex).model
          : 'claude-opus-4-6';
        log(`Context guard: ${estimatedTokens} estimated tokens exceeds Sonnet 200K limit → upgrading to ${opusModel}`);
        targetModel = opusModel;
      }
    }

    // Strip 1M context beta header when routing to Sonnet (same as native handler above)
    let effectiveCtx = ctx;
    if (targetModel.includes('sonnet') && ctx.betaHeaders?.includes('context-1m')) {
      effectiveCtx = {
        ...ctx,
        betaHeaders: ctx.betaHeaders
          .split(',')
          .map(b => b.trim())
          .filter(b => !b.startsWith('context-1m'))
          .join(',') || undefined,
      };
      log(`Stripped 1M context beta from Sonnet request (requires extra usage on Max plan)`);
    }

    // ── Ollama routing: intercept before cloud dispatch ──
    if (!useCascade && _activeOllamaConfig && _activeOllamaConfig.enabled !== false) {
      if (targetProvider === 'ollama' || shouldRouteToOllama(_activeOllamaConfig, complexity, taskType, request.model)) {
        // Check Ollama availability before routing
        const ollamaHealth = await checkOllamaHealthCached(_activeOllamaConfig.baseUrl);
        if (ollamaHealth.available) {
          targetProvider = 'ollama';
          targetModel = resolveOllamaModel(targetModel, _activeOllamaConfig);
          log(`Ollama routing: ${complexity}/${taskType} → ollama/${targetModel}`);
        } else {
          log(`Ollama unavailable (${ollamaHealth.error}), falling back to cloud provider`);
        }
      }
    }

    // ── defaultProvider: override provider for all non-cascade cloud routing ──
    // When set, ALL models route to this provider regardless of model prefix.
    // Ollama is excluded — local routing takes priority over defaultProvider.
    if (proxyConfig.defaultProvider && !useCascade && targetProvider !== 'ollama') {
      const originalProvider = targetProvider;
      targetProvider = proxyConfig.defaultProvider as Provider;
      // When routing to OpenRouter (or any aggregator), model names need provider prefixes.
      // Complexity routing produces bare names like 'claude-sonnet-4-6' — OpenRouter needs
      // 'anthropic/claude-sonnet-4-6'. Passthrough mode preserves the original request model,
      // but strips any leading provider-prefix that matches the defaultProvider
      // (e.g. "openrouter/anthropic/claude-opus-4.6" → "anthropic/claude-opus-4.6").
      if (routingMode === 'passthrough') {
        const dpPrefix = (proxyConfig.defaultProvider as string) + '/';
        targetModel = requestedModel.startsWith(dpPrefix)
          ? requestedModel.slice(dpPrefix.length)
          : requestedModel;
      } else {
        // Add provider prefix for bare model names when routing to an aggregator
        targetModel = addProviderPrefix(targetModel, originalProvider);
      }
      log(`defaultProvider override: ${originalProvider} → ${targetProvider} (model: ${targetModel})`);
    }
    // ── End defaultProvider override ──

    if (!useCascade) {
      log(`Routing to: ${targetProvider}/${targetModel}`);
    } else {
      log(`Cascade routing enabled with models: ${cascadeConfig?.models?.join(', ') ?? ''}`);
    }

    const cooldownsEnabled = proxyConfig.reliability?.cooldowns?.enabled === true;
    if (!useCascade && cooldownsEnabled && !cooldownManager.isAvailable(targetProvider)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Provider ${targetProvider} is temporarily cooled down` }));
      return;
    }

    let apiKey: string | undefined;
    if (!useCascade) {
      const apiKeyResult = resolveProviderApiKey(targetProvider, ctx, useAnthropicEnvKey);
      if (apiKeyResult.error) {
        res.writeHead(apiKeyResult.error.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(apiKeyResult.error.payload));
        return;
      }
      apiKey = apiKeyResult.apiKey;
    }

    // ── Budget check + auto-downgrade (chat/completions) ──
    {
      const chatBudgetCheck = preRequestBudgetCheck(targetModel);
      if (chatBudgetCheck.blocked) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Budget limit exceeded. Request blocked.',
          type: 'budget_exceeded',
        }));
        return;
      }
      if (chatBudgetCheck.downgraded) {
        log(`Budget downgrade: ${targetModel} → ${chatBudgetCheck.model}`);
        targetModel = chatBudgetCheck.model;
        request.model = targetModel;
      }
    }
    // ── End budget check ──

    // ── Rate limit check ──
    const chatWorkspaceId = 'local'; // Local proxy uses single workspace
    try {
      // Pass targetProvider so per-provider limits apply and don't cascade across providers.
      await acquireSlot(chatWorkspaceId, targetModel, targetProvider);
    } catch (err) {
      const chatRlErr = err as RateLimitError;
      console.error(`[RATE LIMIT] ${targetModel}: ${chatRlErr.message}`);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(chatRlErr.retryAfter ?? 60),
        'X-RelayPlane-RateLimit-Limit': String(chatRlErr.limit),
        'X-RelayPlane-RateLimit-Remaining': '0',
        'X-RelayPlane-RateLimit-Reset': String(Math.ceil(chatRlErr.resetAt / 1000)),
      });
      res.end(JSON.stringify({
        error: chatRlErr.message,
        type: 'rate_limit_exceeded',
        retry_after: chatRlErr.retryAfter ?? 60,
      }));
      return;
    }
    // ── End rate limit check ──

    const startTime = Date.now();

    // Handle streaming vs non-streaming
    if (isStreaming) {
      await handleStreamingRequest(
        res,
        request,
        targetProvider,
        targetModel,
        apiKey,
        effectiveCtx,
        relay,
        promptText,
        taskType,
        confidence,
        useCascade ? 'cascade' : routingMode,
        recordTelemetry,
        startTime,
        log,
        cooldownManager,
        cooldownsEnabled,
        complexity,
        chatCacheHash,
        chatCacheBypass,
        chatAgentFingerprint,
        chatExplicitAgentId,
        chatSessionId,
        chatSessionSource,
      );
    } else {
      if (useCascade && cascadeConfig) {
        try {
          const cascadeResult = await cascadeRequest(
            cascadeConfig,
            async (modelName) => {
              const resolved = resolveConfigModel(modelName);
              if (!resolved) {
                throw new Error(`Invalid cascade model: ${modelName}`);
              }
              if (cooldownsEnabled && !cooldownManager.isAvailable(resolved.provider)) {
                throw new CooldownError(resolved.provider);
              }
              const apiKeyResult = resolveProviderApiKey(resolved.provider, ctx, useAnthropicEnvKey);
              if (apiKeyResult.error) {
                throw new ProviderResponseError(apiKeyResult.error.status, apiKeyResult.error.payload);
              }
              const result = await executeNonStreamingProviderRequest(
                request,
                resolved.provider,
                resolved.model,
                apiKeyResult.apiKey,
                effectiveCtx
              );
              if (!result.ok) {
                if (cooldownsEnabled) {
                  cooldownManager.recordFailure(resolved.provider, JSON.stringify(result.responseData));
                }
                throw new ProviderResponseError(result.status, result.responseData);
              }
              if (cooldownsEnabled) {
                cooldownManager.recordSuccess(resolved.provider);
              }
              return { responseData: result.responseData, provider: resolved.provider, model: resolved.model };
            },
            log
          );

          const durationMs = Date.now() - startTime;
          let responseData = cascadeResult.responseData;
          const chatCascadeRespModel = checkResponseModelMismatch(responseData, cascadeResult.model, cascadeResult.provider, log);

          // Log cascade request for stats tracking
          logRequest(
            originalRequestedModel ?? 'unknown',
            cascadeResult.model,
            cascadeResult.provider,
            durationMs,
            true,
            'cascade',
            cascadeResult.escalations > 0,
            taskType, complexity
          );
          const cascadeUsage = (responseData as any)?.usage;
          const cascadeTokensIn = cascadeUsage?.input_tokens ?? cascadeUsage?.prompt_tokens ?? 0;
          const cascadeTokensOut = cascadeUsage?.output_tokens ?? cascadeUsage?.completion_tokens ?? 0;
          const cascadeCacheCreation = cascadeUsage?.cache_creation_input_tokens || undefined;
          const cascadeCacheRead = cascadeUsage?.cache_read_input_tokens || undefined;
          const cascadeCost = estimateCost(cascadeResult.model, cascadeTokensIn, cascadeTokensOut, cascadeCacheCreation, cascadeCacheRead);
          updateLastHistoryEntry(cascadeTokensIn, cascadeTokensOut, cascadeCost, chatCascadeRespModel, cascadeCacheCreation, cascadeCacheRead, chatAgentFingerprint, chatExplicitAgentId);
          if (chatAgentFingerprint && chatAgentFingerprint !== 'unknown') updateAgentCost(chatAgentFingerprint, cascadeCost);
          upsertSession(chatSessionId, chatSessionSource, cascadeCost, cascadeTokensIn, cascadeTokensOut);

          // ── Session 4: Episodic memory write (fire-and-forget) ──
          try {
            writeEpisode(chatSessionId, {
              eventType: 'routing-decision',
              modelUsed: cascadeResult.model,
              tokensIn: cascadeTokensIn,
              tokensOut: cascadeTokensOut,
              costUsd: cascadeCost,
              outcome: 'success',
              outcomeDetail: 'cascade',
              traceId: chatTraceId,
              durationMs,
            });
          } catch { /* never block hot path */ }

          // ── CAP 3: Deterministic Traces — emit request.end + finalize (chat cascade) ──
          {
            const tw = TraceWriter.getInstance();
            if (tw.isEnabled() && recordTelemetry) {
              void tw.write(chatSessionId, chatTraceId, {
                eventType: 'request.end',
                durationMs,
                payload: {
                  modelUsed: cascadeResult.model,
                  tokensIn: cascadeTokensIn,
                  tokensOut: cascadeTokensOut,
                  costUsd: cascadeCost,
                },
              });
              void tw.finalizeTrace(chatTraceId, chatSessionId, {
                costUsd: cascadeCost,
                modelUsed: cascadeResult.model,
                durationMs,
              });
            }
          }

          if (recordTelemetry) {
            try {
              const runResult = await relay.run({
                prompt: promptText.slice(0, 500),
                taskType,
                model: `${cascadeResult.provider}:${cascadeResult.model}`,
              });
              // Backfill token/cost data — relay.run() has no adapters so records NULLs
              relay.patchRunTokens(runResult.runId, cascadeTokensIn, cascadeTokensOut, cascadeCost);
              responseData['_relayplane'] = {
                runId: runResult.runId,
                routedTo: `${cascadeResult.provider}/${cascadeResult.model}`,
                taskType,
                confidence,
                durationMs,
                mode: 'cascade',
                escalations: cascadeResult.escalations,
              };
              log(`Completed in ${durationMs}ms, runId: ${runResult.runId}`);
            } catch (err) {
              log(`Failed to record run: ${err}`);
            }
            sendCloudTelemetry(taskType, cascadeResult.model, cascadeTokensIn, cascadeTokensOut, durationMs, true, undefined, originalRequestedModel ?? undefined, cascadeCacheCreation, cascadeCacheRead);
            meshCapture(cascadeResult.model, cascadeResult.provider, taskType, cascadeTokensIn, cascadeTokensOut, cascadeCost, durationMs, true);
          }

          const chatCascadeRpHeaders = buildRelayPlaneResponseHeaders(
            cascadeResult.model, originalRequestedModel ?? 'unknown', complexity, cascadeResult.provider, 'cascade'
          );
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-Relay-Trace-Id': chatTraceId, 'X-Relay-Memory-Hits': String(countAtomsForSession(chatSessionId)), ...chatCascadeRpHeaders });
          res.end(JSON.stringify(responseData));
        } catch (err) {
          const durationMs = Date.now() - startTime;
          let cascadeErrMsg: string;
          let cascadeErrStatus: number;
          if (err instanceof ProviderResponseError) {
            cascadeErrMsg = extractProviderErrorMessage(err.payload, err.status);
            cascadeErrStatus = err.status;
          } else {
            cascadeErrMsg = err instanceof Error ? err.message : String(err);
            cascadeErrStatus = 500;
          }
          logRequest(originalRequestedModel ?? 'unknown', targetModel || 'unknown', targetProvider, durationMs, false, 'cascade', undefined, taskType, complexity, chatAgentFingerprint, chatExplicitAgentId, cascadeErrMsg, cascadeErrStatus);
          if (recordTelemetry) {
            sendCloudTelemetry(taskType, targetModel || 'unknown', 0, 0, durationMs, false, 0, originalRequestedModel ?? undefined);
            meshCapture(targetModel || 'unknown', targetProvider, taskType, 0, 0, 0, durationMs, false, cascadeErrMsg);
          }
          if (err instanceof ProviderResponseError) {
            res.writeHead(err.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.payload));
            return;
          }
          const errorMsg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
        }
      } else {
        res.setHeader('X-Relay-Trace-Id', chatTraceId);
        res.setHeader('X-Relay-Memory-Hits', String(countAtomsForSession(chatSessionId)));
        await handleNonStreamingRequest(
          res,
          request,
          targetProvider,
          targetModel,
          apiKey,
          effectiveCtx,
          relay,
          promptText,
          taskType,
          confidence,
          routingMode,
          recordTelemetry,
          startTime,
          log,
          cooldownManager,
          cooldownsEnabled,
          complexity,
          chatAgentFingerprint,
          chatExplicitAgentId,
          useAnthropicEnvKey, // pass for cross-provider cascade API key resolution (GH #38)
          chatSessionId,
          chatSessionSource,
          chatTraceId,
        );
      }
    }
  });

  // ── Health Watchdog ──
  let watchdogFailures = 0;
  const WATCHDOG_MAX_FAILURES = 3;
  const WATCHDOG_INTERVAL_MS = 15_000; // Must be < WatchdogSec (30s) to avoid false kills
  let watchdogTimer: NodeJS.Timeout | null = null;

  /**
   * sd_notify: write to $NOTIFY_SOCKET for systemd watchdog integration
   */
  function sdNotify(state: string): void {
    const notifySocket = process.env['NOTIFY_SOCKET'];
    if (!notifySocket) return;
    try {
      const dgram = require('node:dgram');
      const client = dgram.createSocket('unix_dgram');
      const buf = Buffer.from(state);
      client.send(buf, 0, buf.length, notifySocket, () => {
        client.close();
      });
    } catch (err) {
      log(`sd_notify error: ${err}`);
    }
  }

  function startWatchdog(): void {
    // Notify systemd we're ready
    sdNotify('READY=1');

    watchdogTimer = setInterval(async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          watchdogFailures = 0;
          // Notify systemd watchdog we're alive
          sdNotify('WATCHDOG=1');
        } else {
          watchdogFailures++;
          console.error(`[RelayPlane] Watchdog: health check returned ${res.status} (failure ${watchdogFailures}/${WATCHDOG_MAX_FAILURES})`);
        }
      } catch (err) {
        watchdogFailures++;
        console.error(`[RelayPlane] Watchdog: health check failed (failure ${watchdogFailures}/${WATCHDOG_MAX_FAILURES}): ${err}`);
      }

      if (watchdogFailures >= WATCHDOG_MAX_FAILURES) {
        console.error('[RelayPlane] CRITICAL: 3 consecutive watchdog failures. Attempting graceful restart...');
        sdNotify('STOPPING=1');
        // Close server and exit — systemd Restart=always will restart us
        server.close(() => {
          process.exit(1);
        });
        // Force exit after 10s if graceful close hangs
        setTimeout(() => process.exit(1), 10_000).unref();
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref();
  }

  // Clean up watchdog on shutdown
  const origHandleShutdown = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    sdNotify('STOPPING=1');
  };
  process.on('SIGINT', origHandleShutdown);
  process.on('SIGTERM', origHandleShutdown);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`RelayPlane proxy listening on http://${host}:${port}`);
      console.log(`  Endpoints:`);
      console.log(`    POST /v1/messages          - Native Anthropic API (Claude Code)`);
      console.log(`    POST /v1/chat/completions  - OpenAI-compatible API`);
      console.log(`    POST /v1/messages/count_tokens - Token counting`);
      console.log(`    GET  /v1/models            - Model list`);
      console.log(`  Models: relayplane:auto, relayplane:cost, relayplane:fast, relayplane:quality`);
      if (proxyConfig.defaultProvider) {
        console.log(`  Providers:`);
        console.log(`    ✓ ${proxyConfig.defaultProvider.charAt(0).toUpperCase() + proxyConfig.defaultProvider.slice(1)} (default provider — all models route here)`);
      }
      console.log(`  Auth: Passthrough for Anthropic, env vars for other providers`);
      console.log(`  Streaming: ✅ Enabled`);
      startWatchdog();
      log('Health watchdog started (30s interval, sd_notify enabled)');
      resolve(server);
    });
  });
}

/**
 * Handle streaming request
 */
async function executeNonStreamingProviderRequest(
  request: ChatRequest,
  targetProvider: Provider,
  targetModel: string,
  apiKey: string | undefined,
  ctx: RequestContext
): Promise<{ responseData: Record<string, unknown>; ok: boolean; status: number }> {
  let providerResponse: Response;
  let responseData: Record<string, unknown>;
  
  switch (targetProvider) {
    case 'anthropic': {
      providerResponse = await forwardToAnthropic(request, targetModel, ctx, apiKey);
      const rawData = (await providerResponse.json()) as AnthropicResponse;
      if (!providerResponse.ok) {
        return { responseData: rawData as Record<string, unknown>, ok: false, status: providerResponse.status };
      }
      responseData = convertAnthropicResponse(rawData);
      break;
    }
    case 'google': {
      providerResponse = await forwardToGemini(request, targetModel, apiKey!);
      const rawData = (await providerResponse.json()) as GeminiResponse;
      if (!providerResponse.ok) {
        return { responseData: rawData as Record<string, unknown>, ok: false, status: providerResponse.status };
      }
      responseData = convertGeminiResponse(rawData, targetModel);
      break;
    }
    case 'xai': {
      providerResponse = await forwardToXAI(request, targetModel, apiKey!);
      responseData = (await providerResponse.json()) as Record<string, unknown>;
      if (!providerResponse.ok) {
        return { responseData, ok: false, status: providerResponse.status };
      }
      break;
    }
    case 'openrouter': case 'deepseek': case 'groq': {
      providerResponse = await forwardToOpenAICompatible(request, targetModel, apiKey!);
      responseData = (await providerResponse.json()) as Record<string, unknown>;
      if (!providerResponse.ok) {
        return { responseData, ok: false, status: providerResponse.status };
      }
      break;
    }
    case 'ollama': {
      const ollamaResult = await forwardToOllama(targetModel, request.messages, {
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        tools: request.tools,
        baseUrl: _activeOllamaConfig?.baseUrl,
        timeoutMs: _activeOllamaConfig?.timeoutMs,
      });
      if (!ollamaResult.success) {
        return {
          responseData: { error: ollamaResult.error },
          ok: false,
          status: ollamaResult.error?.status ?? 502,
        };
      }
      responseData = ollamaResult.data!;
      break;
    }
    default: {
      providerResponse = await forwardToOpenAI(request, targetModel, apiKey!);
      responseData = (await providerResponse.json()) as Record<string, unknown>;
      if (!providerResponse.ok) {
        return { responseData, ok: false, status: providerResponse.status };
      }
    }
  }
  
  return { responseData, ok: true, status: 200 };
}

async function handleStreamingRequest(
  res: http.ServerResponse,
  request: ChatRequest,
  targetProvider: Provider,
  targetModel: string,
  apiKey: string | undefined,
  ctx: RequestContext,
  relay: RelayPlane,
  promptText: string,
  taskType: TaskType,
  confidence: number,
  routingMode: string,
  recordTelemetry: boolean,
  startTime: number,
  log: (msg: string) => void,
  cooldownManager: CooldownManager,
  cooldownsEnabled: boolean,
  complexity: Complexity = 'simple',
  cacheHash?: string,
  cacheBypass?: boolean,
  agentFingerprint?: string,
  agentId?: string,
  sessionId?: string,
  sessionSource?: 'claude-code' | 'synthetic',
): Promise<void> {
  let providerResponse: Response;

  try {
    switch (targetProvider) {
      case 'anthropic':
        // Use auth passthrough for Anthropic
        providerResponse = await forwardToAnthropicStream(request, targetModel, ctx, apiKey);
        break;
      case 'google':
        providerResponse = await forwardToGeminiStream(request, targetModel, apiKey!);
        break;
      case 'xai':
        providerResponse = await forwardToXAIStream(request, targetModel, apiKey!);
        break;
      case 'openrouter': case 'deepseek': case 'groq':
        providerResponse = await forwardToOpenAICompatibleStream(request, targetModel, apiKey!);
        break;
      case 'ollama': {
        // Ollama streaming uses its own handler that converts NDJSON → SSE
        const ollamaStream = await forwardToOllamaStream(targetModel, request.messages, {
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          tools: request.tools,
          baseUrl: _activeOllamaConfig?.baseUrl,
          timeoutMs: _activeOllamaConfig?.timeoutMs,
        });
        if (!ollamaStream.success || !ollamaStream.stream) {
          const durationMs = Date.now() - startTime;
          const errMsg = ollamaStream.error?.message ?? 'Ollama stream failed';
          logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity, agentFingerprint, agentId, errMsg, ollamaStream.error?.status);
          res.writeHead(ollamaStream.error?.status ?? 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: ollamaStream.error }));
          return;
        }
        // Write SSE headers and pipe converted stream
        const relayHeaders = buildRelayPlaneResponseHeaders(targetModel, request.model, complexity, 'ollama', routingMode);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...relayHeaders,
        });
        for await (const chunk of ollamaStream.stream) {
          res.write(chunk);
        }
        const durationMs = Date.now() - startTime;
        logRequest(request.model ?? 'unknown', targetModel, 'ollama', durationMs, true, routingMode, false, taskType, complexity, agentFingerprint, agentId);
        updateLastHistoryEntry(0, 0, 0, targetModel, undefined, undefined, agentFingerprint, agentId);
        if (recordTelemetry) {
          sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, true, 0, request.model ?? undefined);
          meshCapture(targetModel, 'ollama', taskType, 0, 0, 0, durationMs, true);
        }
        res.end();
        return;
      }
      default:
        providerResponse = await forwardToOpenAIStream(request, targetModel, apiKey!);
    }

    if (!providerResponse.ok) {
      const errorData = await providerResponse.json() as Record<string, unknown>;
      if (cooldownsEnabled) {
        cooldownManager.recordFailure(targetProvider, JSON.stringify(errorData));
      }
      const durationMs = Date.now() - startTime;
      const streamErrMsg = extractProviderErrorMessage(errorData, providerResponse.status);
      logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity, agentFingerprint, agentId, streamErrMsg, providerResponse.status);
      if (recordTelemetry) {
        sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, false, 0, request.model ?? undefined);
        meshCapture(targetModel, targetProvider, taskType, 0, 0, 0, durationMs, false, streamErrMsg);
      }
      res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorData));
      return;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (cooldownsEnabled) {
      cooldownManager.recordFailure(targetProvider, errorMsg);
    }
    const durationMs = Date.now() - startTime;
    logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity, agentFingerprint, agentId, errorMsg, 500);
    if (recordTelemetry) {
      sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, false, 0, request.model ?? undefined);
      meshCapture(targetModel, targetProvider, taskType, 0, 0, 0, durationMs, false, errorMsg);
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  // Set SSE headers with RelayPlane routing metadata
  const streamRpHeaders = buildRelayPlaneResponseHeaders(
    targetModel, request.model ?? 'unknown', complexity, targetProvider, routingMode
  );
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...streamRpHeaders,
  });

  // Track token usage from streaming events (including Anthropic prompt cache tokens)
  let streamTokensIn = 0;
  let streamTokensOut = 0;
  let streamCacheCreation = 0;
  let streamCacheRead = 0;
  const shouldCacheStream = !!(cacheHash && !cacheBypass);
  const rawChunks: string[] = [];

  try {
    // Stream the response based on provider format
    switch (targetProvider) {
      case 'anthropic':
        // Convert Anthropic stream to OpenAI format
        for await (const chunk of convertAnthropicStream(providerResponse, targetModel)) {
          res.write(chunk);
          if (shouldCacheStream) rawChunks.push(chunk);
          // Parse OpenAI-format chunks for usage — the converter embeds
          // cache_creation_tokens and cache_read_tokens from message_start.
          try {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                const evt = JSON.parse(line.slice(6));
                if (evt.usage) {
                  streamTokensIn = evt.usage.prompt_tokens ?? streamTokensIn;
                  streamTokensOut = evt.usage.completion_tokens ?? streamTokensOut;
                  streamCacheCreation = evt.usage.cache_creation_tokens ?? streamCacheCreation;
                  streamCacheRead = evt.usage.cache_read_tokens ?? streamCacheRead;
                }
              }
            }
          } catch { /* skip parse errors */ }
        }
        break;
      case 'google':
        // Convert Gemini stream to OpenAI format
        for await (const chunk of convertGeminiStream(providerResponse, targetModel)) {
          res.write(chunk);
          if (shouldCacheStream) rawChunks.push(chunk);
          try {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                const evt = JSON.parse(line.slice(6));
                if (evt.usage) {
                  streamTokensIn = evt.usage.prompt_tokens ?? streamTokensIn;
                  streamTokensOut = evt.usage.completion_tokens ?? streamTokensOut;
                }
              }
            }
          } catch { /* skip parse errors */ }
        }
        break;
      default:
        // xAI, OpenRouter, DeepSeek, Groq, OpenAI all use OpenAI-compatible streaming format
        for await (const chunk of pipeOpenAIStream(providerResponse)) {
          res.write(chunk);
          if (shouldCacheStream) rawChunks.push(chunk);
          try {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                const evt = JSON.parse(line.slice(6));
                if (evt.usage) {
                  streamTokensIn = evt.usage.prompt_tokens ?? streamTokensIn;
                  streamTokensOut = evt.usage.completion_tokens ?? streamTokensOut;
                }
              }
            }
          } catch { /* skip parse errors */ }
        }
    }
  } catch (err) {
    log(`Streaming error: ${err}`);
  }

  // ── Cache: store streaming response ──
  if (shouldCacheStream && cacheHash && rawChunks.length > 0) {
    const responseCache = getResponseCache();
    const streamPayload = JSON.stringify({
      _relayplaneStreamCache: true,
      ssePayload: rawChunks.join(''),
      usage: { input_tokens: streamTokensIn, output_tokens: streamTokensOut, prompt_tokens: streamTokensIn, completion_tokens: streamTokensOut, cache_creation_input_tokens: streamCacheCreation, cache_read_input_tokens: streamCacheRead },
    });
    responseCache.set(cacheHash, streamPayload, {
      model: targetModel,
      tokensIn: streamTokensIn,
      tokensOut: streamTokensOut,
      costUsd: estimateCost(targetModel, streamTokensIn, streamTokensOut, streamCacheCreation || undefined, streamCacheRead || undefined),
      taskType,
    });
    log(`Cache STORE (stream) for chat/completions ${targetModel} (hash: ${cacheHash.slice(0, 8)})`);
  }

  if (cooldownsEnabled) {
    cooldownManager.recordSuccess(targetProvider);
  }

  const durationMs = Date.now() - startTime;

  // Always log the request for stats/telemetry tracking
  logRequest(
    request.model ?? 'unknown',
    targetModel,
    targetProvider,
    durationMs,
    true,
    routingMode,
    undefined,
    taskType, complexity
  );
  // Update token/cost info on the history entry (with cache token discount)
  const streamCost = estimateCost(targetModel, streamTokensIn, streamTokensOut, streamCacheCreation || undefined, streamCacheRead || undefined);
  updateLastHistoryEntry(streamTokensIn, streamTokensOut, streamCost, undefined, streamCacheCreation || undefined, streamCacheRead || undefined, agentFingerprint, agentId);
  if (agentFingerprint && agentFingerprint !== 'unknown') updateAgentCost(agentFingerprint, streamCost);
  if (sessionId && sessionSource) upsertSession(sessionId, sessionSource, streamCost, streamTokensIn, streamTokensOut);

  // ── Session 4: Episodic memory write (fire-and-forget) ──
  if (sessionId) {
    try {
      writeEpisode(sessionId, {
        eventType: 'model-response',
        modelUsed: targetModel,
        tokensIn: streamTokensIn,
        tokensOut: streamTokensOut,
        costUsd: streamCost,
        outcome: 'success',
        durationMs,
      });
    } catch { /* never block hot path */ }
  }

  // ── Post-request: budget spend + anomaly detection ──
  try {
    getBudgetManager().recordSpend(streamCost, targetModel);
    const anomalyResult = getAnomalyDetector().recordAndAnalyze({ model: targetModel, tokensIn: streamTokensIn, tokensOut: streamTokensOut, costUsd: streamCost });
    if (anomalyResult.detected) {
      for (const anomaly of anomalyResult.anomalies) {
        getAlertManager().fireAnomaly(anomaly);
      }
    }
  } catch { /* budget/anomaly should never block */ }

  if (recordTelemetry) {
    // Record the run (non-blocking)
    relay
      .run({
        prompt: promptText.slice(0, 500),
        taskType,
        model: `${targetProvider}:${targetModel}`,
      })
      .then((runResult) => {
        // Backfill token/cost data — relay.run() has no adapters so records NULLs
        relay.patchRunTokens(runResult.runId, streamTokensIn, streamTokensOut, streamCost);
        log(`Completed streaming in ${durationMs}ms, runId: ${runResult.runId}`);
      })
      .catch((err) => {
        log(`Failed to record run: ${err}`);
      });
    sendCloudTelemetry(taskType, targetModel, streamTokensIn, streamTokensOut, durationMs, true, undefined, request.model ?? undefined, streamCacheCreation || undefined, streamCacheRead || undefined);
    meshCapture(targetModel, targetProvider, taskType, streamTokensIn, streamTokensOut, streamCost, durationMs, true);
  }

  res.end();
}

/**
 * Handle non-streaming request
 */
async function handleNonStreamingRequest(
  res: http.ServerResponse,
  request: ChatRequest,
  targetProvider: Provider,
  targetModel: string,
  apiKey: string | undefined,
  ctx: RequestContext,
  relay: RelayPlane,
  promptText: string,
  taskType: TaskType,
  confidence: number,
  routingMode: string,
  recordTelemetry: boolean,
  startTime: number,
  log: (msg: string) => void,
  cooldownManager: CooldownManager,
  cooldownsEnabled: boolean,
  complexity: Complexity = 'simple',
  agentFingerprint?: string,
  agentId?: string,
  /** Anthropic env API key — required for cross-provider cascade API key resolution (GH #38) */
  anthropicEnvKeyForCascade?: string,
  sessionId?: string,
  sessionSource?: 'claude-code' | 'synthetic',
  /** CAP 3: trace ID for deterministic trace write */
  traceId?: string,
): Promise<void> {
  let responseData: Record<string, unknown>;

  try {
    const result = await executeNonStreamingProviderRequest(
      request,
      targetProvider,
      targetModel,
      apiKey,
      ctx
    );
    responseData = result.responseData;
    if (!result.ok) {
      if (cooldownsEnabled) {
        cooldownManager.recordFailure(targetProvider, JSON.stringify(responseData));
      }

      // ── Cross-provider cascade (GH #38) ──
      if (crossProviderCascade.enabled && crossProviderCascade.shouldCascade(result.status)) {
        const { result: cascResult, data: cascData } = await crossProviderCascade.execute<Record<string, unknown>>(
          targetProvider,
          targetModel,
          result.status,
          async (hop: CascadeHop) => {
            const apiKeyResult = resolveProviderApiKey(hop.provider as Provider, ctx, anthropicEnvKeyForCascade);
            if (apiKeyResult.error) {
              return { status: apiKeyResult.error.status, data: apiKeyResult.error.payload as Record<string, unknown> };
            }
            // Respect per-provider rate limits before attempting the hop
            try {
              await acquireSlot('local', hop.model, hop.provider);
            } catch {
              // Rate-limited locally — treat as 429 so cascade continues
              return { status: 429, data: { error: `Local rate limit for ${hop.provider}` } };
            }
            const hopResult = await executeNonStreamingProviderRequest(
              { ...request, model: hop.model },
              hop.provider as Provider,
              hop.model,
              apiKeyResult.apiKey,
              ctx
            );
            return { status: hopResult.status, data: hopResult.responseData };
          },
          log
        );

        if (cascResult.success && cascData) {
          // Update tracking variables to reflect the actual provider/model used
          targetProvider = cascResult.provider as Provider;
          targetModel = cascResult.model;
          responseData = cascData;
          // Fall through to success handling below (don't return early)
        } else {
          // All fallbacks exhausted — return the primary error
          const durationMs = Date.now() - startTime;
          const nsErrMsg = extractProviderErrorMessage(responseData, result.status);
          logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, `${routingMode}+cascade`, undefined, taskType, complexity, agentFingerprint, agentId, nsErrMsg, result.status);
          if (recordTelemetry) {
            sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, false, 0, request.model ?? undefined);
            meshCapture(targetModel, targetProvider, taskType, 0, 0, 0, durationMs, false, nsErrMsg);
          }
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseData));
          return;
        }
      } else {
        // No cascade — return error as-is
        const durationMs = Date.now() - startTime;
        const nsErrMsg = extractProviderErrorMessage(responseData, result.status);
        logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity, agentFingerprint, agentId, nsErrMsg, result.status);
        if (recordTelemetry) {
          sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, false, 0, request.model ?? undefined);
          meshCapture(targetModel, targetProvider, taskType, 0, 0, 0, durationMs, false, nsErrMsg);
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
        return;
      }
      // ── End cross-provider cascade ──
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (cooldownsEnabled) {
      cooldownManager.recordFailure(targetProvider, errorMsg);
    }
    const durationMs = Date.now() - startTime;
    logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity, agentFingerprint, agentId, errorMsg, 500);
    if (recordTelemetry) {
      sendCloudTelemetry(taskType, targetModel, 0, 0, durationMs, false, 0, request.model ?? undefined);
      meshCapture(targetModel, targetProvider, taskType, 0, 0, 0, durationMs, false, errorMsg);
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  if (cooldownsEnabled) {
    cooldownManager.recordSuccess(targetProvider);
  }

  const durationMs = Date.now() - startTime;

  // Check for model mismatch in response
  const nonStreamRespModel = checkResponseModelMismatch(responseData, targetModel, targetProvider, log);

  // Log the successful request
  logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, true, routingMode, undefined, taskType, complexity);
  // Update token/cost info (including Anthropic prompt cache tokens)
  const usage = (responseData as any)?.usage;
  const tokensIn = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cost = estimateCost(targetModel, tokensIn, tokensOut, cacheCreationTokens || undefined, cacheReadTokens || undefined);
  updateLastHistoryEntry(tokensIn, tokensOut, cost, nonStreamRespModel, cacheCreationTokens || undefined, cacheReadTokens || undefined, agentFingerprint, agentId);
  if (agentFingerprint && agentFingerprint !== 'unknown') updateAgentCost(agentFingerprint, cost);
  if (sessionId && sessionSource) upsertSession(sessionId, sessionSource, cost, tokensIn, tokensOut);

  // ── Session 4: Episodic memory write (fire-and-forget) ──
  if (sessionId) {
    try {
      writeEpisode(sessionId, {
        eventType: 'model-response',
        modelUsed: targetModel,
        tokensIn,
        tokensOut,
        costUsd: cost,
        outcome: 'success',
        traceId: traceId ?? undefined,
        durationMs,
      });
    } catch { /* never block hot path */ }
  }

  // ── CAP 3: Deterministic Traces — emit request.end + finalize (chat non-streaming) ──
  if (traceId && sessionId && recordTelemetry) {
    const tw = TraceWriter.getInstance();
    if (tw.isEnabled()) {
      const finishReason = (responseData as Record<string, unknown> | undefined)?.['choices']
        ? ((responseData as Record<string, unknown>)['choices'] as Record<string, unknown>[])[0]?.['finish_reason'] as string | undefined
        : undefined;
      void tw.write(sessionId, traceId, {
        eventType: 'request.end',
        durationMs,
        payload: { modelUsed: targetModel, tokensIn, tokensOut, costUsd: cost, finishReason },
      });
      void tw.finalizeTrace(traceId, sessionId, { costUsd: cost, modelUsed: targetModel, durationMs });
    }
  }

  // ── Post-request: budget spend + anomaly detection ──
  try {
    getBudgetManager().recordSpend(cost, targetModel);
    const anomalyResult = getAnomalyDetector().recordAndAnalyze({ model: targetModel, tokensIn, tokensOut, costUsd: cost });
    if (anomalyResult.detected) {
      for (const anomaly of anomalyResult.anomalies) {
        getAlertManager().fireAnomaly(anomaly);
      }
    }
  } catch { /* budget/anomaly should never block */ }

  if (recordTelemetry) {
    // Record the run in RelayPlane
    try {
      const runResult = await relay.run({
        prompt: promptText.slice(0, 500),
        taskType,
        model: `${targetProvider}:${targetModel}`,
      });
      // Backfill token/cost data — relay.run() has no adapters so records NULLs
      relay.patchRunTokens(runResult.runId, tokensIn, tokensOut, cost);

      // Add routing metadata to response
      responseData['_relayplane'] = {
        runId: runResult.runId,
        routedTo: `${targetProvider}/${targetModel}`,
        taskType,
        confidence,
        durationMs,
        mode: routingMode,
      };

      log(`Completed in ${durationMs}ms, runId: ${runResult.runId}`);
    } catch (err) {
      log(`Failed to record run: ${err}`);
    }
    // Extract token counts from response if available (Anthropic/OpenAI format, including cache)
    const innerUsage = (responseData as any)?.usage;
    const innerTokIn = innerUsage?.input_tokens ?? innerUsage?.prompt_tokens ?? 0;
    const innerTokOut = innerUsage?.output_tokens ?? innerUsage?.completion_tokens ?? 0;
    const innerCacheCreation = innerUsage?.cache_creation_input_tokens ?? 0;
    const innerCacheRead = innerUsage?.cache_read_input_tokens ?? 0;
    sendCloudTelemetry(taskType, targetModel, innerTokIn, innerTokOut, durationMs, true, undefined, undefined, innerCacheCreation || undefined, innerCacheRead || undefined);
    meshCapture(targetModel, targetProvider, taskType, innerTokIn, innerTokOut, cost, durationMs, true);
  }

  // ── Cache: store non-streaming chat/completions response ──
  const chatRespCache = getResponseCache();
  const chatReqAsRecord = request as unknown as Record<string, unknown>;
  const chatCacheBypassLocal = chatRespCache.shouldBypass(chatReqAsRecord);
  let chatCacheHeaderVal: string = chatCacheBypassLocal ? 'BYPASS' : 'MISS';
  if (!chatCacheBypassLocal) {
    const chatHashLocal = chatRespCache.computeKey(chatReqAsRecord);
    chatRespCache.set(chatHashLocal, JSON.stringify(responseData), {
      model: targetModel,
      tokensIn: tokensIn,
      tokensOut: tokensOut,
      costUsd: cost,
      taskType,
    });
    log(`Cache STORE for chat/completions ${targetModel} (hash: ${chatHashLocal.slice(0, 8)})`);
  }

  // Send response with RelayPlane routing headers
  const nonStreamRpHeaders = buildRelayPlaneResponseHeaders(
    targetModel, request.model ?? 'unknown', complexity, targetProvider, routingMode
  );
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-RelayPlane-Cache': chatCacheHeaderVal, ...nonStreamRpHeaders });
  res.end(JSON.stringify(responseData));
}

// Note: CLI entry point is in cli.ts
