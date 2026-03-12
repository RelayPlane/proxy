/**
 * Mesh server routes for recovery atom sharing.
 *
 * Provides HTTP endpoints for proxy instances to contribute,
 * query, and confirm recovery patterns via the mesh.
 *
 * @packageDocumentation
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  type RecoveryAtom,
  MeshRecoveryAtomStore,
  mergeRecoveryAtoms,
  recoveryAtomId,
} from './recovery-mesh.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryMeshServerConfig {
  /** Port to listen on */
  port: number;
  /** API keys that can write (empty = deny all writes unless allowUnauthenticated is true) */
  writeKeys: string[];
  /** API keys that can read (empty = no auth required) */
  readKeys: string[];
  /** Rate limit per key/IP per hour */
  rateLimitPerHour: number;
  /** Pattern expiry in days */
  expiryDays: number;
  /**
   * When true and writeKeys is empty, allow unauthenticated writes.
   * Requires explicit opt-in — empty writeKeys alone no longer grants open write access.
   * /confirm always requires a writeKey regardless of this flag.
   */
  allowUnauthenticated?: boolean;
}

export const DEFAULT_RECOVERY_MESH_CONFIG: RecoveryMeshServerConfig = {
  port: 19600,
  writeKeys: [],
  readKeys: [],
  rateLimitPerHour: 100,
  expiryDays: 30,
  allowUnauthenticated: false,
};

export interface RecoveryMeshServerHandle {
  store: MeshRecoveryAtomStore;
  server: Server;
  stop(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum request body size (1 MB) */
const MAX_BODY_BYTES = 1_048_576;

/** Maximum atoms allowed in a single /contribute request */
const MAX_ATOMS_PER_REQUEST = 100;

/** Maximum allowed value for count fields */
const MAX_COUNT = 10_000;

/** Valid atom type values */
const VALID_ATOM_TYPES = new Set<string>([
  'auth-header',
  'model-rename',
  'timeout-tune',
  'provider-fallback',
]);

/** Valid authHeader values */
const VALID_AUTH_HEADERS = new Set<string>(['Authorization', 'x-api-key']);

/** Known provider names */
const KNOWN_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'google',
  'azure',
  'openrouter',
  'cohere',
  'mistral',
  'bedrock',
  'vertex',
  'groq',
  'together',
  'fireworks',
  'perplexity',
  'deepseek',
  'xai',
  'meta',
  'ollama',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function extractKey(req: IncomingMessage, url: URL): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return url.searchParams.get('key');
}

function makeRateLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function checkRateLimit(key: string, limit: number): boolean {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 3600_000 });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count++;
    return true;
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on('data', (c: Buffer) => {
      if (oversized) return; // discard additional data without buffering
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0; // free already-buffered chunks
        return reject(new Error('Payload too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!oversized) resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

/**
 * Create an HTTP server that handles recovery atom mesh endpoints.
 *
 * Routes:
 *   POST /mesh/recovery/contribute      — submit recovery atoms
 *   GET  /mesh/recovery/atoms?since=    — get recovery atoms (incremental)
 *   POST /mesh/recovery/confirm         — report confirmation/denial (always requires writeKey)
 *   GET  /mesh/recovery/stats           — mesh recovery statistics
 */
export function createRecoveryMeshServer(
  store: MeshRecoveryAtomStore,
  config: RecoveryMeshServerConfig,
): Server {
  // Per-server rate limiter (not module-level) to avoid cross-test interference
  const checkRateLimit = makeRateLimiter();

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      const apiKey = extractKey(req, url);

      // ── Auth: /confirm always requires a valid writeKey (H3)
      // Not exempted by allowUnauthenticated — prevents unauthenticated confidence flooding.
      if (method === 'POST' && path === '/mesh/recovery/confirm') {
        if (!apiKey || config.writeKeys.length === 0 || !config.writeKeys.includes(apiKey)) {
          return json(res, 401, { error: 'Authentication required for confirmations' });
        }
      }
      // ── Auth: all other POSTs (/contribute, etc.) (H1)
      // allowUnauthenticated: true → skip key check (even if writeKeys is set)
      else if (method === 'POST') {
        if (config.allowUnauthenticated) {
          // Explicit opt-in: open write access (e.g., private cluster deployments)
          // /confirm is still always authenticated above
        } else if (config.writeKeys.length > 0) {
          // writeKeys configured — validate the key
          if (!apiKey || !config.writeKeys.includes(apiKey)) {
            return json(res, 401, { error: 'Invalid or missing API key' });
          }
        } else {
          // No writeKeys and no explicit opt-in → deny-by-default (H1)
          return json(res, 401, { error: 'Write access requires authentication' });
        }
      }

      // ── Auth: reads (C2 rate limit applies before this for GETs? No — reads are separate)
      if (method === 'GET' && config.readKeys.length > 0 && path !== '/mesh/recovery/stats') {
        if (!apiKey || !config.readKeys.includes(apiKey)) {
          return json(res, 401, { error: 'Invalid or missing API key' });
        }
      }

      // ── Rate limiting for writes (C2: use IP when no API key)
      if (method === 'POST') {
        const rateLimitKey = apiKey ?? req.socket.remoteAddress ?? 'unknown';
        if (!checkRateLimit(rateLimitKey, config.rateLimitPerHour)) {
          return json(res, 429, { error: 'Rate limit exceeded' });
        }
      }

      // POST /mesh/recovery/contribute — accept recovery atoms
      if (method === 'POST' && path === '/mesh/recovery/contribute') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err: any) {
          if (err.message === 'Payload too large') {
            return json(res, 413, { error: 'Payload too large' });
          }
          return json(res, 400, { error: 'Invalid JSON' });
        }

        const rawAtoms: RecoveryAtom[] = Array.isArray(body) ? body : [body];

        // M3: Limit atoms per request
        if (rawAtoms.length > MAX_ATOMS_PER_REQUEST) {
          return json(res, 400, { error: `Too many atoms: max ${MAX_ATOMS_PER_REQUEST} per request` });
        }

        const results: Array<{ id: string; status: 'created' | 'merged' | 'rejected' }> = [];

        for (const atom of rawAtoms) {
          // Validate required fields
          if (!atom.type || !atom.provider || !atom.trigger || !atom.fix) {
            results.push({ id: atom.id ?? 'unknown', status: 'rejected' });
            continue;
          }

          // M3: Validate atom type against enum
          if (!VALID_ATOM_TYPES.has(atom.type)) {
            results.push({ id: atom.id ?? 'unknown', status: 'rejected' });
            continue;
          }

          // M3: Validate errorCode is a number in valid HTTP range
          const errorCode = atom.trigger?.errorCode;
          if (typeof errorCode !== 'number' || errorCode < 100 || errorCode > 599) {
            results.push({ id: atom.id ?? 'unknown', status: 'rejected' });
            continue;
          }

          // M3: Validate authHeader if present
          if (atom.fix?.authHeader && !VALID_AUTH_HEADERS.has(atom.fix.authHeader)) {
            results.push({ id: atom.id ?? 'unknown', status: 'rejected' });
            continue;
          }

          // M2: Strip unknown fix.provider
          if (atom.fix?.provider && !KNOWN_PROVIDERS.has(atom.fix.provider)) {
            delete atom.fix.provider;
          }

          // H2: Cap numeric fields
          if (typeof atom.confirmCount === 'number') {
            atom.confirmCount = Math.min(atom.confirmCount, MAX_COUNT);
          }
          if (typeof atom.denyCount === 'number') {
            atom.denyCount = Math.min(atom.denyCount, MAX_COUNT);
          }
          if (typeof atom.reportCount === 'number') {
            atom.reportCount = Math.min(atom.reportCount, MAX_COUNT);
          }

          // H2: Recalculate confidence from counts (don't trust client-provided value)
          const totalAttempts = (atom.confirmCount ?? 0) + (atom.denyCount ?? 0);
          atom.confidence = totalAttempts > 0 ? (atom.confirmCount ?? 0) / totalAttempts : 0;

          // Ensure atom has an ID
          if (!atom.id) {
            atom.id = recoveryAtomId(atom.type, atom.provider, atom.trigger);
          }

          // Force recovery atom type
          atom.atomType = 'recovery';

          const existing = store.get(atom.id);
          store.upsert(atom);

          results.push({
            id: atom.id,
            status: existing ? 'merged' : 'created',
          });
        }

        const accepted = results.filter(r => r.status !== 'rejected').length;
        return json(res, 200, { accepted, results });
      }

      // GET /mesh/recovery/atoms?since=<ISO>
      if (method === 'GET' && path === '/mesh/recovery/atoms') {
        const since = url.searchParams.get('since');
        const atoms = since ? store.getSince(since) : store.getAll();
        return json(res, 200, atoms);
      }

      // POST /mesh/recovery/confirm — report confirmation or denial
      if (method === 'POST' && path === '/mesh/recovery/confirm') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err: any) {
          if (err.message === 'Payload too large') {
            return json(res, 413, { error: 'Payload too large' });
          }
          return json(res, 400, { error: 'Invalid JSON' });
        }

        const { patternId, instanceHash, success } = body as Record<string, unknown>;

        if (!patternId) {
          return json(res, 400, { error: 'patternId is required' });
        }

        const atom = store.get(patternId as string);
        if (!atom) {
          return json(res, 404, { error: 'Pattern not found' });
        }

        if (success) {
          store.recordConfirmation(patternId as string);
        } else {
          store.recordDenial(patternId as string);
        }

        return json(res, 200, {
          id: patternId,
          confidence: store.get(patternId as string)!.confidence,
          confirmCount: store.get(patternId as string)!.confirmCount,
          denyCount: store.get(patternId as string)!.denyCount,
        });
      }

      // GET /mesh/recovery/stats
      if (method === 'GET' && path === '/mesh/recovery/stats') {
        const stats = store.stats();
        const all = store.getAll();

        // Group by type
        const byType: Record<string, number> = {};
        const byProvider: Record<string, number> = {};
        for (const atom of all) {
          byType[atom.type] = (byType[atom.type] ?? 0) + 1;
          byProvider[atom.provider] = (byProvider[atom.provider] ?? 0) + 1;
        }

        return json(res, 200, {
          ...stats,
          byType,
          byProvider,
          topPatterns: all
            .sort((a, b) => b.reportCount - a.reportCount)
            .slice(0, 10)
            .map(a => ({
              id: a.id,
              type: a.type,
              provider: a.provider,
              confidence: a.confidence,
              reportCount: a.reportCount,
              confirmCount: a.confirmCount,
            })),
        });
      }

      json(res, 404, { error: 'Not found' });
    } catch (err: any) {
      if (err.message === 'Payload too large') {
        return json(res, 413, { error: 'Payload too large' });
      }
      json(res, 500, { error: err.message ?? 'Internal error' });
    }
  });

  server.listen(config.port);
  return server;
}

/**
 * Start a recovery mesh server with a fresh store.
 */
export function startRecoveryMeshServer(
  config?: Partial<RecoveryMeshServerConfig>,
): RecoveryMeshServerHandle {
  const fullConfig = { ...DEFAULT_RECOVERY_MESH_CONFIG, ...config };
  const store = new MeshRecoveryAtomStore(fullConfig.expiryDays);
  const server = createRecoveryMeshServer(store, fullConfig);

  return {
    store,
    server,
    stop() {
      server.close();
    },
  };
}
