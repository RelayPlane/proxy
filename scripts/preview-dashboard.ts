/**
 * Preview server for getDashboardHTML() - iterate on the dashboard without npm publish.
 * Usage: pnpm --filter @relayplane/proxy preview
 * Open: http://localhost:4101
 */
import * as http from 'http';
import { getDashboardHTML } from '../src/standalone-proxy';

const PORT = 4101;

const MOCK_SESSIONS = [
  {
    id: 'sess_abc123xyz',
    started_at: new Date(Date.now() - 3 * 3600000).toISOString(),
    last_seen_at: new Date(Date.now() - 120000).toISOString(),
    total_cost_usd: 0.42,
    total_tokens_in: 48000,
    total_tokens_out: 12000,
    request_count: 38,
    session_source: 'claude-code',
    duration_ms: 10800000,
    model_mix: { 'claude-sonnet-4-6': 30, 'claude-opus-4-6': 8 },
    active: true,
  },
  {
    id: 'sess_def456uvw',
    started_at: new Date(Date.now() - 5 * 3600000).toISOString(),
    last_seen_at: new Date(Date.now() - 3600000).toISOString(),
    total_cost_usd: 0.18,
    total_tokens_in: 18000,
    total_tokens_out: 4000,
    request_count: 8,
    session_source: 'synthetic',
    duration_ms: 7200000,
    model_mix: { 'claude-haiku-4-5-20251001': 6, 'claude-sonnet-4-6': 2 },
    active: false,
  },
  {
    id: 'sess_ghi789rst',
    started_at: new Date(Date.now() - 24 * 3600000).toISOString(),
    last_seen_at: new Date(Date.now() - 20 * 3600000).toISOString(),
    total_cost_usd: 0.95,
    total_tokens_in: 90000,
    total_tokens_out: 22000,
    request_count: 68,
    session_source: 'claude-code',
    duration_ms: 14400000,
    model_mix: { 'claude-sonnet-4-6': 50, 'claude-opus-4-6': 18 },
    active: false,
  },
];

const MOCK_RUNS = [
  { id: 'run_001', workflow_name: 'general', mode: 'general', status: 'success', success: true,
    started_at: new Date(Date.now() - 60000).toISOString(), timestamp: new Date(Date.now() - 60000).toISOString(),
    model: 'claude-sonnet-4-6', provider: 'anthropic', routed_to: 'anthropic/claude-sonnet-4-6',
    original_model: 'claude-opus-4-6', taskType: 'code_generation', complexity: 'moderate',
    costUsd: 0.012, latencyMs: 1240, tokensIn: 1200, tokensOut: 450,
    cacheCreationTokens: 0, cacheReadTokens: 800, savings: 0.031, escalated: false, error: null, statusCode: 200,
    agentFingerprint: 'fp_abc', agentId: 'sess_abc123xyz' },
  { id: 'run_002', workflow_name: 'general', mode: 'general', status: 'success', success: true,
    started_at: new Date(Date.now() - 180000).toISOString(), timestamp: new Date(Date.now() - 180000).toISOString(),
    model: 'claude-opus-4-6', provider: 'anthropic', routed_to: 'anthropic/claude-opus-4-6',
    original_model: 'claude-opus-4-6', taskType: 'analysis', complexity: 'complex',
    costUsd: 0.085, latencyMs: 2100, tokensIn: 3200, tokensOut: 1200,
    cacheCreationTokens: 1500, cacheReadTokens: 0, savings: 0, escalated: true, error: null, statusCode: 200,
    agentFingerprint: 'fp_abc', agentId: 'sess_abc123xyz' },
  { id: 'run_003', workflow_name: 'general', mode: 'general', status: 'error', success: false,
    started_at: new Date(Date.now() - 300000).toISOString(), timestamp: new Date(Date.now() - 300000).toISOString(),
    model: 'claude-haiku-4-5-20251001', provider: 'anthropic', routed_to: 'anthropic/claude-haiku-4-5-20251001',
    original_model: 'claude-opus-4-6', taskType: 'question_answering', complexity: 'simple',
    costUsd: 0.001, latencyMs: 450, tokensIn: 200, tokensOut: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, savings: 0, escalated: false,
    error: 'Rate limit exceeded', statusCode: 429, agentFingerprint: 'fp_def', agentId: 'sess_def456uvw' },
  { id: 'run_004', workflow_name: 'general', mode: 'general', status: 'success', success: true,
    started_at: new Date(Date.now() - 600000).toISOString(), timestamp: new Date(Date.now() - 600000).toISOString(),
    model: 'claude-sonnet-4-6', provider: 'anthropic', routed_to: 'anthropic/claude-sonnet-4-6',
    original_model: 'claude-opus-4-6', taskType: 'summarization', complexity: 'simple',
    costUsd: 0.008, latencyMs: 980, tokensIn: 800, tokensOut: 300,
    cacheCreationTokens: 0, cacheReadTokens: 600, savings: 0.019, escalated: false, error: null, statusCode: 200,
    agentFingerprint: 'fp_def', agentId: 'sess_def456uvw' },
  { id: 'run_005', workflow_name: 'general', mode: 'general', status: 'success', success: true,
    started_at: new Date(Date.now() - 900000).toISOString(), timestamp: new Date(Date.now() - 900000).toISOString(),
    model: 'claude-sonnet-4-6', provider: 'anthropic', routed_to: 'anthropic/claude-sonnet-4-6',
    original_model: 'claude-opus-4-6', taskType: 'code_generation', complexity: 'moderate',
    costUsd: 0.015, latencyMs: 1450, tokensIn: 1500, tokensOut: 600,
    cacheCreationTokens: 0, cacheReadTokens: 1200, savings: 0.038, escalated: false, error: null, statusCode: 200,
    agentFingerprint: 'fp_abc', agentId: 'sess_abc123xyz' },
];

export const MOCK: Record<string, unknown> = {
  tier: { tier: 'free', anthropicAccountCount: 0 },
  health: { status: 'ok', version: '1.9.17', uptime: 7834 },
  stats: {
    summary: {
      totalCostUsd: 4.82, totalEvents: 203, totalRequests: 1240,
      avgLatencyMs: 1180, successRate: 0.98, historyLimit: 10000, retentionDays: 7,
    },
    byModel: [
      { model: 'claude-sonnet-4-6', provider: 'anthropic', count: 160, costUsd: 2.10 },
      { model: 'claude-opus-4-6',   provider: 'anthropic', count:  43, costUsd: 2.72 },
    ],
    dailyCosts: [],
  },
  savings: {
    savedAmount: 3.14, savings: 3.14, routingSavings: 2.87,
    cacheSavings: 0.27, actualCost: 4.82, potentialSavings: 7.96,
    percentage: 39, hasAnthropicCalls: true,
  },
  budget: {
    today_usd: 1.24, limit_usd: 5.00, pct_used: 24.8,
    remaining_usd: 3.76, enabled: true, breached: false,
    breach_type: null, this_week_usd: 8.40, this_month_usd: 22.10,
    on_breach: 'warn', hourly_usd: 0.12, hourly_limit_usd: null,
  },
  sessions: { sessions: MOCK_SESSIONS },
  'sessions/active': { sessions: [MOCK_SESSIONS[0]] },
  'telemetry/health': {
    providers: [
      { name: 'anthropic', provider: 'anthropic', healthy: true, successRate: 0.998, status: 'healthy', latency: 0, lastChecked: new Date().toISOString() },
      { name: 'openai',    provider: 'openai',    healthy: true, successRate: 0.991, status: 'healthy', latency: 0, lastChecked: new Date().toISOString() },
    ],
  },
  'telemetry/runs': { runs: MOCK_RUNS, pagination: { total: MOCK_RUNS.length } },
  'version-status': { state: 'up-to-date', current: '1.9.17', latest: '1.9.17' },
  agents: { agents: [] },
  'knowledge/stats': { totalLearnings: 0, recentLearnings: [], fileStats: [], knowledgeDir: '' },
  'token-pool/status': { accounts: [] },
};

export function getMockForPath(pathname: string, _searchParams?: URLSearchParams): unknown {
  // Allow single-arg form: split pathname on '?' to parse any inline query string
  let qs = '';
  const qIdx = pathname.indexOf('?');
  if (qIdx >= 0) {
    qs = pathname.slice(qIdx + 1);
    pathname = pathname.slice(0, qIdx);
  }
  const params = _searchParams ?? new URLSearchParams(qs);
  // Strip leading /v1/ or /control/ prefix to normalize
  const key = pathname
    .replace(/^\/v1\//, '')
    .replace(/^\/control\//, '')
    .replace(/^\/api\//, '');
  // Tier override via ?mock=mesh|pro|free
  if (key === 'tier') {
    const override = params.get('mock');
    if (override === 'mesh') return { tier: 'mesh', anthropicAccountCount: 2 };
    if (override === 'pro') return { tier: 'pro', anthropicAccountCount: 1 };
    return MOCK['tier'];
  }
  if (MOCK[key] !== undefined) return MOCK[key];
  // Fuzzy fallbacks
  if (key === 'health' || pathname === '/health') return MOCK['health'];
  if (key.startsWith('telemetry/stats')) return MOCK['stats'];
  if (key.startsWith('telemetry/savings')) return MOCK['savings'];
  if (key.startsWith('telemetry/runs')) return MOCK['telemetry/runs'];
  if (key.startsWith('telemetry/health')) return MOCK['telemetry/health'];
  if (key.startsWith('sessions/active')) return MOCK['sessions/active'];
  if (key.startsWith('sessions')) return MOCK['sessions'];
  if (key.startsWith('version-status')) return MOCK['version-status'];
  if (key.startsWith('knowledge/stats')) return MOCK['knowledge/stats'];
  if (key.startsWith('token-pool/status')) return MOCK['token-pool/status'];
  if (key.startsWith('budget')) return MOCK['budget'];
  return null;
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const [pathname, qs] = rawUrl.split('?') as [string, string | undefined];
  const searchParams = new URLSearchParams(qs ?? '');

  // Serve dashboard HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }

  // 302 redirect for /dashboard/config
  if (req.method === 'GET' && pathname === '/dashboard/config') {
    res.writeHead(302, { Location: '/#config' });
    res.end();
    return;
  }

  // No-op POST endpoints
  if (req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Mock GET endpoints
  if (req.method === 'GET') {
    const mock = getMockForPath(pathname, searchParams);
    if (mock !== null) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mock));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
    return;
  }

  res.writeHead(405);
  res.end();
});

// Only auto-listen when run as a script, not when imported for tests.
const isMainModule = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return argv1.includes('preview-dashboard');
  } catch {
    return false;
  }
})();

if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`RelayPlane dashboard preview, http://localhost:${PORT}`);
    console.log('Edit getDashboardHTML() in standalone-proxy.ts and refresh to iterate.');
    console.log('Ctrl+C to stop.');
  });
}

export { server };
