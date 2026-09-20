/**
 * Optional Jev (TypeSafe "System One") complexity classifier.
 *
 * KEY-GATED ADD-ON. When a Jev API key is configured, RelayPlane MAY consult
 * Jev to classify request complexity (simple | moderate | complex), feeding the
 * exact same resolvePolicy routing path that the free heuristic feeds. When no
 * key is configured, none of this runs: the free classifyComplexity heuristic
 * decides, exactly as before, with zero new latency and zero external calls.
 *
 * This module deliberately mirrors the sidecar client contract:
 *   - returns null on ANY failure (unreachable, timeout, non-2xx, malformed
 *     body, unrecognized answer shape),
 *   - never throws,
 *   - uses a tight, abortable timeout so a slow Jev never blocks a request.
 *
 * The free proxy is NEVER re-gated: Jev is additive. On any Jev failure the
 * caller falls back to the free heuristic and the request is still served.
 */

import type { SidecarLogger } from './sidecar_client.js';

/** The three complexity tiers resolvePolicy accepts. Jev never returns elite. */
export type JevComplexity = 'simple' | 'moderate' | 'complex';

export interface JevClassifyInput {
  /** The prompt text to classify (typically the last user message). */
  prompt: string;
}

export interface JevClassifyOptions {
  /** Jev API key. Required; the caller only invokes this when a key is present. */
  apiKey: string;
  /** Full endpoint URL. Defaults to the TypeSafe System One endpoint. */
  endpoint?: string;
  /** Jev model id. Defaults to jev-latest. */
  model?: string;
  /** Abort timeout in milliseconds. Defaults to 500. */
  timeoutMs?: number;
  logger?: SidecarLogger;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 500;

const COMPLEXITY_CHOICES: readonly JevComplexity[] = ['simple', 'moderate', 'complex'];
/** The question name we send and read back. */
const QUESTION_NAME = 'complexity';

function debugLog(logger: SidecarLogger | undefined, msg: string): void {
  if (logger && typeof logger.debug === 'function') {
    logger.debug(msg);
  }
}

/** Normalize an arbitrary string to one of the three tiers, or null. */
function toComplexity(value: string): JevComplexity | null {
  const v = value.trim().toLowerCase();
  for (const choice of COMPLEXITY_CHOICES) {
    if (v === choice) return choice;
  }
  return null;
}

/**
 * Extract a complexity tier from a Jev answer object, tolerant of a few
 * plausible shapes (a bare string, or an object exposing the chosen label
 * under a common field, or a scores/distribution map we argmax over).
 * Returns null on anything we cannot confidently map.
 */
function extractComplexity(answer: unknown): JevComplexity | null {
  if (typeof answer === 'string') {
    return toComplexity(answer);
  }
  if (!answer || typeof answer !== 'object') {
    return null;
  }
  const obj = answer as Record<string, unknown>;

  // Common single-value fields.
  for (const field of ['value', 'answer', 'label', 'choice', 'class', 'result'] as const) {
    const candidate = obj[field];
    if (typeof candidate === 'string') {
      const mapped = toComplexity(candidate);
      if (mapped) return mapped;
    }
  }

  // Scores / distribution map: pick the highest-scoring recognized tier.
  for (const field of ['scores', 'distribution', 'probabilities', 'probs'] as const) {
    const map = obj[field];
    if (map && typeof map === 'object') {
      let best: JevComplexity | null = null;
      let bestScore = -Infinity;
      for (const choice of COMPLEXITY_CHOICES) {
        const raw = (map as Record<string, unknown>)[choice];
        if (typeof raw === 'number' && Number.isFinite(raw) && raw > bestScore) {
          bestScore = raw;
          best = choice;
        }
      }
      if (best) return best;
    }
  }

  return null;
}

/**
 * Classify request complexity via Jev. Returns a tier on success, or null on
 * ANY failure (never throws). The caller MUST treat null as "fall back to the
 * free heuristic".
 */
export async function classifyComplexityViaJev(
  input: JevClassifyInput,
  opts: JevClassifyOptions,
): Promise<JevComplexity | null> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      state: input.prompt,
      model,
      questions: {
        [QUESTION_NAME]: {
          type: 'enum',
          prompt:
            'Classify the reasoning complexity required to answer this request as one of: simple, moderate, complex.',
          choices: COMPLEXITY_CHOICES,
        },
      },
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res || !res.ok) {
      debugLog(opts.logger, `[jev] non-2xx response: ${res?.status ?? 'unknown'}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      debugLog(opts.logger, `[jev] malformed JSON: ${(err as Error).message}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      debugLog(opts.logger, '[jev] invalid response shape');
      return null;
    }

    const answers = (parsed as Record<string, unknown>)['answers'];
    if (!answers || typeof answers !== 'object') {
      debugLog(opts.logger, '[jev] missing answers object');
      return null;
    }

    const answer = (answers as Record<string, unknown>)[QUESTION_NAME];
    const complexity = extractComplexity(answer);
    if (!complexity) {
      debugLog(opts.logger, '[jev] could not map answer to a complexity tier');
      return null;
    }

    return complexity;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(opts.logger, `[jev] request failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
