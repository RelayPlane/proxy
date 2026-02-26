/**
 * RelayPlane integration configuration types.
 * @packageDocumentation
 */

export interface MeshConfig {
  /** Enable local knowledge capture (default: true) */
  enabled: boolean;
  /** Opt-in to share knowledge with mesh (default: false) */
  contribute: boolean;
  /** Mesh server URL */
  meshUrl: string;
  /** Sync interval in ms (default: 300000 = 5 min) */
  syncIntervalMs: number;
  /** Context injection interval in ms (default: 900000 = 15 min) */
  injectIntervalMs: number;
  /** Data directory for mesh SQLite DB */
  dataDir: string;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  enabled: true,
  contribute: false,
  meshUrl: 'https://osmosis-mesh-dev.fly.dev',
  syncIntervalMs: 300_000,
  injectIntervalMs: 900_000,
  dataDir: `${process.env.HOME ?? '/root'}/.relayplane/mesh`,
};

export interface ResponseCacheConfig {
  enabled: boolean;
  maxSizeMb: number;
  defaultTtlSeconds: number;
  ttlByTaskType?: Record<string, number>;
  onlyWhenDeterministic: boolean;
}

export interface RelayPlaneConfig {
  enabled: boolean;
  /** Proxy URL (default: http://127.0.0.1:4100) */
  proxyUrl?: string;
  circuitBreaker?: {
    failureThreshold?: number;   // default: 3
    resetTimeoutMs?: number;     // default: 30000
    requestTimeoutMs?: number;   // default: 3000
  };
  /** Auto-start proxy process (Phase 2, default: true) */
  autoStart?: boolean;
  /** Mesh learning layer config */
  mesh?: Partial<MeshConfig>;
  /** Response cache config */
  cache?: Partial<ResponseCacheConfig>;
}

export const DEFAULT_RELAY_CONFIG: Required<RelayPlaneConfig> = {
  enabled: false,
  proxyUrl: 'http://127.0.0.1:4100',
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
    requestTimeoutMs: 3_000,
  },
  autoStart: true,
  mesh: { ...DEFAULT_MESH_CONFIG },
  cache: { enabled: true, maxSizeMb: 100, defaultTtlSeconds: 3600, onlyWhenDeterministic: true },
};

export function resolveConfig(partial?: Partial<RelayPlaneConfig>): Required<RelayPlaneConfig> {
  if (!partial) return { ...DEFAULT_RELAY_CONFIG };
  return {
    enabled: partial.enabled ?? DEFAULT_RELAY_CONFIG.enabled,
    proxyUrl: partial.proxyUrl ?? DEFAULT_RELAY_CONFIG.proxyUrl,
    circuitBreaker: {
      ...DEFAULT_RELAY_CONFIG.circuitBreaker,
      ...partial.circuitBreaker,
    },
    autoStart: partial.autoStart ?? DEFAULT_RELAY_CONFIG.autoStart,
    mesh: { ...DEFAULT_MESH_CONFIG, ...partial.mesh },
    cache: { ...DEFAULT_RELAY_CONFIG.cache, ...partial.cache },
  };
}

export function resolveMeshConfig(partial?: Partial<MeshConfig>): MeshConfig {
  return { ...DEFAULT_MESH_CONFIG, ...partial };
}
