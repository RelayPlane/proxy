/**
 * RelayPlane Proxy Middleware
 * 
 * Wraps provider requests: tries proxy first (when circuit is healthy),
 * falls back to direct on failure. This is the key integration point.
 * 
 * @packageDocumentation
 */

import * as http from 'node:http';
import { CircuitBreaker } from './circuit-breaker.js';
import { probeHealth } from './health.js';
import { resolveConfig, type RelayPlaneConfig } from './relay-config.js';
import { ProcessManager, type ProcessManagerOptions } from './process-manager.js';
import { StatsCollector } from './stats.js';
import { StatusReporter, type ProxyStatus } from './status.js';
import { type Logger, defaultLogger } from './logger.js';
import { captureAtom } from './osmosis-store.js';
import { classifyViaSidecar, type SidecarLogger } from './classifier/sidecar_client.js';
import { loadSidecarConfig, type SidecarConfig } from './classifier/sidecar_setup.js';

function inferTaskType(reqPath: string, body: string): string {
  if (reqPath.includes('/v1/messages') || reqPath.includes('/v1/chat/completions')) return 'chat';
  if (reqPath.includes('/v1/completions')) return 'completion';
  if (body && body.toLowerCase().includes('code')) return 'code';
  return 'unknown';
}

export interface ClassifyResult {
  taskType: string;
  source: 'regex' | 'sidecar';
  confidence?: number;
  recommendedModel?: string;
}

export async function classifyTaskType(
  reqPath: string,
  body: string,
  ctx: { sidecarConfig: SidecarConfig; availableModels?: string[]; logger?: SidecarLogger }
): Promise<ClassifyResult> {
  if (!ctx.sidecarConfig.enabled || !ctx.sidecarConfig.url) {
    return { taskType: inferTaskType(reqPath, body), source: 'regex' };
  }
  const result = await classifyViaSidecar(
    { prompt: body, models: ctx.availableModels ?? [] },
    { url: ctx.sidecarConfig.url, timeoutMs: ctx.sidecarConfig.timeoutMs, logger: ctx.logger }
  );
  if (result && result.confidence >= ctx.sidecarConfig.confidenceThreshold) {
    return {
      taskType: result.task_type ?? inferTaskType(reqPath, body),
      source: 'sidecar',
      confidence: result.confidence,
      recommendedModel: result.model,
    };
  }
  return { taskType: inferTaskType(reqPath, body), source: 'regex' };
}

function extractModel(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed['model'] === 'string' ? parsed['model'] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractTokenUsage(responseBody: string): { inputTokens: number; outputTokens: number } {
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const usage = parsed['usage'] as Record<string, number> | undefined;
    if (usage) {
      return {
        inputTokens: usage['input_tokens'] ?? usage['prompt_tokens'] ?? 0,
        outputTokens: usage['output_tokens'] ?? usage['completion_tokens'] ?? 0,
      };
    }
  } catch { /* ignore */ }
  return { inputTokens: 0, outputTokens: 0 };
}

function classifyError(errMsg: string): string {
  if (errMsg.includes('timeout')) return 'timeout';
  if (errMsg.includes('ECONNREFUSED') || errMsg.includes('network')) return 'network_error';
  return 'http_error';
}

export interface MiddlewareRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

export interface MiddlewareResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  viaProxy: boolean;
}

export interface DirectSendFn {
  (req: MiddlewareRequest): Promise<MiddlewareResponse>;
}

export interface MiddlewareOptions {
  config?: Partial<RelayPlaneConfig>;
  processManager?: ProcessManager;
  processManagerOptions?: ProcessManagerOptions;
  logger?: Logger;
}

export class RelayPlaneMiddleware {
  readonly circuitBreaker: CircuitBreaker;
  readonly stats: StatsCollector;
  private readonly statusReporter: StatusReporter;
  private readonly proxyUrl: string;
  private readonly enabled: boolean;
  private readonly autoStart: boolean;
  private readonly logger: Logger;
  private probeInterval: ReturnType<typeof setInterval> | null = null;
  private processManager: ProcessManager | null = null;
  private sidecarConfig: SidecarConfig;

  constructor(config?: Partial<RelayPlaneConfig>);
  constructor(opts?: MiddlewareOptions);
  constructor(configOrOpts?: Partial<RelayPlaneConfig> | MiddlewareOptions) {
    let config: Partial<RelayPlaneConfig> | undefined;
    let pm: ProcessManager | undefined;
    let pmOpts: ProcessManagerOptions | undefined;
    let logger: Logger | undefined;

    if (configOrOpts && 'config' in configOrOpts) {
      const opts = configOrOpts as MiddlewareOptions;
      config = opts.config;
      pm = opts.processManager;
      pmOpts = opts.processManagerOptions;
      logger = opts.logger;
    } else {
      config = configOrOpts as Partial<RelayPlaneConfig> | undefined;
    }

    const resolved = resolveConfig(config);
    this.enabled = resolved.enabled;
    this.proxyUrl = resolved.proxyUrl;
    this.autoStart = resolved.autoStart;
    this.logger = logger ?? defaultLogger;
    this.sidecarConfig = loadSidecarConfig();
    this.circuitBreaker = new CircuitBreaker(resolved.circuitBreaker);
    this.stats = new StatsCollector();

    // Set up process manager
    if (pm) {
      this.processManager = pm;
    } else if (this.autoStart && this.enabled) {
      this.processManager = new ProcessManager({
        ...pmOpts,
        circuitBreaker: this.circuitBreaker,
      });
    }

    // Status reporter
    this.statusReporter = new StatusReporter({
      enabled: this.enabled,
      proxyUrl: this.proxyUrl,
      circuitBreaker: this.circuitBreaker,
      statsCollector: this.stats,
      processManager: this.processManager,
    });

    // Wire circuit breaker state changes → stats + logging + probing
    this.circuitBreaker.on('stateChange', ({ from, to }: { from: string; to: string }) => {
      this.stats.recordStateTransition(from as any, to as any);

      if (to === 'OPEN') {
        this.logger.error(`Circuit breaker tripped OPEN (was ${from})`);
        this.startProbing();
      } else if (to === 'CLOSED') {
        this.logger.info(`Circuit breaker recovered: ${from} → CLOSED`);
        this.stopProbing();
      } else {
        this.stopProbing();
      }
    });

    // Wire process manager events
    if (this.processManager) {
      this.processManager.on('crash', ({ code, signal }: { code: number | null; signal: string | null }) => {
        this.statusReporter.incrementRestarts();
        this.statusReporter.setLastError(`Process crashed (code=${code}, signal=${signal})`);
      });
      this.processManager.on('error', (err: Error) => {
        this.statusReporter.setLastError(err.message);
      });
    }

    // Auto-start
    if (this.processManager && this.autoStart && this.enabled) {
      this.processManager.start();
    }
  }

  getProcessManager(): ProcessManager | null {
    return this.processManager;
  }

  getStatus(): ProxyStatus {
    return this.statusReporter.getStatus();
  }

  formatStatus(): string {
    return this.statusReporter.formatStatus();
  }

  /**
   * Route a request: proxy if healthy, direct otherwise.
   */
  async route(req: MiddlewareRequest, directSend: DirectSendFn): Promise<MiddlewareResponse> {
    const bodyStr = typeof req.body === 'string' ? req.body : (req.body?.toString() ?? '');
    const model = extractModel(bodyStr);
    const classified = await classifyTaskType(req.path, bodyStr, {
      sidecarConfig: this.sidecarConfig,
      availableModels: [model],
      logger: this.logger,
    });
    const { taskType } = classified;
    const classifierMeta = {
      classifierSource: classified.source,
      classifierConfidence: classified.confidence,
      classifierRecommendedModel: classified.recommendedModel,
    };

    if (!this.enabled || !this.circuitBreaker.isHealthy()) {
      const reason = !this.enabled ? 'proxy disabled' : 'circuit breaker OPEN';
      this.logger.warn(`Falling back to direct: ${reason}`);

      const start = Date.now();
      const resp = await directSend(req);
      const latencyMs = Date.now() - start;
      this.stats.recordRequest({
        timestamp: start,
        latencyMs,
        viaProxy: false,
        success: resp.status < 500,
      });

      if (!this.enabled) {
        const { inputTokens, outputTokens } = extractTokenUsage(resp.body);
        captureAtom({ type: 'success', model, taskType, latencyMs, inputTokens, outputTokens, timestamp: Date.now(), ...classifierMeta });
      } else {
        captureAtom({ type: 'failure', model, errorType: 'circuit_open', fallbackTaken: true, timestamp: Date.now(), ...classifierMeta });
      }
      return resp;
    }

    const start = Date.now();
    try {
      const resp = await this.sendViaProxy(req);
      this.circuitBreaker.recordSuccess();
      const latencyMs = Date.now() - start;
      this.stats.recordRequest({
        timestamp: start,
        latencyMs,
        viaProxy: true,
        success: true,
      });
      const { inputTokens, outputTokens } = extractTokenUsage(resp.body);
      captureAtom({ type: 'success', model, taskType, latencyMs, inputTokens, outputTokens, timestamp: Date.now(), ...classifierMeta });
      return resp;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Falling back to direct: proxy error (${errMsg})`);
      this.statusReporter.setLastError(errMsg);
      captureAtom({ type: 'failure', model, errorType: classifyError(errMsg), fallbackTaken: true, timestamp: Date.now(), ...classifierMeta });

      const directStart = Date.now();
      const resp = await directSend(req);
      this.stats.recordRequest({
        timestamp: start,
        latencyMs: Date.now() - start,
        viaProxy: false,
        success: resp.status < 500,
      });
      return resp;
    }
  }

  private sendViaProxy(req: MiddlewareRequest): Promise<MiddlewareResponse> {
    const url = new URL(req.path, this.proxyUrl);
    const timeoutMs = this.circuitBreaker.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const proxyReq = http.request(url, {
        method: req.method,
        headers: req.headers,
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 500) {
            reject(new Error(`Proxy returned ${res.statusCode}`));
            return;
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          resolve({ status: res.statusCode ?? 200, headers, body: data, viaProxy: true });
        });
      });

      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('Proxy request timeout'));
      });

      if (req.body) proxyReq.write(req.body);
      proxyReq.end();
    });
  }

  private startProbing(): void {
    this.stopProbing();
    this.probeInterval = setInterval(async () => {
      if (this.circuitBreaker.getState() !== 'OPEN') {
        this.stopProbing();
        return;
      }
      const ok = await probeHealth(this.proxyUrl);
      if (ok) {
        this.logger.info('Health probe succeeded, transitioning to HALF-OPEN');
        this.circuitBreaker.recordSuccess();
      }
    }, 15_000);
    if (this.probeInterval && typeof this.probeInterval === 'object' && 'unref' in this.probeInterval) {
      this.probeInterval.unref();
    }
  }

  private stopProbing(): void {
    if (this.probeInterval) {
      clearInterval(this.probeInterval);
      this.probeInterval = null;
    }
  }

  destroy(): void {
    this.stopProbing();
    if (this.processManager) {
      this.processManager.destroy();
      this.processManager = null;
    }
    this.circuitBreaker.destroy();
  }
}
