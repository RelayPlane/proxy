/**
 * vLLM Semantic Router sidecar HTTP client.
 *
 * Calls a local sidecar over HTTP to classify the incoming prompt.
 * Returns null on ANY failure (unreachable, timeout, malformed response,
 * invalid shape). Never throws.
 */

export interface SidecarLogger {
  debug?(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
  warn?(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
}

export interface SidecarResult {
  model: string;
  confidence: number;
  latency_ms: number;
  task_type?: string;
}

export interface SidecarClassifyInput {
  prompt: string;
  models: string[];
}

export interface SidecarClassifyOptions {
  url: string;
  timeoutMs?: number;
  logger?: SidecarLogger;
}

function debugLog(logger: SidecarLogger | undefined, msg: string): void {
  if (logger && typeof logger.debug === 'function') {
    logger.debug(msg);
  }
}

export async function classifyViaSidecar(
  input: SidecarClassifyInput,
  opts: SidecarClassifyOptions
): Promise<SidecarResult | null> {
  const timeoutMs = opts.timeoutMs ?? 200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${opts.url}/v1/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, models: input.models }),
      signal: controller.signal,
    });

    if (!res || !res.ok) {
      debugLog(opts.logger, `[sidecar] non-2xx response: ${res?.status ?? 'unknown'}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      debugLog(opts.logger, `[sidecar] malformed JSON: ${(err as Error).message}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      debugLog(opts.logger, '[sidecar] invalid response shape');
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const model = obj['model'];
    const confidence = obj['confidence'];
    const latency_ms = obj['latency_ms'];
    const task_type = obj['task_type'];

    if (typeof model !== 'string') {
      debugLog(opts.logger, '[sidecar] missing or invalid model field');
      return null;
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      debugLog(opts.logger, '[sidecar] invalid confidence value');
      return null;
    }

    const result: SidecarResult = {
      model,
      confidence,
      latency_ms: typeof latency_ms === 'number' && Number.isFinite(latency_ms) ? latency_ms : 0,
    };
    if (typeof task_type === 'string') {
      result.task_type = task_type;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(opts.logger, `[sidecar] request failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
