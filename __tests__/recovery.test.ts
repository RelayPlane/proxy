import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RecoveryEngine,
  RecoveryPatternStore,
  FailureObserver,
  PatternApplicator,
  type ProviderResponse,
  type FailureContext,
  type ForwardFn,
  type RequestOverrides,
} from '../src/recovery.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeFailedResponse(status: number, code = 'error', message = 'Error'): ProviderResponse {
  return {
    success: false,
    error: {
      code,
      message,
      status,
      retryable: status >= 500 || status === 429,
    },
  };
}

function makeSuccessResponse(): ProviderResponse {
  return {
    success: true,
    data: { id: 'chatcmpl-123', choices: [{ message: { content: 'Hello' } }] },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ttft_ms: 100,
  };
}

function makeFailureContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    provider: 'anthropic',
    model: 'claude-3-sonnet',
    authMethod: 'x-api-key',
    errorCode: 401,
    errorMessage: 'Unauthorized',
    errorType: 'authentication_error',
    tokenPrefix: 'sk-ant-oat',
    timestamp: Date.now(),
    requestHeaders: {},
    ...overrides,
  };
}

// ─── RecoveryPatternStore Tests ───────────────────────────────────────────────

describe('RecoveryPatternStore', () => {
  let store: RecoveryPatternStore;

  beforeEach(() => {
    store = new RecoveryPatternStore(100, 30);
  });

  it('starts empty', () => {
    expect(store.getAll()).toHaveLength(0);
    expect(store.stats().total).toBe(0);
  });

  it('stores and retrieves patterns', () => {
    store.upsert({
      id: 'test-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    expect(store.getAll()).toHaveLength(1);
    expect(store.stats().total).toBe(1);
  });

  it('finds matching patterns', () => {
    store.upsert({
      id: 'auth-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401, tokenPrefix: 'sk-ant-oat' },
      fix: { authHeader: 'Authorization' },
      confidence: 0.95,
      successCount: 19,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const ctx = makeFailureContext({ errorCode: 401, tokenPrefix: 'sk-ant-oat01' });
    const matches = store.findMatching(ctx);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('auth-1');
  });

  it('does not match different provider', () => {
    store.upsert({
      id: 'auth-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 0.95,
      successCount: 19,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const ctx = makeFailureContext({ provider: 'openai', errorCode: 401 });
    expect(store.findMatching(ctx)).toHaveLength(0);
  });

  it('updates existing pattern on upsert', () => {
    store.upsert({
      id: 'auth-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
    });

    store.upsert({
      id: 'auth-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-01T00:00:00Z',
    });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].successCount).toBe(2);
  });

  it('records success and failure', () => {
    store.upsert({
      id: 'test-1',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 1.0,
      successCount: 1,
      failureCount: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    store.recordSuccess('test-1');
    expect(store.getAll()[0].successCount).toBe(2);
    expect(store.getAll()[0].confidence).toBe(1.0);

    store.recordFailure('test-1');
    expect(store.getAll()[0].failureCount).toBe(1);
    expect(store.getAll()[0].confidence).toBeCloseTo(2 / 3);
  });

  it('evicts lowest-confidence pattern when at capacity', () => {
    const smallStore = new RecoveryPatternStore(2, 30);

    smallStore.upsert({
      id: 'high',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 0.9,
      successCount: 9,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    smallStore.upsert({
      id: 'low',
      type: 'model-rename',
      provider: 'anthropic',
      trigger: { errorCode: 404 },
      fix: { model: 'claude-opus-4' },
      confidence: 0.5,
      successCount: 1,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    // This should evict 'low' (lowest confidence)
    smallStore.upsert({
      id: 'new',
      type: 'timeout-tune',
      provider: 'openai',
      trigger: { errorCode: 500 },
      fix: { timeoutMs: 60000 },
      confidence: 0.8,
      successCount: 4,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const all = smallStore.getAll();
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.id === 'low')).toBeUndefined();
    expect(all.find((p) => p.id === 'high')).toBeDefined();
    expect(all.find((p) => p.id === 'new')).toBeDefined();
  });

  it('finds preemptive patterns only with high confidence', () => {
    store.upsert({
      id: 'high-conf',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 0.9,
      successCount: 9,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    store.upsert({
      id: 'low-conf',
      type: 'model-rename',
      provider: 'anthropic',
      trigger: { errorCode: 404, model: 'claude-3-opus' },
      fix: { model: 'claude-opus-4' },
      confidence: 0.5,
      successCount: 1,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const preemptive = store.findPreemptive('anthropic', 'claude-3-opus');
    expect(preemptive).toHaveLength(1);
    expect(preemptive[0].id).toBe('high-conf');
  });
});

// ─── FailureObserver Tests ────────────────────────────────────────────────────

describe('FailureObserver', () => {
  let observer: FailureObserver;

  beforeEach(() => {
    observer = new FailureObserver(silentLogger as any);
  });

  it('identifies recoverable failures', () => {
    expect(observer.isRecoverable(makeFailedResponse(401))).toBe(true);
    expect(observer.isRecoverable(makeFailedResponse(403))).toBe(true);
    expect(observer.isRecoverable(makeFailedResponse(404, 'not_found'))).toBe(true);
    expect(observer.isRecoverable(makeFailedResponse(429))).toBe(true);
    expect(observer.isRecoverable(makeFailedResponse(500))).toBe(true);
    expect(observer.isRecoverable(makeFailedResponse(503))).toBe(true);
  });

  it('rejects non-recoverable failures', () => {
    expect(observer.isRecoverable(makeFailedResponse(400))).toBe(false);
    expect(observer.isRecoverable(makeSuccessResponse())).toBe(false);
  });

  it('builds failure context', () => {
    const response = makeFailedResponse(401, 'authentication_error', 'Invalid API key');
    const ctx = observer.buildContext(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet', messages: [{ role: 'user', content: 'Hello world' }] },
      { apiKey: 'sk-ant-oat01-testkey123' },
      response
    );

    expect(ctx.provider).toBe('anthropic');
    expect(ctx.model).toBe('claude-3-sonnet');
    expect(ctx.errorCode).toBe(401);
    expect(ctx.tokenPrefix).toBe('sk-ant-oat');
    expect(ctx.authMethod).toBe('x-api-key');
  });

  it('logs and retrieves events', () => {
    observer.logEvent({
      id: 'test-1',
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-3-sonnet',
      originalError: { code: 401, type: 'auth_error', message: 'Unauthorized' },
      strategy: 'auth-rotation',
      recovered: true,
      attempts: 1,
      latencyMs: 500,
    });

    const events = observer.getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].recovered).toBe(true);

    const stats = observer.getStats();
    expect(stats.total).toBe(1);
    expect(stats.recovered).toBe(1);
    expect(stats.recoveryRate).toBe(1.0);
  });
});

// ─── PatternApplicator Tests ──────────────────────────────────────────────────

describe('PatternApplicator', () => {
  let store: RecoveryPatternStore;
  let applicator: PatternApplicator;

  beforeEach(() => {
    store = new RecoveryPatternStore();
    applicator = new PatternApplicator(store, 0.8, silentLogger as any);
  });

  it('returns null when no patterns match', () => {
    const overrides = applicator.getPreemptiveOverrides('anthropic', 'claude-3-sonnet');
    expect(overrides).toBeNull();
  });

  it('returns overrides for high-confidence patterns', () => {
    store.upsert({
      id: 'auth-fix',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401, tokenPrefix: 'sk-ant-oat' },
      fix: { authHeader: 'Authorization' },
      confidence: 0.95,
      successCount: 19,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const overrides = applicator.getPreemptiveOverrides('anthropic', 'claude-3-sonnet', 'sk-ant-oat01');
    expect(overrides).toBeDefined();
    expect(overrides!.authHeader).toBe('Authorization');
  });

  it('skips patterns below confidence threshold', () => {
    store.upsert({
      id: 'low-conf',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 0.5,
      successCount: 1,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const overrides = applicator.getPreemptiveOverrides('anthropic', 'claude-3-sonnet');
    expect(overrides).toBeNull();
  });

  it('tracks preemptive stats', () => {
    store.upsert({
      id: 'auth-fix',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401 },
      fix: { authHeader: 'Authorization' },
      confidence: 0.95,
      successCount: 19,
      failureCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    applicator.getPreemptiveOverrides('anthropic', 'claude-3-sonnet');
    const stats = applicator.getStats();
    expect(stats.hits).toBe(1);
  });
});

// ─── RecoveryEngine Tests ─────────────────────────────────────────────────────

describe('RecoveryEngine', () => {
  let engine: RecoveryEngine;

  beforeEach(() => {
    engine = new RecoveryEngine({ logger: silentLogger as any, baseDelayMs: 0 });
  });

  it('initializes with defaults', () => {
    expect(engine.enabled).toBe(true);
    expect(engine.store.getAll()).toHaveLength(0);
  });

  it('can be disabled', () => {
    const disabled = new RecoveryEngine({ enabled: false, logger: silentLogger as any });
    expect(disabled.enabled).toBe(false);
  });

  it('returns not-recoverable for non-eligible failures', async () => {
    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(makeSuccessResponse());

    const result = await engine.attemptRecovery(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet' },
      { apiKey: 'sk-ant-test' },
      'run-1',
      makeFailedResponse(400), // Bad request — not recoverable
      forwardFn
    );

    expect(result.recovered).toBe(false);
    expect(result.strategy).toBe('not-recoverable');
    expect(forwardFn).not.toHaveBeenCalled();
  });

  it('recovers from auth failure via auth rotation', async () => {
    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(makeSuccessResponse());

    const result = await engine.attemptRecovery(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet', messages: [{ role: 'user', content: 'Hi' }] },
      { apiKey: 'sk-ant-oat01-test' },
      'run-1',
      makeFailedResponse(401, 'authentication_error', 'Invalid API key'),
      forwardFn
    );

    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('auth-rotation');
    expect(result.pattern).toBeDefined();
    expect(result.pattern!.type).toBe('auth-header');
    expect(forwardFn).toHaveBeenCalledTimes(1);

    // Verify pattern was stored
    expect(engine.store.getAll()).toHaveLength(1);
  });

  it('recovers from model not found via model rename', async () => {
    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(makeSuccessResponse());

    const result = await engine.attemptRecovery(
      'anthropic',
      'claude-3-opus',
      { model: 'claude-3-opus', messages: [{ role: 'user', content: 'Hi' }] },
      { apiKey: 'sk-ant-test' },
      'run-1',
      makeFailedResponse(404, 'model_not_found', 'Model not found'),
      forwardFn
    );

    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('model-rename');
    expect(result.pattern!.type).toBe('model-rename');
  });

  it('recovers from timeout via timeout extension', async () => {
    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(makeSuccessResponse());

    const result = await engine.attemptRecovery(
      'openai',
      'gpt-4',
      { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] },
      { apiKey: 'sk-test' },
      'run-1',
      makeFailedResponse(500, 'timeout', 'Request timed out'),
      forwardFn
    );

    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('timeout-extension');
  });

  it('returns failure when all strategies fail', async () => {
    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(
      makeFailedResponse(401, 'authentication_error', 'Still invalid')
    );

    const result = await engine.attemptRecovery(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet', messages: [{ role: 'user', content: 'Hi' }] },
      { apiKey: 'sk-ant-oat01-test' },
      'run-1',
      makeFailedResponse(401, 'authentication_error', 'Invalid API key'),
      forwardFn
    );

    expect(result.recovered).toBe(false);
    expect(result.strategy).toBe('all-failed');
    expect(result.attempts).toBeGreaterThan(0);
  });

  it('uses stored pattern for known failures', async () => {
    // Pre-seed a pattern
    engine.store.upsert({
      id: 'auth-header:anthropic:sk-ant-oat',
      type: 'auth-header',
      provider: 'anthropic',
      trigger: { errorCode: 401, tokenPrefix: 'sk-ant-oat' },
      fix: { authHeader: 'Authorization' },
      confidence: 0.95,
      successCount: 19,
      failureCount: 1,
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-06T00:00:00Z',
    });

    const forwardFn: ForwardFn = vi.fn().mockResolvedValue(makeSuccessResponse());

    const result = await engine.attemptRecovery(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet' },
      { apiKey: 'sk-ant-oat01-test' },
      'run-1',
      makeFailedResponse(401, 'authentication_error', 'Invalid API key'),
      forwardFn
    );

    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('stored-pattern:auth-header');

    // Verify pattern confidence was updated
    const pattern = engine.store.getAll().find((p) => p.id === 'auth-header:anthropic:sk-ant-oat');
    expect(pattern!.successCount).toBe(20);
  });

  it('does nothing when disabled', async () => {
    const disabled = new RecoveryEngine({ enabled: false, logger: silentLogger as any });
    const forwardFn: ForwardFn = vi.fn();

    const result = await disabled.attemptRecovery(
      'anthropic', 'claude-3-sonnet', {}, { apiKey: 'test' }, 'run-1',
      makeFailedResponse(401), forwardFn
    );

    expect(result.recovered).toBe(false);
    expect(result.strategy).toBe('none');
    expect(forwardFn).not.toHaveBeenCalled();
  });

  it('getPreemptiveOverrides returns null when disabled', () => {
    const disabled = new RecoveryEngine({ enabled: false, logger: silentLogger as any });
    expect(disabled.getPreemptiveOverrides('anthropic', 'claude-3-sonnet')).toBeNull();
  });

  it('getDashboardData returns complete stats', () => {
    const data = engine.getDashboardData();
    expect(data.enabled).toBe(true);
    expect(data.patterns).toEqual([]);
    expect(data.patternStats.total).toBe(0);
    expect(data.recoveryStats.total).toBe(0);
    expect(data.preemptiveStats.hits).toBe(0);
    expect(data.recentEvents).toEqual([]);
  });

  it('respects maxRetries config', async () => {
    const limitedEngine = new RecoveryEngine({
      maxRetries: 1,
      baseDelayMs: 0,
      logger: silentLogger as any,
    });

    let callCount = 0;
    const forwardFn: ForwardFn = vi.fn().mockImplementation(async () => {
      callCount++;
      return makeFailedResponse(401, 'authentication_error', 'Still invalid');
    });

    await limitedEngine.attemptRecovery(
      'anthropic',
      'claude-3-sonnet',
      { model: 'claude-3-sonnet' },
      { apiKey: 'sk-ant-oat01-test' },
      'run-1',
      makeFailedResponse(401, 'authentication_error', 'Invalid API key'),
      forwardFn
    );

    // Should only try once (maxRetries = 1)
    expect(callCount).toBeLessThanOrEqual(1);
  });
});
