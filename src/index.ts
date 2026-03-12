/**
 * @relayplane/proxy
 *
 * RelayPlane Agent Ops Proxy Server
 *
 * Intelligent AI model routing with integrated observability.
 * This is a standalone proxy that routes requests to optimal models
 * based on task type and cost optimization.
 *
 * @example
 * ```typescript
 * import { startProxy } from '@relayplane/proxy';
 *
 * // Start the proxy server
 * await startProxy({ port: 4801 });
 * ```
 *
 * @packageDocumentation
 */

// Standalone proxy (requires only @relayplane/core)
export { startProxy } from './standalone-proxy.js';
export type { ProxyConfig } from './standalone-proxy.js';

// Configuration
export {
  loadConfig,
  saveConfig,
  updateConfig,
  isFirstRun,
  markFirstRunComplete,
  isTelemetryEnabled,
  enableTelemetry,
  disableTelemetry,
  getDeviceId,
  setApiKey,
  getApiKey,
  getConfigDir,
  getConfigPath,
} from './config.js';
export type { ProxyConfig as ProxyLocalConfig } from './config.js';

// Telemetry
export {
  recordTelemetry,
  inferTaskType,
  estimateCost,
  setAuditMode,
  isAuditMode,
  setOfflineMode,
  isOfflineMode,
  getAuditBuffer,
  clearAuditBuffer,
  getLocalTelemetry,
  getTelemetryStats,
  clearTelemetry,
  getTelemetryPath,
  printTelemetryDisclosure,
} from './telemetry.js';
export type { TelemetryEvent } from './telemetry.js';

// Sandbox Architecture (v1.3.0+)
export { CircuitBreaker, CircuitState } from './circuit-breaker.js';
export { RelayPlaneMiddleware } from './middleware.js';
export type { MiddlewareOptions } from './middleware.js';
export { ProcessManager } from './process-manager.js';
export { handleHealthRequest, probeHealth } from './health.js';
export { StatsCollector } from './stats.js';
export { StatusReporter } from './status.js';
export type { ProxyStatus } from './status.js';
export { resolveConfig } from './relay-config.js';
export type { RelayPlaneConfig } from './relay-config.js';
export { defaultLogger } from './logger.js';
export type { Logger } from './logger.js';

// Proxy stats collector (from standalone proxy)
export { proxyStatsCollector } from './standalone-proxy.js';

// Ollama local model provider
export {
  checkOllamaHealth,
  checkOllamaHealthCached,
  clearOllamaHealthCache,
  shouldRouteToOllama,
  resolveOllamaModel,
  forwardToOllama,
  forwardToOllamaStream,
  convertMessagesToOllama,
  buildOllamaRequest,
  convertOllamaResponse,
  convertOllamaStreamChunk,
  mapCloudModelToOllama,
  OLLAMA_DEFAULTS,
  CLOUD_TO_OLLAMA_MODEL_MAP,
} from './ollama.js';
export type {
  OllamaProviderConfig,
  OllamaHealthResult,
} from './ollama.js';

// Re-export core types
export type { Provider, TaskType } from '@relayplane/core';

// Adaptive Provider Recovery (Phase 1)
export {
  RecoveryEngine,
  RecoveryPatternStore,
  FailureObserver,
  PatternApplicator,
} from './recovery.js';
export type {
  RecoveryConfig,
  RecoveryPattern,
  RecoveryPatternType,
  RecoveryResult,
  RecoveryEvent,
  FailureContext,
  RequestOverrides,
} from './recovery.js';

// Advanced proxy server (requires @relayplane/ledger, @relayplane/auth-gate, etc.)
export { ProxyServer, createProxyServer, createSandboxedProxyServer } from './server.js';
export type { ProxyServerConfig } from './server.js';
