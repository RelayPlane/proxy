/**
 * @relayplane/proxy
 *
 * Intelligent AI model routing for cost optimization.
 * 100% local, zero cloud dependency.
 *
 * @example
 * ```typescript
 * import { startProxy } from '@relayplane/proxy';
 *
 * // Start the proxy server
 * await startProxy({ port: 3001, verbose: true });
 *
 * // Then set env vars:
 * // export ANTHROPIC_BASE_URL=http://localhost:3001
 * // export OPENAI_BASE_URL=http://localhost:3001
 * ```
 *
 * @packageDocumentation
 */

// Main proxy server
export { startProxy } from './proxy.js';
export type { ProxyConfig, ProviderEndpoint } from './proxy.js';
export { DEFAULT_ENDPOINTS, MODEL_MAPPING } from './proxy.js';

// Core relay functionality
export { RelayPlane } from './relay.js';

// Types
export type {
  Provider,
  TaskType,
  RoutingRule,
  RuleSource,
  RunRecord,
  Outcome,
  OutcomeQuality,
  Suggestion,
  RelayPlaneConfig,
} from './types.js';
export { Providers, TaskTypes, TaskTypeSchema, ProviderSchema } from './types.js';

// Routing
export { RoutingEngine } from './routing/engine.js';
export { inferTaskType, getInferenceConfidence } from './routing/inference.js';

// Storage
export { Store } from './storage/store.js';

// Learning
export { PatternDetector } from './learning/patterns.js';
export { OutcomeRecorder } from './learning/outcomes.js';
export { calculateSavings, calculateCost, getModelPricing, MODEL_PRICING } from './learning/savings.js';
export type { SavingsReport, ModelCostBreakdown } from './learning/savings.js';

// Config
export { loadConfig, watchConfig, getStrategy, getConfigPath, DEFAULT_CONFIG } from './config.js';
export type { Config, StrategyConfig } from './config.js';
