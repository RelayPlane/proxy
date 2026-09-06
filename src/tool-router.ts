/**
 * ToolRouter - deny-by-default tool authorization with named scope packs.
 *
 * CAP 2: Hierarchical Tool Routing (Phase 2, Session 3)
 *
 * Authorization flow (highest-priority last wins):
 *   1. Default deny all
 *   2. Apply active packs (based on X-Task-Type header)
 *   3. Apply agent-level overrides (based on X-Agent-Id header)
 *   4. Apply explicit deny list (always wins)
 *
 * Lazy schema loading: schemas fetched only when a tool is (a) allowed AND (b) actually called.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Public Types ──────────────────────────────────────────────────────────────

export interface ToolRateLimit {
  maxCallsPerSession: number;
  maxCallsPerMinute: number;
}

export interface ToolEntry {
  name: string;
  /** Optional URL or file path to a JSON schema for this tool */
  schemaRef?: string;
  /** 'inherit' defers to the pack's defaultPolicy */
  policy: 'allow' | 'deny' | 'inherit';
  requiresConfirmation?: boolean;
  rateLimit?: ToolRateLimit;
}

export interface ToolPack {
  name: string;
  description: string;
  tools: ToolEntry[];
  /** Policy applied to tools NOT listed in this pack */
  defaultPolicy: 'allow' | 'deny';
  version: string;
  /** True for the three built-in packs - cannot be deleted */
  builtIn?: boolean;
}

export interface AgentAuthConfig {
  agentId: string;
  allowPacks: string[];
  denyPacks: string[];
  /** Per-tool overrides: tool name → 'allow' | 'deny' */
  toolOverrides: Record<string, 'allow' | 'deny'>;
}

export interface ToolAuthContext {
  sessionId: string;
  agentId?: string;
  taskType?: string;
  activePacks: string[];
  denyList: string[];
  requestedTools: string[];
}

export interface ToolAuthResult {
  /** Tools explicitly allowed by the active packs */
  allowed: string[];
  /** Tools denied (not in any active pack, or explicitly denied) */
  denied: string[];
  /** Comma-separated list for the X-Relay-Tools-Denied response header */
  deniedHeader: string;
  /** Tools that require user confirmation before being called */
  requireConfirmation: string[];
}

export interface ToolCallRecord {
  toolName: string;
  sessionId: string;
  calledAt: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: 'session_limit' | 'minute_limit';
  sessionCount: number;
  minuteCount: number;
}

export interface ToolRouterConfig {
  enabled: boolean;
  /** Extra packs directory (user can place JSON pack files here) */
  packsDir?: string;
  /** Agent configs keyed by agentId */
  agentConfigs?: Record<string, AgentAuthConfig>;
}

export const DEFAULT_TOOL_ROUTER_CONFIG: ToolRouterConfig = {
  enabled: false,
  packsDir: path.join(process.env['RELAYPLANE_HOME_OVERRIDE'] ?? os.homedir(), '.relayplane', 'config', 'tool-packs'),
};

// ── Built-in Packs ────────────────────────────────────────────────────────────

export const BUILTIN_PACKS: ToolPack[] = [
  {
    name: 'code',
    description: 'Coding tools: editor, shell, and file I/O for code-generation agents',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      { name: 'str_replace_editor', policy: 'allow' },
      { name: 'bash',               policy: 'allow' },
      { name: 'read_file',          policy: 'allow' },
      { name: 'write_file',         policy: 'allow' },
      { name: 'list_directory',     policy: 'allow' },
    ],
  },
  {
    name: 'search',
    description: 'Web retrieval tools with per-session and per-minute rate limits',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      {
        name: 'web_search',
        policy: 'allow',
        rateLimit: { maxCallsPerSession: 20, maxCallsPerMinute: 5 },
      },
      {
        name: 'web_fetch',
        policy: 'allow',
        rateLimit: { maxCallsPerSession: 50, maxCallsPerMinute: 10 },
      },
    ],
  },
  {
    name: 'file-ops',
    description: 'File system tools: read/write/list allowed, delete denied',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      { name: 'read_file',      policy: 'allow' },
      { name: 'write_file',     policy: 'allow' },
      { name: 'list_directory', policy: 'allow' },
      { name: 'delete_file',    policy: 'deny' },
    ],
  },
];

// ── Schema cache (lazy) ───────────────────────────────────────────────────────

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ── Rate limit state ──────────────────────────────────────────────────────────

interface MinuteWindow {
  window: string;   // "YYYY-MM-DDTHH:mm"
  count: number;
}

interface ToolUsageState {
  sessionCount: number;
  minuteWindows: MinuteWindow[];
}

function getMinuteWindow(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── ToolRouter class ──────────────────────────────────────────────────────────

export class ToolRouter {
  private static _instance: ToolRouter | null = null;

  private config: ToolRouterConfig;
  /** All packs (built-in + custom) keyed by name */
  private packs: Map<string, ToolPack> = new Map();
  /** Lazy schema cache: toolName → schema */
  private schemaCache: Map<string, ToolSchema> = new Map();
  /** Rate limit state: `${sessionId}:${toolName}` → usage */
  private usageState: Map<string, ToolUsageState> = new Map();

  constructor(config?: Partial<ToolRouterConfig>) {
    this.config = { ...DEFAULT_TOOL_ROUTER_CONFIG, ...config };
    this._loadPacks();
  }

  static getInstance(config?: Partial<ToolRouterConfig>): ToolRouter {
    if (!ToolRouter._instance) {
      ToolRouter._instance = new ToolRouter(config);
    }
    return ToolRouter._instance;
  }

  static reset(): void {
    ToolRouter._instance = null;
  }

  // ── Pack management ─────────────────────────────────────────────────────────

  private _loadPacks(): void {
    // Load built-ins first
    for (const pack of BUILTIN_PACKS) {
      this.packs.set(pack.name, pack);
    }
    // Then overlay with user-supplied JSON packs from packsDir
    this._loadPacksFromDir();
  }

  private _loadPacksFromDir(): void {
    const dir = this.config.packsDir;
    if (!dir) return;
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
          const pack = JSON.parse(raw) as ToolPack;
          if (pack.name && Array.isArray(pack.tools)) {
            // Never overwrite builtIn flag from disk
            pack.builtIn = false;
            this.packs.set(pack.name, pack);
          }
        } catch {
          // Skip malformed pack files
        }
      }
    } catch {
      // Skip if dir unreadable
    }
  }

  /** Persist a custom pack to the packs directory */
  private _persistPack(pack: ToolPack): void {
    const dir = this.config.packsDir;
    if (!dir) return;
    // Guard: reject names that could escape the packs directory (path traversal)
    if (!/^[a-z0-9_-]+$/.test(pack.name)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${pack.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(pack, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }

  private _deletePersisted(name: string): void {
    const dir = this.config.packsDir;
    if (!dir) return;
    // Guard: reject names that could escape the packs directory (path traversal)
    if (!/^[a-z0-9_-]+$/.test(name)) return;
    try {
      const filePath = path.join(dir, `${name}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Best-effort
    }
  }

  listPacks(): ToolPack[] {
    return [...this.packs.values()];
  }

  getPack(name: string): ToolPack | undefined {
    return this.packs.get(name);
  }

  createPack(pack: Omit<ToolPack, 'builtIn'>): ToolPack {
    if (this.packs.has(pack.name)) {
      throw new Error(`Pack "${pack.name}" already exists`);
    }
    const newPack: ToolPack = { ...pack, builtIn: false };
    this.packs.set(newPack.name, newPack);
    this._persistPack(newPack);
    return newPack;
  }

  updatePack(name: string, updates: Partial<Omit<ToolPack, 'name' | 'builtIn'>>): ToolPack {
    const existing = this.packs.get(name);
    if (!existing) throw new Error(`Pack "${name}" not found`);
    if (existing.builtIn) throw new Error(`Cannot modify built-in pack "${name}"`);
    const updated: ToolPack = { ...existing, ...updates, name, builtIn: false };
    this.packs.set(name, updated);
    this._persistPack(updated);
    return updated;
  }

  deletePack(name: string): void {
    const pack = this.packs.get(name);
    if (!pack) throw new Error(`Pack "${name}" not found`);
    if (pack.builtIn) throw new Error(`Cannot delete built-in pack "${name}"`);
    this.packs.delete(name);
    this._deletePersisted(name);
  }

  // ── Authorization ────────────────────────────────────────────────────────────

  /**
   * Determine which packs are active for the current request.
   *
   * X-Task-Type header format:
   *   - "code" | "search" | "file-ops"  → named built-in pack
   *   - "custom:{pack-name}"             → custom pack
   *   - undefined                        → no packs active (deny all)
   */
  resolveActivePacks(taskType?: string, agentId?: string): string[] {
    const active: string[] = [];

    if (taskType) {
      if (taskType.startsWith('custom:')) {
        const customName = taskType.slice(7).trim();
        if (customName && this.packs.has(customName)) {
          active.push(customName);
        }
      } else {
        // Map task-type to built-in pack name (they share names)
        if (this.packs.has(taskType)) {
          active.push(taskType);
        }
      }
    }

    // Apply agent-level pack additions/removals
    if (agentId && this.config.agentConfigs) {
      const agentCfg = this.config.agentConfigs[agentId];
      if (agentCfg) {
        for (const p of agentCfg.allowPacks) {
          if (this.packs.has(p) && !active.includes(p)) active.push(p);
        }
        for (const p of agentCfg.denyPacks) {
          const idx = active.indexOf(p);
          if (idx !== -1) active.splice(idx, 1);
        }
      }
    }

    return active;
  }

  /**
   * Check which of the requested tools are allowed given active packs and agent config.
   * Does NOT enforce rate limits (call checkRateLimit separately).
   */
  checkTools(ctx: ToolAuthContext): ToolAuthResult {
    if (!this.config.enabled) {
      // When router is disabled, allow everything
      return {
        allowed: ctx.requestedTools,
        denied: [],
        deniedHeader: '',
        requireConfirmation: [],
      };
    }

    const allowed: string[] = [];
    const denied: string[] = [];
    const requireConfirmation: string[] = [];

    // Build a fast lookup: toolName → effective policy
    const effectivePolicy = this._resolveEffectivePolicies(
      ctx.activePacks,
      ctx.agentId,
      ctx.denyList,
    );

    for (const tool of ctx.requestedTools) {
      const policy = effectivePolicy.get(tool) ?? 'deny';
      if (policy === 'allow') {
        allowed.push(tool);
        // Check requiresConfirmation
        const entry = this._findToolEntry(tool, ctx.activePacks);
        if (entry?.requiresConfirmation) {
          requireConfirmation.push(tool);
        }
      } else {
        denied.push(tool);
      }
    }

    return {
      allowed,
      denied,
      // Sanitize tool names before embedding in an HTTP response header: strip
      // any character outside printable ASCII (0x20–0x7E) to prevent header
      // pollution or injection through malformed tool names in the request body.
      deniedHeader: denied.map(n => n.replace(/[^\x20-\x7E]/g, '')).join(', '),
      requireConfirmation,
    };
  }

  /**
   * Resolve the effective policy for every known tool, given the active packs,
   * agent overrides, and explicit deny list.
   */
  private _resolveEffectivePolicies(
    activePacks: string[],
    agentId: string | undefined,
    denyList: string[],
  ): Map<string, 'allow' | 'deny'> {
    const policies = new Map<string, 'allow' | 'deny'>();

    // Step 1: Apply active packs in order
    for (const packName of activePacks) {
      const pack = this.packs.get(packName);
      if (!pack) continue;
      for (const entry of pack.tools) {
        const resolved = entry.policy === 'inherit' ? pack.defaultPolicy : entry.policy;
        // Later packs can override earlier ones, but we apply in order
        // (first pack wins for a given tool if there are conflicts)
        if (!policies.has(entry.name)) {
          policies.set(entry.name, resolved);
        }
      }
    }

    // Step 2: Apply agent-level tool overrides
    if (agentId && this.config.agentConfigs) {
      const agentCfg = this.config.agentConfigs[agentId];
      if (agentCfg) {
        for (const [toolName, policy] of Object.entries(agentCfg.toolOverrides)) {
          policies.set(toolName, policy);
        }
      }
    }

    // Step 3: Explicit deny list always wins (highest priority)
    for (const tool of denyList) {
      policies.set(tool, 'deny');
    }

    return policies;
  }

  private _findToolEntry(toolName: string, activePacks: string[]): ToolEntry | undefined {
    for (const packName of activePacks) {
      const pack = this.packs.get(packName);
      if (!pack) continue;
      const entry = pack.tools.find(t => t.name === toolName);
      if (entry) return entry;
    }
    return undefined;
  }

  // ── Rate limiting ────────────────────────────────────────────────────────────

  /**
   * Check rate limit for a specific tool call.
   * Updates internal state on success (i.e. calling this IS the "record call" step).
   */
  checkRateLimit(sessionId: string, toolName: string, activePacks: string[]): RateLimitCheckResult {
    const entry = this._findToolEntry(toolName, activePacks);
    if (!entry?.rateLimit) {
      return { allowed: true, sessionCount: 0, minuteCount: 0 };
    }

    const { maxCallsPerSession, maxCallsPerMinute } = entry.rateLimit;
    const key = `${sessionId}:${toolName}`;
    const now = Date.now();
    const currentWindow = getMinuteWindow(now);

    let state = this.usageState.get(key);
    if (!state) {
      state = { sessionCount: 0, minuteWindows: [] };
      this.usageState.set(key, state);
    }

    // Prune old minute windows (keep only the last 2)
    state.minuteWindows = state.minuteWindows.filter(w => w.window === currentWindow);

    const minuteEntry = state.minuteWindows.find(w => w.window === currentWindow);
    const minuteCount = minuteEntry?.count ?? 0;

    if (state.sessionCount >= maxCallsPerSession) {
      return { allowed: false, reason: 'session_limit', sessionCount: state.sessionCount, minuteCount };
    }
    if (minuteCount >= maxCallsPerMinute) {
      return { allowed: false, reason: 'minute_limit', sessionCount: state.sessionCount, minuteCount };
    }

    // Record the call
    state.sessionCount += 1;
    if (minuteEntry) {
      minuteEntry.count += 1;
    } else {
      state.minuteWindows.push({ window: currentWindow, count: 1 });
    }

    return { allowed: true, sessionCount: state.sessionCount, minuteCount: minuteCount + 1 };
  }

  /** Reset rate limit state for a session (call on session end) */
  clearSessionRateLimits(sessionId: string): void {
    for (const key of this.usageState.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.usageState.delete(key);
      }
    }
  }

  // ── Lazy schema loading ──────────────────────────────────────────────────────

  /**
   * Get the schema for a tool. Only fetches on first call (lazy).
   * Returns undefined if no schemaRef configured or fetch fails.
   */
  async getToolSchema(toolName: string, activePacks: string[]): Promise<ToolSchema | undefined> {
    if (this.schemaCache.has(toolName)) {
      return this.schemaCache.get(toolName);
    }

    const entry = this._findToolEntry(toolName, activePacks);
    if (!entry?.schemaRef) return undefined;

    try {
      let schema: ToolSchema | undefined;
      if (entry.schemaRef.startsWith('http://') || entry.schemaRef.startsWith('https://')) {
        const res = await fetch(entry.schemaRef, { signal: AbortSignal.timeout(3000) });
        if (res.ok) schema = (await res.json()) as ToolSchema;
      } else {
        const raw = fs.readFileSync(entry.schemaRef, 'utf-8');
        schema = JSON.parse(raw) as ToolSchema;
      }
      if (schema) {
        this.schemaCache.set(toolName, schema);
        return schema;
      }
    } catch {
      // Schema load failure is non-fatal - tool is still allowed
    }
    return undefined;
  }

  // ── Session denied tools log ─────────────────────────────────────────────────

  /** In-memory log of denied tool calls keyed by sessionId */
  private deniedLog: Map<string, { toolName: string; ts: number; reason: string }[]> = new Map();

  recordDenied(sessionId: string, toolName: string, reason: string): void {
    let entries = this.deniedLog.get(sessionId);
    if (!entries) {
      entries = [];
      this.deniedLog.set(sessionId, entries);
    }
    entries.push({ toolName, ts: Date.now(), reason });
  }

  getDeniedForSession(sessionId: string): { toolName: string; ts: number; reason: string }[] {
    return this.deniedLog.get(sessionId) ?? [];
  }

  clearDeniedLog(sessionId: string): void {
    this.deniedLog.delete(sessionId);
  }

  // ── MCP tool handlers ────────────────────────────────────────────────────────

  mcpToolPackList(): ToolPack[] {
    return this.listPacks();
  }

  mcpToolPackGet(name: string): ToolPack | undefined {
    return this.getPack(name);
  }

  mcpToolAuthCheck(ctx: ToolAuthContext): ToolAuthResult {
    return this.checkTools(ctx);
  }

  // ── Config ───────────────────────────────────────────────────────────────────

  getConfig(): ToolRouterConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<ToolRouterConfig>): void {
    this.config = { ...this.config, ...updates };
    if (updates.packsDir !== undefined) {
      this._loadPacksFromDir();
    }
  }
}

// ── Singleton convenience ─────────────────────────────────────────────────────

let _toolRouter: ToolRouter | null = null;

export function getToolRouter(config?: Partial<ToolRouterConfig>): ToolRouter {
  if (!_toolRouter) {
    _toolRouter = new ToolRouter(config);
  }
  return _toolRouter;
}

export function resetToolRouter(): void {
  _toolRouter = null;
  ToolRouter.reset();
}

// ── Header extraction helpers ─────────────────────────────────────────────────

/**
 * Extract tool routing context from request headers.
 * Returns activePacks and denyList ready for checkTools().
 */
export function extractToolContext(
  headers: Record<string, string | string[] | undefined>,
  sessionId: string,
  requestedTools: string[],
  router?: ToolRouter,
): ToolAuthContext {
  const rt = router ?? getToolRouter();
  const rawTaskType = Array.isArray(headers['x-task-type'])
    ? headers['x-task-type'][0]
    : headers['x-task-type'];
  const taskType = rawTaskType?.trim();

  const rawAgentId = Array.isArray(headers['x-agent-id'])
    ? headers['x-agent-id'][0]
    : headers['x-agent-id'];
  const agentId = rawAgentId?.trim();

  const activePacks = rt.resolveActivePacks(taskType, agentId);

  return {
    sessionId,
    agentId,
    taskType,
    activePacks,
    denyList: [],
    requestedTools,
  };
}
