/**
 * Phase 1 TDD: /v1/tier endpoint tests.
 * These tests FAIL until the implementation is added.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';

// Helper: start the standalone proxy on an ephemeral port for testing
async function startProxyServer(loadUserConfigImpl: () => unknown): Promise<{ server: http.Server; port: number; url: string }> {
  // Mock loadUserConfig before importing the server module
  vi.doMock('../src/config.js', () => ({
    loadUserConfig: loadUserConfigImpl,
  }));

  const mod = await import('../src/standalone-proxy.js');
  const startFn: ((port: number) => Promise<http.Server>) | undefined =
    (mod as { startServer?: (port: number) => Promise<http.Server> }).startServer;

  if (!startFn) {
    throw new Error('startServer not exported from standalone-proxy.js, implementation not yet added');
  }

  const server = await startFn(0);
  const addr = server.address() as { port: number };
  return { server, port: addr.port, url: `http://127.0.0.1:${addr.port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function fetchJSON(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    }).on('error', reject);
  });
}

describe('/v1/tier endpoint', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('test_tier_endpoint_returns_free_when_zero_anthropic_accounts', async () => {
    const { server, url } = await startProxyServer(() => ({
      providers: { anthropic: { accounts: [] } },
    }));
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'free', anthropicAccountCount: 0 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_tier_endpoint_returns_free_when_one_anthropic_account', async () => {
    const { server, url } = await startProxyServer(() => ({
      providers: { anthropic: { accounts: [{ apiKey: 'sk-test1' }] } },
    }));
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'free', anthropicAccountCount: 1 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_tier_endpoint_returns_mesh_when_two_anthropic_accounts', async () => {
    const { server, url } = await startProxyServer(() => ({
      providers: { anthropic: { accounts: [{ apiKey: 'sk-1' }, { apiKey: 'sk-2' }] } },
    }));
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'mesh', anthropicAccountCount: 2 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_tier_endpoint_returns_mesh_when_three_anthropic_accounts', async () => {
    const { server, url } = await startProxyServer(() => ({
      providers: { anthropic: { accounts: [{ apiKey: 'sk-1' }, { apiKey: 'sk-2' }, { apiKey: 'sk-3' }] } },
    }));
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'mesh', anthropicAccountCount: 3 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_tier_endpoint_handles_missing_providers_block', async () => {
    const { server, url } = await startProxyServer(() => ({}));
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'free', anthropicAccountCount: 0 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_tier_endpoint_handles_loadConfig_throwing', async () => {
    const { server, url } = await startProxyServer(() => {
      throw new Error('config read failure');
    });
    try {
      const res = await fetchJSON(`${url}/v1/tier`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'free', anthropicAccountCount: 0 });
    } finally {
      await closeServer(server);
    }
  });

  it('test_preview_server_mock_tier_default_free', async () => {
    // Import preview-dashboard and verify the MOCK object contains a free-tier default
    const previewMod = await import('../scripts/preview-dashboard.js');
    const mock = (previewMod as { MOCK?: Record<string, unknown> }).MOCK;
    expect(mock).toBeDefined();
    expect(mock?.['tier']).toBeDefined();
    expect((mock?.['tier'] as { tier: string })?.tier).toBe('free');
  });

  it('test_preview_server_mock_tier_query_override_returns_mesh', async () => {
    // getMockForPath('/v1/tier?mock=mesh') should return mesh tier
    const previewMod = await import('../scripts/preview-dashboard.js');
    const getMockForPath = (previewMod as { getMockForPath?: (path: string) => unknown }).getMockForPath;
    expect(getMockForPath).toBeDefined();
    const result = getMockForPath?.('/v1/tier?mock=mesh');
    expect((result as { tier: string })?.tier).toBe('mesh');
  });
});
