/**
 * Cross-Provider Cascade Fallback (GH #38)
 *
 * When a primary provider returns a rate-limit or unavailability error
 * (429 / 529 / 503), automatically retry the request with the next
 * configured provider, mapping the model name to the equivalent on that
 * provider.
 *
 * Config example (~/.relayplane/config.json):
 * ```json
 * {
 *   "crossProviderCascade": {
 *     "enabled": true,
 *     "providers": ["anthropic", "openrouter", "google"],
 *     "triggerStatuses": [429, 529, 503]
 *   }
 * }
 * ```
 *
 * Model mapping (built-in):
 *   anthropic  →  openrouter : claude-sonnet-4-6  →  anthropic/claude-sonnet-4-6
 *   anthropic  →  openrouter : claude-opus-4-6    →  anthropic/claude-opus-4-6
 *   anthropic  →  openrouter : claude-haiku-4-5   →  anthropic/claude-haiku-4-5
 *
 * Custom overrides can be provided via `modelMapping` in the config.
 *
 * @packageDocumentation
 */

/** Statuses that trigger a cross-provider cascade attempt. */
export const DEFAULT_CASCADE_TRIGGER_STATUSES = [429, 529, 503];

/**
 * Built-in model name mappings between providers.
 * Structure: BUILT_IN_MODEL_MAPPING[fromProvider][toProvider][modelName] = mappedModel
 */
export const BUILT_IN_MODEL_MAPPING: Record<string, Record<string, Record<string, string>>> = {
  anthropic: {
    openrouter: {
      // Current tier models (2026): keep quality tier comparable on the hop.
      'claude-opus-5-5':           'anthropic/claude-opus-4-8',
      'claude-opus-5':             'anthropic/claude-opus-4-8',
      'claude-sonnet-5':           'anthropic/claude-sonnet-5',
      'claude-fable-5-1':          'anthropic/claude-opus-4-8',
      'claude-opus-4-8':           'anthropic/claude-opus-4-8',
      // Legacy names retained for older configs.
      'claude-opus-4-6':           'anthropic/claude-opus-4-6',
      'claude-sonnet-4-6':         'anthropic/claude-sonnet-4-6',
      'claude-haiku-4-5':          'anthropic/claude-haiku-4-5',
      'claude-3-5-sonnet-latest':  'anthropic/claude-3-5-sonnet',
      'claude-3-5-haiku-latest':   'anthropic/claude-3-5-haiku',
      'claude-3-opus-latest':      'anthropic/claude-3-opus',
    },
    openai: {
      // Quality-comparable OpenAI analogs (used when OpenAI is the next eligible provider).
      'claude-opus-5-5':   'gpt-5.4',
      'claude-opus-5':     'gpt-5.4',
      'claude-fable-5-1':  'gpt-5.5',
      'claude-sonnet-5':   'gpt-5.4',
      'claude-haiku-4-5':  'gpt-4.1-mini',
      'claude-opus-4-6':   'gpt-5.4',
      'claude-sonnet-4-6': 'gpt-5.4',
    },
    google: {
      'claude-opus-5-5':    'gemini-2.5-pro',
      'claude-opus-5':      'gemini-2.5-pro',
      'claude-sonnet-5':    'gemini-2.5-flash',
      'claude-haiku-4-5':   'gemini-2.5-flash-lite',
      'claude-opus-4-6':    'gemini-2.0-flash',      // best available Gemini analog
      'claude-sonnet-4-6':  'gemini-2.0-flash',
    },
  },
  openai: {
    openrouter: {
      'gpt-4o':      'openai/gpt-4o',
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4.1':     'openai/gpt-4.1',
      'o1':          'openai/o1',
      'o3-mini':     'openai/o3-mini',
    },
    anthropic: {
      'gpt-4o':      'claude-sonnet-4-6',
      'gpt-4o-mini': 'claude-haiku-4-5',
      'gpt-4.1':     'claude-sonnet-4-6',
    },
  },
  openrouter: {
    anthropic: {
      'anthropic/claude-opus-4-6':    'claude-opus-4-6',
      'anthropic/claude-sonnet-4-6':  'claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5':   'claude-haiku-4-5',
      'openai/gpt-4o':                'claude-sonnet-4-6',  // approximate
    },
  },
};

/** Configuration for the cross-provider cascade feature. */
export interface CrossProviderCascadeConfig {
  /** Enable or disable the feature (default: false). */
  enabled: boolean;
  /**
   * Ordered list of provider names to try in sequence.
   * The first entry is the primary provider; subsequent entries are fallbacks.
   * Example: ["anthropic", "openrouter", "google"]
   */
  providers: string[];
  /**
   * HTTP status codes that trigger a cascade to the next provider.
   * Defaults to [429, 529, 503].
   */
  triggerStatuses?: number[];
  /**
   * Custom model mappings that override or extend the built-in rules.
   * Structure: { fromProvider: { toProvider: { modelName: mappedModel } } }
   */
  modelMapping?: Record<string, Record<string, Record<string, string>>>;
}

/** Result of a cascade attempt. */
export interface CascadeAttemptResult {
  /** Whether the cascade attempt succeeded. */
  success: boolean;
  /** The provider that ultimately served the request. */
  provider: string;
  /** The model name used on the successful provider. */
  model: string;
  /** Number of providers tried before success (0 = primary succeeded). */
  attempts: number;
  /** Status code returned by each provider tried. */
  statusHistory: Array<{ provider: string; model: string; status: number }>;
}

/** Information about a cascade hop. */
export interface CascadeHop {
  provider: string;
  model: string;
}

/**
 * Manages cross-provider fallback cascade.
 *
 * This is a pure-logic class with no I/O; the actual HTTP calls are delegated
 * to a caller-supplied `makeRequest` callback, making it fully unit-testable.
 */
export class CrossProviderCascadeManager {
  private config: CrossProviderCascadeConfig = { enabled: false, providers: [] };

  /** Apply a new configuration. Call once at proxy startup. */
  configure(config: CrossProviderCascadeConfig): void {
    this.config = { ...config };
  }

  /** Get the active configuration. */
  getConfig(): Readonly<CrossProviderCascadeConfig> {
    return this.config;
  }

  /** Whether the cascade feature is enabled. */
  get enabled(): boolean {
    return this.config.enabled && this.config.providers.length > 1;
  }

  /**
   * Check whether an HTTP status code should trigger a cascade to the next provider.
   */
  shouldCascade(status: number): boolean {
    const triggers = this.config.triggerStatuses ?? DEFAULT_CASCADE_TRIGGER_STATUSES;
    return triggers.includes(status);
  }

  /**
   * Return the ordered list of fallback providers to try after `currentProvider` fails.
   * The current provider is excluded from the result.
   */
  getFallbackProviders(currentProvider: string): string[] {
    const providers = this.config.providers;
    const idx = providers.indexOf(currentProvider);
    if (idx === -1) {
      // Current provider not in list - return all as fallbacks
      return [...providers];
    }
    return providers.slice(idx + 1);
  }

  /**
   * Map a model name from one provider to its equivalent on another provider.
   *
   * Resolution order:
   * 1. Custom mapping from config
   * 2. Built-in mapping table
   * 3. Identity (return the model name unchanged as last resort)
   */
  mapModel(model: string, fromProvider: string, toProvider: string): string {
    if (fromProvider === toProvider) return model;

    // 1. Custom overrides (highest priority)
    const custom = this.config.modelMapping?.[fromProvider]?.[toProvider]?.[model];
    if (custom) return custom;

    // 2. Built-in table
    const builtin = BUILT_IN_MODEL_MAPPING[fromProvider]?.[toProvider]?.[model];
    if (builtin) return builtin;

    // 3. Partial-match heuristic for OpenRouter: prefix model with "provider/"
    if (toProvider === 'openrouter' && !model.includes('/')) {
      return `${fromProvider}/${model}`;
    }

    // 4. Identity fallback
    return model;
  }

  /**
   * Execute a cross-provider cascade.
   *
   * @param primaryProvider  - Provider that just failed.
   * @param primaryModel     - Model name used on the primary provider.
   * @param primaryStatus    - HTTP status returned by the primary provider.
   * @param makeRequest      - Async callback that sends the request to a given provider/model.
   *                           Should return `{ status, data }`.
   * @param log              - Logging callback for cascade events.
   *
   * @returns `CascadeAttemptResult` - callers can check `.success` and use `.provider`/`.model`.
   */
  async execute<T>(
    primaryProvider: string,
    primaryModel: string,
    primaryStatus: number,
    makeRequest: (hop: CascadeHop) => Promise<{ status: number; data: T }>,
    log: (msg: string) => void = () => {}
  ): Promise<{ result: CascadeAttemptResult; data?: T }> {
    const statusHistory: CascadeAttemptResult['statusHistory'] = [
      { provider: primaryProvider, model: primaryModel, status: primaryStatus },
    ];

    if (!this.shouldCascade(primaryStatus)) {
      return {
        result: {
          success: false,
          provider: primaryProvider,
          model: primaryModel,
          attempts: 1,
          statusHistory,
        },
      };
    }

    const fallbacks = this.getFallbackProviders(primaryProvider);
    if (fallbacks.length === 0) {
      log(`[CROSS-CASCADE] No fallback providers configured after ${primaryProvider} - giving up`);
      return {
        result: {
          success: false,
          provider: primaryProvider,
          model: primaryModel,
          attempts: 1,
          statusHistory,
        },
      };
    }

    log(
      `[CROSS-CASCADE] ${primaryProvider} returned ${primaryStatus} - ` +
      `cascading to: ${fallbacks.join(' → ')}`
    );

    let attempts = 1;
    for (const nextProvider of fallbacks) {
      const nextModel = this.mapModel(primaryModel, primaryProvider, nextProvider);
      attempts++;

      log(
        `[CROSS-CASCADE] Attempt ${attempts}: ${nextProvider}/${nextModel} ` +
        `(mapped from ${primaryProvider}/${primaryModel})`
      );

      try {
        const { status, data } = await makeRequest({ provider: nextProvider, model: nextModel });
        statusHistory.push({ provider: nextProvider, model: nextModel, status });

        if (status >= 200 && status < 300) {
          log(
            `[CROSS-CASCADE] Success on ${nextProvider}/${nextModel} ` +
            `after ${attempts} attempt(s)`
          );
          return {
            result: {
              success: true,
              provider: nextProvider,
              model: nextModel,
              attempts,
              statusHistory,
            },
            data,
          };
        }

        // Non-success - should we keep cascading?
        if (this.shouldCascade(status)) {
          log(
            `[CROSS-CASCADE] ${nextProvider} returned ${status} - ` +
            `trying next provider`
          );
          continue;
        }

        // Non-retryable error (4xx other than 429/529) - stop cascading
        log(
          `[CROSS-CASCADE] ${nextProvider} returned non-retryable ${status} - ` +
          `aborting cascade`
        );
        return {
          result: {
            success: false,
            provider: nextProvider,
            model: nextModel,
            attempts,
            statusHistory,
          },
          data,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`[CROSS-CASCADE] ${nextProvider} threw: ${errMsg} - trying next provider`);
        statusHistory.push({ provider: nextProvider, model: nextModel, status: 0 });
      }
    }

    log(`[CROSS-CASCADE] All fallback providers exhausted. Giving up.`);
    return {
      result: {
        success: false,
        provider: primaryProvider,
        model: primaryModel,
        attempts,
        statusHistory,
      },
    };
  }
}

/** Singleton instance (configure once at startup). */
export const crossProviderCascade = new CrossProviderCascadeManager();

/**
 * Helper: build a human-readable summary of cascade status history.
 */
export function formatCascadeHistory(
  history: CascadeAttemptResult['statusHistory']
): string {
  return history
    .map((h) => `${h.provider}/${h.model}→${h.status}`)
    .join(', ');
}
