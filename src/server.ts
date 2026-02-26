/**
 * RelayPlane Agent Ops Proxy Server
 *
 * OpenAI-compatible proxy server with integrated observability via the Learning Ledger
 * and auth enforcement via Auth Gate.
 *
 * Features:
 * - OpenAI-compatible `/v1/chat/completions` endpoint
 * - Auth Gate integration for consumer vs API auth detection
 * - Learning Ledger integration for run tracking
 * - Timing capture (latency_ms, ttft_ms)
 * - Structured error handling
 *
 * @packageDocumentation
 */

import * as http from 'node:http';
import { Ledger, createLedger } from '@relayplane/ledger';
import {
  AuthGate,
  createAuthGate,
  MemoryAuthProfileStorage,
  type AuthProfileStorage,
  type AuthResult,
} from '@relayplane/auth-gate';
import {
  PolicyEngine,
  createPolicyEngine,
  MemoryPolicyStorage,
  type PolicyStorage,
} from '@relayplane/policy-engine';
import {
  RoutingEngine,
  createRoutingEngine,
  createCapabilityRegistry,
  createProviderManagerWithBuiltIns,
  type CapabilityRegistry,
  type ProviderManager,
  type RoutingRequest,
  type Capability,
} from '@relayplane/routing-engine';
import {
  ExplanationEngine,
  createExplanationEngine,
  RunComparator,
  createRunComparator,
  Simulator,
  createSimulator,
  type PolicySimulationRequest,
  type RoutingSimulationRequest,
} from '@relayplane/explainability';
import type { AuthEnforcementMode, ExecutionMode, AuthType, LedgerStorage } from '@relayplane/ledger';
import {
  LearningEngine,
  createLearningEngine,
  type LearningEngineConfig,
} from '@relayplane/learning-engine';
import { RelayPlaneMiddleware } from './middleware.js';
import { type RelayPlaneConfig, type MeshConfig, resolveConfig, resolveMeshConfig } from './relay-config.js';
import { initMesh, type MeshHandle } from './mesh.js';

/**
 * Proxy server configuration
 */
export interface ProxyServerConfig {
  port?: number;
  host?: string;
  ledger?: Ledger;
  authStorage?: AuthProfileStorage;
  policyStorage?: PolicyStorage;
  policyEngine?: PolicyEngine;
  verbose?: boolean;

  // Default workspace settings (used when workspace not found)
  defaultWorkspaceId?: string;
  defaultAgentId?: string;
  defaultAuthEnforcementMode?: AuthEnforcementMode;

  // Policy enforcement (soft by default in Phase 2)
  enforcePolicies?: boolean;

  // Routing engine (Phase 3)
  routingEngine?: RoutingEngine;
  capabilityRegistry?: CapabilityRegistry;
  providerManager?: ProviderManager;
  /** Enable capability-based routing (Phase 3) */
  enableRouting?: boolean;

  // Learning Engine (Phase 5)
  learningEngine?: LearningEngine;
  /** Enable learning engine analytics and suggestions (default: false) */
  enableLearning?: boolean;
  learningConfig?: LearningEngineConfig;

  // Mesh learning layer (Phase 6)
  /** Mesh config overrides */
  meshConfig?: Partial<MeshConfig>;
  /** Enable mesh learning layer (default: true) */
  enableMesh?: boolean;

  // Provider configuration (legacy, used when routing disabled)
  providers?: {
    anthropic?: { apiKey: string; baseUrl?: string };
    openai?: { apiKey: string; baseUrl?: string };
    openrouter?: { apiKey: string; baseUrl?: string };
    google?: { apiKey: string; baseUrl?: string };
    together?: { apiKey: string; baseUrl?: string };
    deepseek?: { apiKey: string; baseUrl?: string };
  };
}

/**
 * OpenAI-compatible chat completion request
 */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string } }>;
  [key: string]: unknown;
}

/**
 * Error response format
 */
interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
    run_id?: string;
  };
}

/**
 * Provider endpoint configuration
 */
const PROVIDER_ENDPOINTS: Record<string, { baseUrl: string; authHeader: string }> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'Authorization',
  },
};

/**
 * Model to provider mapping
 */
function getProviderForModel(model: string): string {
  if (model.startsWith('claude') || model.startsWith('anthropic')) {
    return 'anthropic';
  }
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai';
  }
  // Default to openrouter for other models
  return 'openrouter';
}

/**
 * RelayPlane Agent Ops Proxy Server
 */
export class ProxyServer {
  private server: http.Server | null = null;
  private ledger: Ledger;
  private authGate: AuthGate;
  private policyEngine: PolicyEngine;
  private routingEngine: RoutingEngine;
  private capabilityRegistry: CapabilityRegistry;
  private providerManager: ProviderManager;
  private explainer: ExplanationEngine;
  private comparator: RunComparator;
  private simulator: Simulator;
  private learningEngine: LearningEngine | null = null;
  private meshHandle: MeshHandle | null = null;
  private meshConfig: MeshConfig;
  private config: Required<
    Pick<ProxyServerConfig, 'port' | 'host' | 'verbose' | 'defaultWorkspaceId' | 'defaultAgentId' | 'defaultAuthEnforcementMode' | 'enforcePolicies' | 'enableRouting' | 'enableLearning'>
  > &
    ProxyServerConfig;

  constructor(config: ProxyServerConfig = {}) {
    this.config = {
      port: config.port ?? 4801,
      host: config.host ?? '127.0.0.1',
      verbose: config.verbose ?? false,
      defaultWorkspaceId: config.defaultWorkspaceId ?? 'default',
      defaultAgentId: config.defaultAgentId ?? 'default',
      defaultAuthEnforcementMode: config.defaultAuthEnforcementMode ?? 'recommended',
      enforcePolicies: config.enforcePolicies ?? true,
      enableRouting: config.enableRouting ?? true,
      enableLearning: config.enableLearning ?? false,
      enableMesh: config.enableMesh ?? true,
      ...config,
    };

    // Initialize mesh config
    this.meshConfig = resolveMeshConfig(config.meshConfig);

    // Initialize ledger
    this.ledger = config.ledger ?? createLedger();

    // Initialize auth storage and gate
    const authStorage = config.authStorage ?? new MemoryAuthProfileStorage();
    this.authGate = createAuthGate({
      storage: authStorage,
      ledger: this.ledger,
      defaultSettings: {
        auth_enforcement_mode: this.config.defaultAuthEnforcementMode,
      },
    });

    // Initialize policy engine
    const policyStorage = config.policyStorage ?? new MemoryPolicyStorage();
    this.policyEngine = config.policyEngine ?? createPolicyEngine({
      storage: policyStorage,
      ledger: this.ledger,
    });

    // Initialize routing engine (Phase 3)
    this.capabilityRegistry = config.capabilityRegistry ?? createCapabilityRegistry({
      providerOverrides: this.buildProviderOverrides(),
    });
    this.providerManager = config.providerManager ?? createProviderManagerWithBuiltIns();
    this.routingEngine = config.routingEngine ?? createRoutingEngine({
      registry: this.capabilityRegistry,
      ledger: this.ledger,
    });

    // Initialize explainability components (Phase 4)
    this.explainer = createExplanationEngine({
      ledger: this.ledger,
      policyEngine: this.policyEngine,
      routingEngine: this.routingEngine,
      capabilityRegistry: this.capabilityRegistry,
    });
    this.comparator = createRunComparator({
      ledger: this.ledger,
      explanationEngine: this.explainer,
    });
    this.simulator = createSimulator({
      policyEngine: this.policyEngine,
      routingEngine: this.routingEngine,
      capabilityRegistry: this.capabilityRegistry,
    });

    // Initialize learning engine (Phase 5)
    if (this.config.enableLearning) {
      const ledgerMaybe = this.ledger as unknown as { getStorage?: () => unknown };
      const ledgerStorage = typeof ledgerMaybe.getStorage === 'function'
        ? ledgerMaybe.getStorage()
        : this.ledger;
      this.learningEngine = config.learningEngine ?? createLearningEngine(
        ledgerStorage as any,
        undefined,
        config.learningConfig,
      );
    }

    // Set API keys from config
    this.configureProviderApiKeys();
  }

  /**
   * Build provider overrides from config
   */
  private buildProviderOverrides(): Record<string, { base_url?: string; enabled?: boolean }> {
    const overrides: Record<string, { base_url?: string; enabled?: boolean }> = {};
    const providers = this.config.providers ?? {};

    if (providers.anthropic) {
      overrides.anthropic = {
        enabled: true,
        base_url: providers.anthropic.baseUrl,
      };
    }
    if (providers.openai) {
      overrides.openai = {
        enabled: true,
        base_url: providers.openai.baseUrl,
      };
    }
    if (providers.openrouter) {
      overrides.openrouter = {
        enabled: true,
        base_url: providers.openrouter.baseUrl,
      };
    }
    if (providers.google) {
      overrides.google = {
        enabled: true,
        base_url: providers.google.baseUrl,
      };
    }
    if (providers.together) {
      overrides.together = {
        enabled: true,
        base_url: providers.together.baseUrl,
      };
    }
    if (providers.deepseek) {
      overrides.deepseek = {
        enabled: true,
        base_url: providers.deepseek.baseUrl,
      };
    }

    return overrides;
  }

  /**
   * Configure provider API keys from config
   */
  private configureProviderApiKeys(): void {
    const providers = this.config.providers ?? {};

    if (providers.anthropic?.apiKey) {
      this.providerManager.setApiKey('anthropic', providers.anthropic.apiKey);
    }
    if (providers.openai?.apiKey) {
      this.providerManager.setApiKey('openai', providers.openai.apiKey);
    }
    if (providers.openrouter?.apiKey) {
      this.providerManager.setApiKey('openrouter', providers.openrouter.apiKey);
    }
    if (providers.google?.apiKey) {
      this.providerManager.setApiKey('google', providers.google.apiKey);
    }
    if (providers.together?.apiKey) {
      this.providerManager.setApiKey('together', providers.together.apiKey);
    }
    if (providers.deepseek?.apiKey) {
      this.providerManager.setApiKey('deepseek', providers.deepseek.apiKey);
    }

    // Also try environment variables
    const configs = this.capabilityRegistry.getEnabledProviders();
    this.providerManager.setApiKeysFromEnv(configs);
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    // Initialize mesh learning layer (non-blocking, graceful degradation)
    if (this.config.enableMesh && this.meshConfig.enabled) {
      try {
        this.meshHandle = await initMesh(this.meshConfig);
        this.log('info', 'Mesh learning layer initialized');
      } catch (err) {
        this.log('error', `Mesh init failed (continuing without): ${err}`);
      }
    }

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.log('error', `Unhandled error: ${err}`);
          this.sendError(res, 500, 'internal_error', 'Internal server error');
        });
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.log('info', `RelayPlane Proxy listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    // Stop mesh learning layer
    if (this.meshHandle) {
      try { this.meshHandle.stop(); } catch { /* ignore */ }
      this.meshHandle = null;
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.log('info', 'Proxy server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-RelayPlane-Workspace, X-RelayPlane-Agent, X-RelayPlane-Session, X-RelayPlane-Automated');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
      return;
    }

    // OpenAI-compatible chat completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await this.handleChatCompletions(req, res);
      return;
    }

    // Models endpoint (for client compatibility)
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-3-5-sonnet', object: 'model', owned_by: 'anthropic' },
            { id: 'claude-3-5-haiku', object: 'model', owned_by: 'anthropic' },
            { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
          ],
        })
      );
      return;
    }

    // Policy Management API (Phase 2)
    if (url.pathname === '/v1/policies' && req.method === 'GET') {
      await this.handleListPolicies(req, res);
      return;
    }

    if (url.pathname === '/v1/policies' && req.method === 'POST') {
      await this.handleCreatePolicy(req, res);
      return;
    }

    if (url.pathname.startsWith('/v1/policies/') && req.method === 'GET') {
      const policyId = url.pathname.split('/')[3];
      if (policyId) {
        await this.handleGetPolicy(res, policyId);
        return;
      }
    }

    if (url.pathname.startsWith('/v1/policies/') && req.method === 'PATCH') {
      const policyId = url.pathname.split('/')[3];
      if (policyId) {
        await this.handleUpdatePolicy(req, res, policyId);
        return;
      }
    }

    if (url.pathname.startsWith('/v1/policies/') && req.method === 'DELETE') {
      const policyId = url.pathname.split('/')[3];
      if (policyId) {
        await this.handleDeletePolicy(res, policyId);
        return;
      }
    }

    if (url.pathname === '/v1/policies/test' && req.method === 'POST') {
      await this.handlePolicyTest(req, res);
      return;
    }

    // Budget state endpoint
    if (url.pathname === '/v1/budget' && req.method === 'GET') {
      await this.handleGetBudget(req, res);
      return;
    }

    // ========================================================================
    // Explainability API (Phase 4)
    // ========================================================================

    // GET /v1/runs/{id}/explain - Full decision chain explanation
    if (url.pathname.match(/^\/v1\/runs\/[^/]+\/explain$/) && req.method === 'GET') {
      const runId = url.pathname.split('/')[3];
      const format = url.searchParams.get('format') ?? 'full';
      await this.handleExplainRun(res, runId, format);
      return;
    }

    // GET /v1/runs/{id}/timeline - Timeline view only
    if (url.pathname.match(/^\/v1\/runs\/[^/]+\/timeline$/) && req.method === 'GET') {
      const runId = url.pathname.split('/')[3];
      await this.handleRunTimeline(res, runId);
      return;
    }

    // GET /v1/runs/{id}/decisions - Raw decision chain
    if (url.pathname.match(/^\/v1\/runs\/[^/]+\/decisions$/) && req.method === 'GET') {
      const runId = url.pathname.split('/')[3];
      await this.handleRunDecisions(res, runId);
      return;
    }

    // GET /v1/runs/{id} - Run inspector (all details)
    if (url.pathname.match(/^\/v1\/runs\/[^/]+$/) && req.method === 'GET') {
      const runId = url.pathname.split('/')[3];
      await this.handleRunInspector(res, runId);
      return;
    }

    // GET /v1/runs/compare?ids=run1,run2 - Run comparison
    if (url.pathname === '/v1/runs/compare' && req.method === 'GET') {
      const idsParam = url.searchParams.get('ids');
      const includeDecisions = url.searchParams.get('include_decisions') === 'true';
      await this.handleCompareRuns(res, idsParam, includeDecisions);
      return;
    }

    // POST /v1/simulate/policy - Policy simulation
    if (url.pathname === '/v1/simulate/policy' && req.method === 'POST') {
      await this.handleSimulatePolicy(req, res);
      return;
    }

    // POST /v1/simulate/routing - Routing simulation
    if (url.pathname === '/v1/simulate/routing' && req.method === 'POST') {
      await this.handleSimulateRouting(req, res);
      return;
    }

    // ========================================================================
    // Learning Engine API (Phase 5)
    // ========================================================================

    if (this.learningEngine) {
      // GET /v1/analytics/summary
      if (url.pathname === '/v1/analytics/summary' && req.method === 'GET') {
        await this.handleAnalyticsSummary(req, res);
        return;
      }

      // POST /v1/analytics/analyze
      if (url.pathname === '/v1/analytics/analyze' && req.method === 'POST') {
        await this.handleRunAnalysis(req, res);
        return;
      }

      // GET /v1/suggestions
      if (url.pathname === '/v1/suggestions' && req.method === 'GET') {
        await this.handleListSuggestions(req, res);
        return;
      }

      // POST /v1/suggestions/:id/approve
      if (url.pathname.match(/^\/v1\/suggestions\/[^/]+\/approve$/) && req.method === 'POST') {
        const id = url.pathname.split('/')[3];
        await this.handleApproveSuggestion(req, res, id);
        return;
      }

      // POST /v1/suggestions/:id/reject
      if (url.pathname.match(/^\/v1\/suggestions\/[^/]+\/reject$/) && req.method === 'POST') {
        const id = url.pathname.split('/')[3];
        await this.handleRejectSuggestion(req, res, id);
        return;
      }

      // GET /v1/rules
      if (url.pathname === '/v1/rules' && req.method === 'GET') {
        await this.handleListRules(req, res);
        return;
      }

      // GET /v1/rules/:id/effectiveness
      if (url.pathname.match(/^\/v1\/rules\/[^/]+\/effectiveness$/) && req.method === 'GET') {
        const id = url.pathname.split('/')[3];
        await this.handleRuleEffectiveness(res, id);
        return;
      }
    }

    // ========================================================================
    // Mesh Learning Layer API (Phase 6)
    // ========================================================================

    if (url.pathname === '/v1/mesh/status' && req.method === 'GET') {
      const status = this.meshHandle?.getStatus() ?? { available: false, enabled: false, atomCount: 0, contributing: false, meshUrl: '', dataDir: '' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mesh: status }));
      return;
    }

    if (url.pathname === '/v1/mesh/tips' && req.method === 'GET') {
      const tips = this.meshHandle?.getTips(20) ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tips }));
      return;
    }

    if (url.pathname === '/v1/mesh/sync' && req.method === 'POST') {
      const result = await (this.meshHandle?.sync() ?? Promise.resolve(null));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sync: result ?? { error: 'Mesh not available or not contributing' } }));
      return;
    }

    // 404 for unknown routes
    this.sendError(res, 404, 'not_found', `Unknown endpoint: ${url.pathname}`);
  }

  // ============================================================================
  // Policy Management Handlers (Phase 2)
  // ============================================================================

  private async handleListPolicies(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const policies = await this.policyEngine.listPolicies(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policies }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleCreatePolicy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const policy = JSON.parse(body);

      const policyId = await this.policyEngine.createPolicy(policy);
      const created = await this.policyEngine.getPolicy(policyId);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policy: created }));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Invalid policy');
    }
  }

  private async handleGetPolicy(res: http.ServerResponse, policyId: string): Promise<void> {
    try {
      const policy = await this.policyEngine.getPolicy(policyId);

      if (!policy) {
        this.sendError(res, 404, 'not_found', 'Policy not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policy }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleUpdatePolicy(req: http.IncomingMessage, res: http.ServerResponse, policyId: string): Promise<void> {
    try {
      const body = await this.readBody(req);
      const updates = JSON.parse(body);

      await this.policyEngine.updatePolicy(policyId, updates);
      const updated = await this.policyEngine.getPolicy(policyId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policy: updated }));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Invalid update');
    }
  }

  private async handleDeletePolicy(res: http.ServerResponse, policyId: string): Promise<void> {
    try {
      await this.policyEngine.deletePolicy(policyId);

      res.writeHead(204);
      res.end();
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handlePolicyTest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const testRequest = JSON.parse(body);

      const decision = await this.policyEngine.dryRun(testRequest);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision }));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Invalid test request');
    }
  }

  private async handleGetBudget(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      const scopeType = (url.searchParams.get('scope_type') ?? 'workspace') as 'workspace' | 'agent' | 'project' | 'team';
      const scopeId = url.searchParams.get('scope_id') ?? workspaceId;
      const period = (url.searchParams.get('period') ?? 'day') as 'run' | 'day' | 'month';

      const state = await this.policyEngine.getBudgetState(workspaceId, scopeType, scopeId, period);

      if (!state) {
        // Return empty state if no budget configured
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ budget_state: null, message: 'No budget state found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ budget_state: state }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  // ============================================================================
  // Explainability Handlers (Phase 4)
  // ============================================================================

  /**
   * Handle GET /v1/runs/{id}/explain - Full decision chain explanation
   */
  private async handleExplainRun(
    res: http.ServerResponse, 
    runId: string, 
    format: string
  ): Promise<void> {
    try {
      const explanation = await this.explainer.explain(
        runId, 
        format as 'full' | 'summary' | 'timeline' | 'debug'
      );

      if (!explanation) {
        this.sendError(res, 404, 'not_found', `Run not found: ${runId}`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        run_id: runId,
        format,
        chain: explanation.chain,
        timeline: explanation.timeline,
        narrative: explanation.narrative,
        debug_info: explanation.debug_info,
      }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Handle GET /v1/runs/{id}/timeline - Timeline view only
   */
  private async handleRunTimeline(res: http.ServerResponse, runId: string): Promise<void> {
    try {
      const timeline = await this.explainer.getTimeline(runId);

      if (timeline.length === 0) {
        this.sendError(res, 404, 'not_found', `Run not found: ${runId}`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, timeline }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Handle GET /v1/runs/{id}/decisions - Raw decision chain
   */
  private async handleRunDecisions(res: http.ServerResponse, runId: string): Promise<void> {
    try {
      const chain = await this.explainer.getDecisionChain(runId);

      if (!chain) {
        this.sendError(res, 404, 'not_found', `Run not found: ${runId}`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        run_id: runId,
        decisions: chain.decisions,
        summary: chain.summary,
        insights: chain.insights,
      }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Handle GET /v1/runs/{id} - Run inspector (all details)
   */
  private async handleRunInspector(res: http.ServerResponse, runId: string): Promise<void> {
    try {
      // Get run from ledger
      const run = await this.ledger.getRun(runId);

      if (!run) {
        this.sendError(res, 404, 'not_found', `Run not found: ${runId}`);
        return;
      }

      // Get events
      const events = await this.ledger.getRunEvents(runId);

      // Get decision chain
      const chain = await this.explainer.getDecisionChain(runId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        run,
        events,
        decision_chain: chain,
      }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Handle GET /v1/runs/compare?ids=run1,run2 - Run comparison
   */
  private async handleCompareRuns(
    res: http.ServerResponse, 
    idsParam: string | null, 
    includeDecisions: boolean
  ): Promise<void> {
    try {
      if (!idsParam) {
        this.sendError(res, 400, 'invalid_request', 'Missing required parameter: ids');
        return;
      }

      const runIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);

      if (runIds.length < 2) {
        this.sendError(res, 400, 'invalid_request', 'At least 2 run IDs required for comparison');
        return;
      }

      const comparison = await this.comparator.compare(runIds, {
        includeDecisionDiff: includeDecisions,
      });

      if (!comparison) {
        this.sendError(res, 404, 'not_found', 'One or more runs not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(comparison));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Handle POST /v1/simulate/policy - Policy simulation
   */
  private async handleSimulatePolicy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as PolicySimulationRequest;

      // Use workspace from header if not in body
      if (!request.workspace_id) {
        request.workspace_id = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      }

      const result = await this.simulator.simulatePolicy(request);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Invalid simulation request');
    }
  }

  /**
   * Handle POST /v1/simulate/routing - Routing simulation
   */
  private async handleSimulateRouting(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as RoutingSimulationRequest;

      // Use workspace from header if not in body
      if (!request.workspace_id) {
        request.workspace_id = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      }

      const result = await this.simulator.simulateRouting(request);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Invalid simulation request');
    }
  }

  /**
   * Handle /v1/chat/completions
   */
  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startTime = Date.now();
    let runId: string = '';

    try {
      // Parse request body
      const body = await this.readBody(req);
      const request = JSON.parse(body) as ChatCompletionRequest;

      // Extract metadata from headers
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const agentId = (req.headers['x-relayplane-agent'] as string) ?? this.config.defaultAgentId;
      const sessionId = req.headers['x-relayplane-session'] as string | undefined;
      const isAutomated = req.headers['x-relayplane-automated'] === 'true';

      // Determine provider
      const provider = getProviderForModel(request.model);

      // Detect auth type from Authorization header
      const authHeader = req.headers['authorization'];
      const authType: AuthType = this.detectAuthType(authHeader);
      const executionMode: ExecutionMode = isAutomated ? 'background' : 'interactive';

      // Validate auth via Auth Gate
      const authResult = await this.authGate.validate({
        workspace_id: workspaceId,
        metadata: {
          session_type: isAutomated ? 'background' : 'interactive',
          headers: {
            'X-RelayPlane-Automated': isAutomated ? 'true' : 'false',
          },
        },
      });

      // Start ledger run
      runId = await this.ledger.startRun({
        workspace_id: workspaceId,
        agent_id: agentId,
        session_id: sessionId,
        provider,
        model: request.model,
        auth_type: authType,
        execution_mode: executionMode,
        compliance_mode: this.config.defaultAuthEnforcementMode,
        auth_risk: authResult.ledger_flags.auth_risk,
        policy_override: authResult.ledger_flags.policy_override,
      });

      // Record auth validation
      await this.authGate.emitAuthEvent(runId, authResult);

      // Check if auth was denied
      if (!authResult.allow) {
        const latencyMs = Date.now() - startTime;
        await this.ledger.completeRun(runId, {
          status: 'failed',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          latency_ms: latencyMs,
          error: {
            code: 'auth_denied',
            message: authResult.reason ?? 'Authentication denied',
            retryable: false,
          },
        });

        this.sendError(res, 403, 'auth_denied', authResult.reason ?? 'Authentication denied', runId, authResult.guidance_url ?? undefined);
        return;
      }

      // Evaluate policies (Phase 2)
      if (this.config.enforcePolicies) {
        const estimatedCost = this.policyEngine.estimateCost(
          request.model,
          provider,
          request.messages?.reduce((sum, m) => sum + (m.content?.length ?? 0) / 4, 0) ?? 1000, // Rough token estimate
          request.max_tokens ?? 1000
        );

        const policyDecision = await this.policyEngine.evaluate({
          workspace_id: workspaceId,
          agent_id: agentId,
          session_id: sessionId,
          run_id: runId,
          request: {
            model: request.model,
            provider,
            estimated_cost_usd: estimatedCost,
            estimated_tokens: request.max_tokens,
            context_size: request.messages?.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
            tools_requested: request.tools?.map((t) => t.function?.name).filter((n): n is string => !!n),
          },
        });

        // Record policy evaluation in ledger
        await this.ledger.recordPolicyEvaluation(
          runId,
          policyDecision.policies_evaluated.map((p: any) => ({
            policy_id: p.policy_id,
            policy_name: p.policy_name,
            matched: p.matched,
            action_taken: p.action_taken,
          }))
        );

        // Check if policy denied the request
        if (!policyDecision.allow) {
          const latencyMs = Date.now() - startTime;
          await this.ledger.completeRun(runId, {
            status: 'failed',
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            latency_ms: latencyMs,
            error: {
              code: policyDecision.approval_required ? 'approval_required' : 'policy_denied',
              message: policyDecision.reason ?? 'Policy denied the request',
              retryable: false,
            },
          });

          if (policyDecision.approval_required) {
            this.sendError(res, 403, 'approval_required', policyDecision.reason ?? 'Approval required', runId);
          } else {
            this.sendError(res, 403, 'policy_denied', policyDecision.reason ?? 'Policy denied the request', runId);
          }
          return;
        }

        // Apply any modifications from policy (e.g., model downgrade, context cap)
        if (policyDecision.modified_request) {
          if (policyDecision.modified_request.model) {
            request.model = policyDecision.modified_request.model;
          }
        }

        // Log budget warning if present
        if (policyDecision.budget_warning) {
          this.log('info', `Budget warning for ${workspaceId}: ${policyDecision.budget_warning}`);
        }
      }

      // Record routing decision
      await this.ledger.recordRouting(runId, {
        selected_provider: provider,
        selected_model: request.model,
        reason: 'Direct model selection by client',
      });

      // Forward to provider
      const providerConfig = this.config.providers?.[provider as keyof typeof this.config.providers];
      if (!providerConfig?.apiKey) {
        const latencyMs = Date.now() - startTime;
        await this.ledger.completeRun(runId, {
          status: 'failed',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          latency_ms: latencyMs,
          error: {
            code: 'provider_not_configured',
            message: `Provider ${provider} is not configured`,
            retryable: false,
          },
        });

        this.sendError(res, 500, 'provider_not_configured', `Provider ${provider} is not configured`, runId);
        return;
      }

      // Make provider request
      const providerResponse = await this.forwardToProvider(provider, request, providerConfig, runId);
      const latencyMs = Date.now() - startTime;

      if (providerResponse.success) {
        const costUsd = this.estimateCost(provider, providerResponse.usage);

        // Complete run successfully
        await this.ledger.completeRun(runId, {
          status: 'completed',
          input_tokens: providerResponse.usage?.prompt_tokens ?? 0,
          output_tokens: providerResponse.usage?.completion_tokens ?? 0,
          total_tokens: providerResponse.usage?.total_tokens ?? 0,
          cost_usd: costUsd,
          latency_ms: latencyMs,
          ttft_ms: providerResponse.ttft_ms,
        });

        // Record spend for budget tracking (Phase 2)
        if (this.config.enforcePolicies) {
          await this.policyEngine.recordSpend(workspaceId, agentId, runId, costUsd);
        }

        // Capture to mesh learning layer (Phase 6)
        if (this.meshHandle) {
          this.meshHandle.captureRequest({
            toolName: 'chat_completion',
            model: request.model,
            provider,
            success: true,
            costUsd,
            latencyMs,
            inputTokens: providerResponse.usage?.prompt_tokens ?? 0,
            outputTokens: providerResponse.usage?.completion_tokens ?? 0,
            taskType: request.tools?.length ? 'tool_use' : 'chat',
          });
        }

        // Add run_id to response
        const responseData = providerResponse.data as Record<string, unknown>;
        const responseWithMeta = {
          ...responseData,
          relayplane: {
            run_id: runId,
            latency_ms: latencyMs,
            ttft_ms: providerResponse.ttft_ms,
          },
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseWithMeta));
      } else {
        // Complete run with failure
        await this.ledger.completeRun(runId, {
          status: 'failed',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          latency_ms: latencyMs,
          error: {
            code: providerResponse.error?.code ?? 'provider_error',
            message: providerResponse.error?.message ?? 'Provider request failed',
            provider_error: providerResponse.error?.raw,
            retryable: providerResponse.error?.retryable ?? false,
          },
        });

        // Capture failed request to mesh (Phase 6)
        if (this.meshHandle) {
          this.meshHandle.captureRequest({
            toolName: 'chat_completion',
            model: request.model,
            provider,
            success: false,
            costUsd: 0,
            latencyMs,
            inputTokens: 0,
            outputTokens: 0,
            taskType: request.tools?.length ? 'tool_use' : 'chat',
            errorCode: providerResponse.error?.code,
          });
        }

        this.sendError(
          res,
          providerResponse.error?.status ?? 500,
          providerResponse.error?.code ?? 'provider_error',
          providerResponse.error?.message ?? 'Provider request failed',
          runId
        );
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      if (runId) {
        await this.ledger.completeRun(runId, {
          status: 'failed',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          latency_ms: latencyMs,
          error: {
            code: 'internal_error',
            message: errorMessage,
            retryable: false,
          },
        });
      }

      this.sendError(res, 500, 'internal_error', errorMessage, runId ?? undefined);
    }
  }

  /**
   * Forward request to provider
   */
  private async forwardToProvider(
    provider: string,
    request: ChatCompletionRequest,
    config: { apiKey: string; baseUrl?: string },
    runId: string
  ): Promise<{
    success: boolean;
    data?: unknown;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    ttft_ms?: number;
    error?: { code: string; message: string; status: number; retryable: boolean; raw?: unknown };
  }> {
    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!endpoint) {
      return {
        success: false,
        error: {
          code: 'unknown_provider',
          message: `Unknown provider: ${provider}`,
          status: 500,
          retryable: false,
        },
      };
    }

    const baseUrl = config.baseUrl ?? endpoint.baseUrl;
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Set auth header
    if (provider === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    try {
      const ttftStart = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });

      // Record provider call
      await this.ledger.recordProviderCall(runId, {
        provider,
        model: request.model,
        attempt: 1,
        ttft_ms: Date.now() - ttftStart,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsedError: unknown;
        try {
          parsedError = JSON.parse(errorBody);
        } catch {
          parsedError = errorBody;
        }

        return {
          success: false,
          error: {
            code: `provider_${response.status}`,
            message: `Provider returned ${response.status}`,
            status: response.status,
            retryable: response.status >= 500 || response.status === 429,
            raw: parsedError,
          },
        };
      }

      const data = await response.json();
      const ttftMs = Date.now() - ttftStart;

      return {
        success: true,
        data,
        usage: data.usage,
        ttft_ms: ttftMs,
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'network_error',
          message: err instanceof Error ? err.message : 'Network error',
          status: 500,
          retryable: true,
          raw: err,
        },
      };
    }
  }

  /**
   * Detect auth type from Authorization header
   */
  private detectAuthType(authHeader: string | undefined): AuthType {
    if (!authHeader) return 'api';

    // Consumer auth typically uses session tokens or OAuth
    // API auth uses API keys starting with specific prefixes
    if (
      authHeader.includes('sk-ant-') ||
      authHeader.includes('sk-') ||
      authHeader.includes('Bearer sk-')
    ) {
      return 'api';
    }

    // Default to consumer if it looks like a session token
    if (authHeader.startsWith('Bearer ') && authHeader.length > 100) {
      return 'consumer';
    }

    return 'api';
  }

  /**
   * Estimate cost based on provider and usage
   */
  private estimateCost(
    provider: string,
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  ): number {
    if (!usage) return 0;

    // Approximate pricing per 1K tokens
    const pricing: Record<string, { input: number; output: number }> = {
      anthropic: { input: 0.003, output: 0.015 }, // Claude 3.5 Sonnet
      openai: { input: 0.005, output: 0.015 }, // GPT-4o
      openrouter: { input: 0.003, output: 0.015 }, // Varies
    };

    const rates = pricing[provider] ?? { input: 0.003, output: 0.015 };
    return (
      (usage.prompt_tokens / 1000) * rates.input + (usage.completion_tokens / 1000) * rates.output
    );
  }

  /**
   * Read request body
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Send error response
   */
  private sendError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    runId?: string,
    guidanceUrl?: string
  ): void {
    const error: ErrorResponse = {
      error: {
        message,
        type: 'relayplane_error',
        code,
        run_id: runId,
      },
    };

    if (guidanceUrl) {
      (error.error as Record<string, unknown>)['guidance_url'] = guidanceUrl;
    }

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(error));
  }

  // ============================================================================
  // Learning Engine Handlers (Phase 5)
  // ============================================================================

  private async handleAnalyticsSummary(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const from = url.searchParams.get('from') ?? new Date(Date.now() - 7 * 86400000).toISOString();
      const to = url.searchParams.get('to') ?? new Date().toISOString();

      const summary = await this.learningEngine!.getAnalyticsSummary({
        workspace_id: workspaceId,
        from,
        to,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleRunAnalysis(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const result = await this.learningEngine!.runAnalysis(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleListSuggestions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const status = url.searchParams.get('status') as any;

      const suggestions = await this.learningEngine!.listSuggestions({
        workspace_id: workspaceId,
        status: status || undefined,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleApproveSuggestion(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    try {
      const body = await this.readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const rule = await this.learningEngine!.approveSuggestion(id, {
        user_id: parsed.user_id ?? 'system',
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rule }));
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleRejectSuggestion(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    try {
      const body = await this.readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      await this.learningEngine!.rejectSuggestion(id, {
        user_id: parsed.user_id ?? 'system',
        reason: parsed.reason ?? 'Rejected via API',
      });

      res.writeHead(204);
      res.end();
    } catch (err) {
      this.sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleListRules(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const workspaceId = (req.headers['x-relayplane-workspace'] as string) ?? this.config.defaultWorkspaceId;
      const rules = await this.learningEngine!.listRules(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rules }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async handleRuleEffectiveness(res: http.ServerResponse, ruleId: string): Promise<void> {
    try {
      const effectiveness = await this.learningEngine!.getRuleEffectiveness(ruleId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ effectiveness }));
    } catch (err) {
      this.sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Log message
   */
  private log(level: 'info' | 'error' | 'debug', message: string): void {
    if (this.config.verbose || level === 'error') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }
  }

  /**
   * Get the ledger instance (useful for testing)
   */
  getLedger(): Ledger {
    return this.ledger;
  }

  /**
   * Get the auth gate instance (useful for testing)
   */
  getAuthGate(): AuthGate {
    return this.authGate;
  }

  /**
   * Get the policy engine instance (useful for testing and policy management)
   */
  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  /**
   * Get the routing engine instance (Phase 3)
   */
  getRoutingEngine(): RoutingEngine {
    return this.routingEngine;
  }

  /**
   * Get the capability registry instance (Phase 3)
   */
  getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  /**
   * Get the provider manager instance (Phase 3)
   */
  getProviderManager(): ProviderManager {
    return this.providerManager;
  }

  /**
   * Get the explanation engine instance (Phase 4)
   */
  getExplainer(): ExplanationEngine {
    return this.explainer;
  }

  /**
   * Get the run comparator instance (Phase 4)
   */
  getComparator(): RunComparator {
    return this.comparator;
  }

  /**
   * Get the simulator instance (Phase 4)
   */
  getSimulator(): Simulator {
    return this.simulator;
  }
  /**
   * Get the learning engine instance (Phase 5)
   */
  getLearningEngine(): LearningEngine | null {
    return this.learningEngine;
  }

  /**
   * Get the mesh handle instance (Phase 6)
   */
  getMeshHandle(): MeshHandle | null {
    return this.meshHandle;
  }
}

/**
 * Create a new proxy server
 */
export function createProxyServer(config?: ProxyServerConfig): ProxyServer {
  return new ProxyServer(config);
}

/**
 * Create a proxy server with optional circuit breaker middleware wrapping.
 * This gives the advanced proxy the same circuit breaker protection as standalone.
 */
export function createSandboxedProxyServer(config?: ProxyServerConfig & {
  relayplane?: Partial<RelayPlaneConfig>;
}): { server: ProxyServer; middleware?: RelayPlaneMiddleware } {
  const server = createProxyServer(config);

  if (config?.relayplane?.enabled) {
    const middleware = new RelayPlaneMiddleware(resolveConfig(config.relayplane));
    return { server, middleware };
  }

  return { server };
}
