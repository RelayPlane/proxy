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
import type { Provider, TaskType } from '@relayplane/core';
import { buildModelNotFoundError } from './utils/model-suggestions.js';
import { recordTelemetry as recordCloudTelemetry, inferTaskType as inferTelemetryTaskType, estimateCost } from './telemetry.js';
import { StatsCollector } from './stats.js';
const PROXY_VERSION: string = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

/** Shared stats collector instance for the proxy server */
export const proxyStatsCollector = new StatsCollector();

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
};

/**
 * Model to provider/model mapping
 */
export const MODEL_MAPPING: Record<string, { provider: Provider; model: string }> = {
  // Anthropic models (using correct API model IDs)
  'claude-opus-4-5': { provider: 'anthropic', model: 'claude-opus-4-20250514' },
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  'claude-3-5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
  'claude-haiku-4-5': { provider: 'anthropic', model: 'claude-haiku-4-5-20250514' },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5-20250514' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-20250514' },
  // OpenAI models
  'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
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
 * These provide semantic shortcuts for common use cases
 */
export const SMART_ALIASES: Record<string, { provider: Provider; model: string }> = {
  // Best quality model — via OpenRouter (no separate Anthropic key needed)
  'rp:best': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' },
  // Fast/cheap model for simple tasks
  'rp:fast': { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku' },
  'rp:cheap': { provider: 'openrouter', model: 'google/gemini-2.0-flash-001' },
  // Balanced model for general use
  'rp:balanced': { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku' },
};

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
): void {
  try {
    const cost = costUsd ?? estimateCost(model, tokensIn, tokensOut);
    recordCloudTelemetry({
      task_type: taskType,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Math.round(latencyMs),
      success,
      cost_usd: cost,
      requested_model: requestedModel,
    });
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
 * Default routing based on task type
 * Uses Haiku 3.5 for cost optimization, upgrades based on learned rules
 */
const DEFAULT_ROUTING: Record<TaskType, { provider: Provider; model: string }> = {
  code_generation: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  code_review: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  summarization: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  analysis: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  creative_writing: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  data_extraction: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  translation: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  question_answering: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  general: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
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
  simple: string;
  moderate: string;
  complex: string;
}

interface RoutingConfig {
  mode: 'standard' | 'cascade';
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
  taskType?: string;
  complexity?: string;
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
  complexity?: string
): void {
  const timestamp = new Date().toISOString();
  const status = success ? '✓' : '✗';
  const escalateTag = escalated ? ' [ESCALATED]' : '';
  console.log(
    `[RelayPlane] ${timestamp} ${status} ${originalModel} → ${provider}/${targetModel} (${mode}) ${latencyMs}ms${escalateTag}`
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
  };
  requestHistory.push(entry);
  if (requestHistory.length > MAX_HISTORY) {
    requestHistory.shift();
  }
  bufferHistoryEntry(entry);
}

/** Update the most recent history entry with token/cost info */
function updateLastHistoryEntry(tokensIn: number, tokensOut: number, costUsd: number): void {
  if (requestHistory.length > 0) {
    const last = requestHistory[requestHistory.length - 1]!;
    last.tokensIn = tokensIn;
    last.tokensOut = tokensOut;
    last.costUsd = costUsd;
  }
}

const DEFAULT_PROXY_CONFIG: RelayPlaneProxyConfigFile = {
  enabled: true,
  modelOverrides: {},
  routing: {
    mode: 'cascade',
    cascade: {
      enabled: true,
      models: [
        'claude-3-5-haiku-20241022',
        'claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
      ],
      escalateOn: 'uncertainty',
      maxEscalations: 1,
    },
    complexity: {
      enabled: true,
      simple: 'claude-3-5-haiku-20241022',
      moderate: 'claude-sonnet-4-20250514',
      complex: 'claude-opus-4-20250514',
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

export function classifyComplexity(messages: Array<{ content?: unknown }>): Complexity {
  const text = extractMessageText(messages).toLowerCase();
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
 * Build Anthropic headers with hybrid auth support
 * MAX tokens (sk-ant-oat*) use Authorization: Bearer header
 * API keys (sk-ant-api*) use x-api-key header
 */
function buildAnthropicHeadersWithAuth(
  ctx: RequestContext,
  apiKey?: string,
  isMaxToken?: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  // Auth: prefer incoming auth for passthrough
  if (ctx.authHeader) {
    headers['Authorization'] = ctx.authHeader;
  } else if (ctx.apiKeyHeader) {
    headers['x-api-key'] = ctx.apiKeyHeader;
  } else if (apiKey) {
    // MAX tokens (OAuth) use Authorization: Bearer, API keys use x-api-key
    if (isMaxToken || apiKey.startsWith('sk-ant-oat')) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers['x-api-key'] = apiKey;
    }
  }

  // Pass through beta headers
  if (ctx.betaHeaders) {
    headers['anthropic-beta'] = ctx.betaHeaders;
  }

  return headers;
}

/**
 * Build Anthropic headers with auth passthrough support
 * 
 * Auth priority:
 * 1. Incoming Authorization header (Bearer token from Claude Code OAuth)
 * 2. Incoming x-api-key header 
 * 3. ANTHROPIC_API_KEY env var (or MAX token for Opus models)
 */
function buildAnthropicHeaders(
  ctx: RequestContext,
  envApiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  // Auth: prefer incoming auth for passthrough, fallback to env
  if (ctx.authHeader) {
    // Extract the token from "Bearer <token>"
    const token = ctx.authHeader.replace(/^Bearer\s+/i, '');
    // MAX tokens (sk-ant-oat*) use Authorization: Bearer, API keys use x-api-key
    if (token.startsWith('sk-ant-oat')) {
      headers['Authorization'] = ctx.authHeader;
    } else {
      // Regular API keys should use x-api-key header
      headers['x-api-key'] = token;
    }
  } else if (ctx.apiKeyHeader) {
    // Direct x-api-key header
    headers['x-api-key'] = ctx.apiKeyHeader;
  } else if (envApiKey) {
    // Fallback to env var
    headers['x-api-key'] = envApiKey;
  }

  // Pass through beta headers (prompt caching, extended thinking, etc.)
  if (ctx.betaHeaders) {
    headers['anthropic-beta'] = ctx.betaHeaders;
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
  isMaxToken?: boolean
): Promise<Response> {
  const headers = buildAnthropicHeadersWithAuth(ctx, envApiKey, isMaxToken);

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
        parameters: t.function.parameters || {}
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
        parameters: t.function.parameters || {}
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
      // Pass through input token count from message_start
      const msgUsage = msg?.['usage'] as Record<string, unknown> | undefined;
      if (msgUsage) {
        (baseChunk as Record<string, unknown>)['usage'] = {
          prompt_tokens: msgUsage['input_tokens'] ?? 0,
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
 * Resolve explicit model name to provider and model
 * Handles direct model names like "claude-3-5-sonnet-latest" or "gpt-4o"
 */
function resolveExplicitModel(
  modelName: string
): { provider: Provider; model: string } | null {
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

  // Provider-prefixed format: "anthropic/claude-3-5-sonnet-latest"
  if (modelName.includes('/')) {
    const [provider, model] = modelName.split('/');
    const validProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'deepseek', 'groq', 'local'];
    if (provider && model && validProviders.includes(provider as Provider)) {
      return { provider: provider as Provider, model };
    }
  }

  return null;
}

function resolveConfigModel(modelName: string): { provider: Provider; model: string } | null {
  return resolveExplicitModel(modelName) ?? parsePreferredModel(modelName);
}

function extractResponseText(responseData: Record<string, unknown>): string {
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
    return { apiKey: envApiKey };
  }

  const apiKeyEnv = DEFAULT_ENDPOINTS[provider]?.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
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
  return { apiKey };
}

function getCascadeModels(config: RelayPlaneProxyConfigFile): string[] {
  return config.routing?.cascade?.models ?? [];
}

function getCascadeConfig(config: RelayPlaneProxyConfigFile): CascadeConfig {
  const c = config.routing?.cascade;
  return {
    enabled: c?.enabled ?? true,
    models: c?.models ?? ['claude-3-5-haiku-20241022', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
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

function getCostModel(config: RelayPlaneProxyConfigFile): string {
  return (
    config.routing?.complexity?.simple ||
    config.routing?.cascade?.models?.[0] ||
    'claude-3-5-haiku-20241022'
  );
}

function getFastModel(config: RelayPlaneProxyConfigFile): string {
  return (
    config.routing?.complexity?.simple ||
    config.routing?.cascade?.models?.[0] ||
    'claude-3-5-haiku-20241022'
  );
}

function getQualityModel(config: RelayPlaneProxyConfigFile): string {
  return (
    config.routing?.complexity?.complex ||
    config.routing?.cascade?.models?.[config.routing?.cascade?.models?.length ? config.routing.cascade.models.length - 1 : 0] ||
    process.env['RELAYPLANE_QUALITY_MODEL'] ||
    'claude-sonnet-4-20250514'
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
      const text = extractResponseText(responseData);
      
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
*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0b0d;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;max-width:1200px;margin:0 auto}
a{color:#34d399}h1{font-size:1.5rem;font-weight:600}
.header{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid #1e293b;margin-bottom:24px}
.header .meta{font-size:.8rem;color:#64748b}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.card{background:#111318;border:1px solid #1e293b;border-radius:12px;padding:20px}
.card .label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card .value{font-size:1.75rem;font-weight:700}.green{color:#34d399}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#64748b;font-weight:500;padding:8px 12px;border-bottom:1px solid #1e293b;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
td{padding:8px 12px;border-bottom:1px solid #111318}
.section{margin-bottom:32px}.section h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:#94a3b8}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dot.up{background:#34d399}.dot.warn{background:#fbbf24}.dot.down{background:#ef4444}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75rem;font-weight:500}
.badge.ok{background:#052e1633;color:#34d399}.badge.err{background:#2d0a0a;color:#ef4444}
.badge.tt-code{background:#1e3a5f;color:#60a5fa}.badge.tt-analysis{background:#3b1f6e;color:#a78bfa}.badge.tt-summarization{background:#1a3a2a;color:#6ee7b7}.badge.tt-qa{background:#3a2f1e;color:#fbbf24}.badge.tt-general{background:#1e293b;color:#94a3b8}
.badge.cx-simple{background:#052e1633;color:#34d399}.badge.cx-moderate{background:#2d2a0a;color:#fbbf24}.badge.cx-complex{background:#2d0a0a;color:#ef4444}
@media(max-width:768px){.col-tt,.col-cx{display:none}}
.prov{display:flex;gap:16px;flex-wrap:wrap}.prov-item{display:flex;align-items:center;font-size:.85rem;background:#111318;padding:8px 14px;border-radius:8px;border:1px solid #1e293b}
</style></head><body>
<div class="header"><div><h1>⚡ RelayPlane Dashboard</h1></div><div class="meta"><span id="ver"></span> · up <span id="uptime"></span> · refreshes every 5s</div></div>
<div class="cards">
  <div class="card"><div class="label">Total Requests</div><div class="value" id="totalReq">—</div></div>
  <div class="card"><div class="label">Total Cost</div><div class="value" id="totalCost">—</div></div>
  <div class="card"><div class="label">Savings</div><div class="value green" id="savings">—</div></div>
  <div class="card"><div class="label">Avg Latency</div><div class="value" id="avgLat">—</div></div>
</div>
<div class="section"><h2>Model Breakdown</h2>
<table><thead><tr><th>Model</th><th>Requests</th><th>Cost</th><th>% of Total</th></tr></thead><tbody id="models"></tbody></table></div>
<div class="section"><h2>Provider Status</h2><div class="prov" id="providers"></div></div>
<div class="section"><h2>Recent Runs</h2>
<table><thead><tr><th>Time</th><th>Model</th><th class="col-tt">Task Type</th><th class="col-cx">Complexity</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th><th>Latency</th><th>Status</th></tr></thead><tbody id="runs"></tbody></table></div>
<script>
const $ = id => document.getElementById(id);
function fmt(n,d=2){return typeof n==='number'?n.toFixed(d):'-'}
function fmtTime(s){const d=new Date(s);return d.toLocaleTimeString()}
function dur(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m+'m'}
async function load(){
  try{
    const [health,stats,runsR,sav,provH]=await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/v1/telemetry/stats').then(r=>r.json()),
      fetch('/v1/telemetry/runs?limit=20').then(r=>r.json()),
      fetch('/v1/telemetry/savings').then(r=>r.json()),
      fetch('/v1/telemetry/health').then(r=>r.json())
    ]);
    $('ver').textContent='v'+health.version;
    $('uptime').textContent=dur(health.uptime);
    const total=stats.summary?.totalEvents||0;
    $('totalReq').textContent=total;
    $('totalCost').textContent='$'+fmt(stats.summary?.totalCostUsd??0,4);
    $('savings').textContent=(sav.percentage??0)+'%';
    $('avgLat').textContent=(stats.summary?.avgLatencyMs??0)+'ms';
    $('models').innerHTML=(stats.byModel||[]).map(m=>
      '<tr><td>'+m.model+'</td><td>'+m.count+'</td><td>$'+fmt(m.costUsd,4)+'</td><td>'+fmt(total>0?m.count/total*100:0,1)+'%</td></tr>'
    ).join('')||'<tr><td colspan=4 style="color:#64748b">No data yet</td></tr>';
    function ttCls(t){const m={code_generation:'tt-code',analysis:'tt-analysis',summarization:'tt-summarization',question_answering:'tt-qa'};return m[t]||'tt-general'}
    function cxCls(c){const m={simple:'cx-simple',moderate:'cx-moderate',complex:'cx-complex'};return m[c]||'cx-simple'}
    $('runs').innerHTML=(runsR.runs||[]).map(r=>
      '<tr><td>'+fmtTime(r.started_at)+'</td><td>'+r.model+'</td><td class="col-tt"><span class="badge '+ttCls(r.taskType)+'">'+(r.taskType||'general').replace(/_/g,' ')+'</span></td><td class="col-cx"><span class="badge '+cxCls(r.complexity)+'">'+(r.complexity||'simple')+'</span></td><td>'+(r.tokensIn||0)+'</td><td>'+(r.tokensOut||0)+'</td><td>$'+fmt(r.costUsd,4)+'</td><td>'+r.latencyMs+'ms</td><td><span class="badge '+(r.status==='success'?'ok':'err')+'">'+r.status+'</span></td></tr>'
    ).join('')||'<tr><td colspan=9 style="color:#64748b">No runs yet</td></tr>';
    $('providers').innerHTML=(provH.providers||[]).map(p=>{
      const dotClass = p.status==='healthy'?'up':(p.status==='degraded'?'warn':'down');
      const rate = p.successRate!==undefined?(' '+Math.round(p.successRate*100)+'%'):'';
      return '<div class="prov-item"><span class="dot '+dotClass+'"></span>'+p.provider+rate+'</div>';
    }).join('');
  }catch(e){console.error(e)}
}
load();setInterval(load,5000);
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

  // Load persistent history from disk
  loadHistoryFromDisk();

  // Flush history on shutdown
  const handleShutdown = () => {
    shutdownHistory();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  const configPath = getProxyConfigPath();
  let proxyConfig = await loadProxyConfig(configPath, log);
  const cooldownManager = new CooldownManager(getCooldownConfig(proxyConfig));

  let configWatcher: fs.FSWatcher | null = null;
  let configReloadTimer: NodeJS.Timeout | null = null;

  const reloadConfig = async () => {
    proxyConfig = await loadProxyConfig(configPath, log);
    cooldownManager.updateConfig(getCooldownConfig(proxyConfig));
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
  const clearedCount = relay.routing.clearDefaultRules();
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

    // === Control endpoints ===
    if (pathname.startsWith('/control/')) {
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
        
        // Model breakdown
        const modelMap = new Map<string, { count: number; cost: number }>();
        for (const r of recent) {
          const key = r.targetModel;
          const cur = modelMap.get(key) || { count: 0, cost: 0 };
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
            totalEvents: recent.length,
            avgLatencyMs: recent.length ? Math.round(totalLatency / recent.length) : 0,
            successRate: recent.length ? recent.filter(r => r.success).length / recent.length : 0,
          },
          byModel: Array.from(modelMap.entries()).map(([model, v]) => ({ model, count: v.count, costUsd: v.cost, savings: 0 })),
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
          const origCost = estimateCost('claude-opus-4-20250514', r.tokensIn, r.tokensOut);
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
            savings: Math.round(perRunSavings * 10000) / 10000,
            escalated: r.escalated,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runs, pagination: { total: requestHistory.length } }));
        return;
      }

      if (req.method === 'GET' && telemetryPath === 'savings') {
        // Savings = cost if everything ran on Opus - actual cost
        // Always compare against Opus as the baseline
        const OPUS_BASELINE = 'claude-opus-4-20250514';
        let totalOriginalCost = 0;
        let totalActualCost = 0;
        let totalSavedAmount = 0;
        const byDayMap = new Map<string, { savedAmount: number; originalCost: number; actualCost: number }>();

        for (const r of requestHistory) {
          const origCost = estimateCost(OPUS_BASELINE, r.tokensIn, r.tokensOut);
          const actualCost = r.costUsd;
          const saved = Math.max(0, origCost - actualCost);

          totalOriginalCost += origCost;
          totalActualCost += actualCost;
          totalSavedAmount += saved;

          const date = r.timestamp.slice(0, 10);
          const day = byDayMap.get(date) || { savedAmount: 0, originalCost: 0, actualCost: 0 };
          day.savedAmount += saved;
          day.originalCost += origCost;
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          total: Math.round(totalOriginalCost * 10000) / 10000,
          actualCost: Math.round(totalActualCost * 10000) / 10000,
          savings: Math.round(totalSavedAmount * 10000) / 10000,
          savedAmount: Math.round(totalSavedAmount * 10000) / 10000,
          potentialSavings: Math.round(totalOriginalCost * 10000) / 10000,
          percentage: totalOriginalCost > 0
            ? Math.round((totalSavedAmount / totalOriginalCost) * 100)
            : 0,
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
        
        // Debug: log provider stats
        console.log('[RelayPlane Health] Provider stats:', JSON.stringify(providerStats));
        
        const providers: Array<{ provider: string; status: string; latency: number; successRate: number; lastChecked: string }> = [];
        for (const [name, ep] of Object.entries(DEFAULT_ENDPOINTS)) {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // === Dashboard ===
    if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }

    // Extract auth context from incoming request
    const ctx = extractRequestContext(req);
    const anthropicEnvKey = process.env['ANTHROPIC_API_KEY'];
    const relayplaneBypass = parseHeaderBoolean(getHeaderValue(req, 'x-relayplane-bypass'));
    const headerModelOverride = getHeaderValue(req, 'x-relayplane-model');
    const relayplaneEnabled = proxyConfig.enabled !== false;
    const recordTelemetry = relayplaneEnabled && !relayplaneBypass;

    // Determine which Anthropic auth to use based on mode
    let useAnthropicEnvKey: string | undefined;
    if (anthropicAuthMode === 'env') {
      useAnthropicEnvKey = anthropicEnvKey;
    } else if (anthropicAuthMode === 'passthrough') {
      useAnthropicEnvKey = undefined; // Only use incoming auth
    } else {
      // 'auto': Use incoming auth if present, fallback to env
      useAnthropicEnvKey = (ctx.authHeader || ctx.apiKeyHeader) ? undefined : anthropicEnvKey;
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

      const originalModel = requestBody['model'] as string | undefined;
      let requestedModel = headerModelOverride ?? originalModel ?? '';
      if (headerModelOverride) {
        log(`Header model override: ${originalModel ?? 'unknown'} → ${headerModelOverride}`);
      }

      const parsedModel = parseModelSuffix(requestedModel);
      let routingSuffix = parsedModel.suffix;
      requestedModel = parsedModel.baseModel;

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

      const isStreaming = requestBody['stream'] === true;
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
          selectedModel = proxyConfig.routing?.complexity?.[complexity];
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
            const complexityModel = proxyConfig.routing?.complexity?.[complexity];
            selectedModel = complexityModel ?? null;
            log(`Complexity routing: ${complexity} → ${selectedModel}`);
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

      if (
        proxyConfig.reliability?.cooldowns?.enabled &&
        !useCascade &&
        !cooldownManager.isAvailable(targetProvider)
      ) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider ${targetProvider} is temporarily cooled down` }));
        return;
      }

      const startTime = Date.now();
      let nativeResponseData: Record<string, unknown> | undefined;

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
              const attemptBody = { ...requestBody, model: resolved.model };
              // Hybrid auth: use MAX token for Opus models, API key for others
              const modelAuth = getAuthForModel(resolved.model, proxyConfig.auth, useAnthropicEnvKey);
              if (modelAuth.isMax) {
                log(`Using MAX token for ${resolved.model}`);
              }
              const providerResponse = await forwardNativeAnthropicRequest(attemptBody, ctx, modelAuth.apiKey, modelAuth.isMax);
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

          res.writeHead(200, { 'Content-Type': 'application/json' });
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
          const providerResponse = await forwardNativeAnthropicRequest(
            { ...requestBody, model: finalModel },
            ctx,
            modelAuth.apiKey,
            modelAuth.isMax
          );
          if (!providerResponse.ok) {
            const errorPayload = (await providerResponse.json()) as Record<string, unknown>;
            if (proxyConfig.reliability?.cooldowns?.enabled) {
              cooldownManager.recordFailure(targetProvider, JSON.stringify(errorPayload));
            }
            const durationMs = Date.now() - startTime;
            logRequest(
              originalModel ?? 'unknown',
              targetModel || requestedModel,
              targetProvider,
              durationMs,
              false,
              routingMode,
              undefined,
              taskType, complexity
            );
            res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorPayload));
            return;
          }
          if (proxyConfig.reliability?.cooldowns?.enabled) {
            cooldownManager.recordSuccess(targetProvider);
          }

          if (isStreaming) {
            res.writeHead(providerResponse.status, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            const reader = providerResponse.body?.getReader();
            let streamTokensIn = 0;
            let streamTokensOut = 0;
            if (reader) {
              const decoder = new TextDecoder();
              let sseBuffer = '';
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  res.write(chunk);
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
                        // Anthropic: message_start has usage.input_tokens
                        if (evt.type === 'message_start' && evt.message?.usage) {
                          streamTokensIn = evt.message.usage.input_tokens ?? streamTokensIn;
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
            // Store streaming token counts so telemetry can use them
            nativeResponseData = { usage: { input_tokens: streamTokensIn, output_tokens: streamTokensOut } } as Record<string, unknown>;
            res.end();
          } else {
            nativeResponseData = await providerResponse.json() as Record<string, unknown>;
            res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
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
        const nativeTokIn = nativeUsageData?.input_tokens ?? nativeUsageData?.prompt_tokens ?? 0;
        const nativeTokOut = nativeUsageData?.output_tokens ?? nativeUsageData?.completion_tokens ?? 0;
        updateLastHistoryEntry(
          nativeTokIn,
          nativeTokOut,
          estimateCost(targetModel || requestedModel, nativeTokIn, nativeTokOut),
        );

        if (recordTelemetry) {
          relay
            .run({
              prompt: promptText.slice(0, 500),
              taskType,
              model: `${targetProvider}:${targetModel || requestedModel}`,
            })
            .catch(() => {});
          sendCloudTelemetry(taskType, targetModel || requestedModel, nativeTokIn, nativeTokOut, durationMs, true, undefined, originalModel ?? undefined);
        }
      } catch (err) {
        const durationMs = Date.now() - startTime;
        logRequest(
          originalModel ?? 'unknown',
          targetModel || requestedModel,
          targetProvider,
          durationMs,
          false,
          routingMode,
          undefined,
          taskType, complexity
        );
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
      res.end(JSON.stringify({ error: 'Not found. Supported: POST /v1/messages, POST /v1/chat/completions, GET /v1/models' }));
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
          const complexityModel = proxyConfig.routing?.complexity?.[complexity];
          selectedModel = complexityModel ?? null;
          log(`Complexity routing: ${complexity} → ${selectedModel}`);
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

    const startTime = Date.now();

    // Handle streaming vs non-streaming
    if (isStreaming) {
      await handleStreamingRequest(
        res,
        request,
        targetProvider,
        targetModel,
        apiKey,
        ctx,
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
        complexity
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
                ctx
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
          const cascadeCost = estimateCost(cascadeResult.model, cascadeTokensIn, cascadeTokensOut);
          updateLastHistoryEntry(cascadeTokensIn, cascadeTokensOut, cascadeCost);

          if (recordTelemetry) {
            try {
              const runResult = await relay.run({
                prompt: promptText.slice(0, 500),
                taskType,
                model: `${cascadeResult.provider}:${cascadeResult.model}`,
              });
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
            sendCloudTelemetry(taskType, cascadeResult.model, cascadeTokensIn, cascadeTokensOut, durationMs, true, undefined, originalRequestedModel ?? undefined);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseData));
        } catch (err) {
          const durationMs = Date.now() - startTime;
          logRequest(originalRequestedModel ?? 'unknown', targetModel || 'unknown', targetProvider, durationMs, false, 'cascade', undefined, taskType, complexity);
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
        await handleNonStreamingRequest(
          res,
          request,
          targetProvider,
          targetModel,
          apiKey,
          ctx,
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
          complexity
        );
      }
    }
  });

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
      console.log(`  Auth: Passthrough for Anthropic, env vars for other providers`);
      console.log(`  Streaming: ✅ Enabled`);
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
  complexity: Complexity = 'simple'
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
      default:
        providerResponse = await forwardToOpenAIStream(request, targetModel, apiKey!);
    }

    if (!providerResponse.ok) {
      const errorData = await providerResponse.json();
      if (cooldownsEnabled) {
        cooldownManager.recordFailure(targetProvider, JSON.stringify(errorData));
      }
      const durationMs = Date.now() - startTime;
      logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity);
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
    logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Track token usage from streaming events
  let streamTokensIn = 0;
  let streamTokensOut = 0;

  try {
    // Stream the response based on provider format
    switch (targetProvider) {
      case 'anthropic':
        // Convert Anthropic stream to OpenAI format
        for await (const chunk of convertAnthropicStream(providerResponse, targetModel)) {
          res.write(chunk);
          // Parse OpenAI-format chunks for usage (emitted at end of stream)
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
      case 'google':
        // Convert Gemini stream to OpenAI format
        for await (const chunk of convertGeminiStream(providerResponse, targetModel)) {
          res.write(chunk);
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
  // Update token/cost info on the history entry
  const streamCost = estimateCost(targetModel, streamTokensIn, streamTokensOut);
  updateLastHistoryEntry(streamTokensIn, streamTokensOut, streamCost);

  if (recordTelemetry) {
    // Record the run (non-blocking)
    relay
      .run({
        prompt: promptText.slice(0, 500),
        taskType,
        model: `${targetProvider}:${targetModel}`,
      })
      .then((runResult) => {
        log(`Completed streaming in ${durationMs}ms, runId: ${runResult.runId}`);
      })
      .catch((err) => {
        log(`Failed to record run: ${err}`);
      });
    sendCloudTelemetry(taskType, targetModel, streamTokensIn, streamTokensOut, durationMs, true, undefined, request.model ?? undefined);
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
  complexity: Complexity = 'simple'
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
      const durationMs = Date.now() - startTime;
      logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseData));
      return;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (cooldownsEnabled) {
      cooldownManager.recordFailure(targetProvider, errorMsg);
    }
    const durationMs = Date.now() - startTime;
    logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, false, routingMode, undefined, taskType, complexity);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  if (cooldownsEnabled) {
    cooldownManager.recordSuccess(targetProvider);
  }

  const durationMs = Date.now() - startTime;

  // Log the successful request
  logRequest(request.model ?? 'unknown', targetModel, targetProvider, durationMs, true, routingMode, undefined, taskType, complexity);
  // Update token/cost info
  const usage = (responseData as any)?.usage;
  const tokensIn = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cost = estimateCost(targetModel, tokensIn, tokensOut);
  updateLastHistoryEntry(tokensIn, tokensOut, cost);

  if (recordTelemetry) {
    // Record the run in RelayPlane
    try {
      const runResult = await relay.run({
        prompt: promptText.slice(0, 500),
        taskType,
        model: `${targetProvider}:${targetModel}`,
      });

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
    // Extract token counts from response if available (Anthropic/OpenAI format)
    const usage = (responseData as any)?.usage;
    const tokensIn = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const tokensOut = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    sendCloudTelemetry(taskType, targetModel, tokensIn, tokensOut, durationMs, true);
  }

  // Send response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseData));
}

// Note: CLI entry point is in cli.ts
