/**
 * Failing tests for the optional vLLM Semantic Router sidecar classifier.
 * Phase 1: tests only. Implementation does not exist yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// These imports will fail until implementation is written (expected in Phase 1)
import {
  classifyViaSidecar,
  type SidecarResult,
  type SidecarClassifyInput,
} from '../src/classifier/sidecar_client.js';

import {
  loadSidecarConfig,
  probeSidecar,
  bootstrapSidecar,
  type SidecarConfig,
} from '../src/classifier/sidecar_setup.js';

import { classifyTaskType } from '../src/middleware.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeFetchResponse(status: number, body: unknown, ok?: boolean): Response {
  const isOk = ok !== undefined ? ok : (status >= 200 && status < 300);
  return {
    ok: isOk,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// sidecar_client tests
// ---------------------------------------------------------------------------

describe('sidecar classifier', () => {
  describe('classifyViaSidecar', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('test_sidecar_client_happy_path: returns parsed SidecarResult on 200 with well-formed body', async () => {
      const payload: SidecarResult = {
        model: 'claude-3-haiku-20240307',
        confidence: 0.92,
        latency_ms: 18,
        task_type: 'chat',
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, payload)));

      const input: SidecarClassifyInput = {
        prompt: 'Hello world',
        models: ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229'],
      };
      const result = await classifyViaSidecar(input, { url: 'http://localhost:8888' });

      expect(result).not.toBeNull();
      expect(result!.model).toBe('claude-3-haiku-20240307');
      expect(result!.confidence).toBe(0.92);
      expect(result!.latency_ms).toBe(18);
      expect(result!.task_type).toBe('chat');
    });

    it('test_sidecar_client_timeout_returns_null: returns null when fetch exceeds timeoutMs', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          (_url: string, opts: { signal?: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
              if (opts?.signal) {
                opts.signal.addEventListener('abort', () => {
                  const err = new DOMException('The operation was aborted.', 'AbortError');
                  reject(err);
                });
              }
            }),
        ),
      );

      const result = await classifyViaSidecar(
        { prompt: 'test', models: [] },
        { url: 'http://localhost:8888', timeoutMs: 1 },
      );
      expect(result).toBeNull();
    });

    it('test_sidecar_client_non_2xx_returns_null: returns null on 500 response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(500, { error: 'oops' }, false)));

      const result = await classifyViaSidecar(
        { prompt: 'test', models: [] },
        { url: 'http://localhost:8888', logger: mockLogger as never },
      );
      expect(result).toBeNull();
    });

    it('test_sidecar_client_malformed_json_returns_null: returns null when body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token')),
          text: () => Promise.resolve('not json'),
        } as unknown as Response),
      );

      const result = await classifyViaSidecar(
        { prompt: 'test', models: [] },
        { url: 'http://localhost:8888' },
      );
      expect(result).toBeNull();
    });

    it('test_sidecar_client_invalid_shape_returns_null: returns null when model field is missing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeFetchResponse(200, { confidence: 0.8, latency_ms: 10 })),
      );

      const result = await classifyViaSidecar(
        { prompt: 'test', models: [] },
        { url: 'http://localhost:8888' },
      );
      expect(result).toBeNull();
    });

    it('test_sidecar_client_invalid_shape_returns_null: returns null when confidence is out of [0,1]', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeFetchResponse(200, { model: 'some-model', confidence: 1.5, latency_ms: 10 })),
      );

      const result = await classifyViaSidecar(
        { prompt: 'test', models: [] },
        { url: 'http://localhost:8888' },
      );
      expect(result).toBeNull();
    });

    it('test_sidecar_client_network_error_returns_null: returns null on ECONNREFUSED without throwing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      );

      await expect(
        classifyViaSidecar({ prompt: 'test', models: [] }, { url: 'http://localhost:8888' }),
      ).resolves.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // sidecar_setup tests
  // ---------------------------------------------------------------------------

  describe('loadSidecarConfig', () => {
    it('test_sidecar_setup_loadSidecarConfig_defaults: enabled=false, threshold=0.65, timeout=200 when URL unset', () => {
      const cfg = loadSidecarConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.url).toBeNull();
      expect(cfg.confidenceThreshold).toBe(0.65);
      expect(cfg.timeoutMs).toBe(200);
    });

    it('test_sidecar_setup_loadSidecarConfig_overrides: honors and clamps env vars', () => {
      const cfg = loadSidecarConfig({
        RELAYPLANE_SIDECAR_URL: 'http://localhost:8888',
        RELAYPLANE_SIDECAR_CONFIDENCE_THRESHOLD: '1.5', // clamped to 1.0
        RELAYPLANE_SIDECAR_TIMEOUT_MS: '30', // clamped to 50
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.url).toBe('http://localhost:8888');
      expect(cfg.confidenceThreshold).toBe(1.0);
      expect(cfg.timeoutMs).toBe(50);
    });

    it('test_sidecar_setup_loadSidecarConfig_overrides: valid values pass through unchanged', () => {
      const cfg = loadSidecarConfig({
        RELAYPLANE_SIDECAR_URL: 'http://sidecar.internal:9000',
        RELAYPLANE_SIDECAR_CONFIDENCE_THRESHOLD: '0.75',
        RELAYPLANE_SIDECAR_TIMEOUT_MS: '500',
      });
      expect(cfg.confidenceThreshold).toBe(0.75);
      expect(cfg.timeoutMs).toBe(500);
    });
  });

  describe('probeSidecar', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it('test_sidecar_setup_probeSidecar_reachable: returns true and logs reachable on 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { status: 'ok' })));

      const reachable = await probeSidecar('http://localhost:8888', 200, mockLogger as never);
      expect(reachable).toBe(true);
      const logCalls = [
        ...mockLogger.debug.mock.calls,
        ...mockLogger.info.mock.calls,
      ];
      const logged = logCalls.some(args =>
        args.join(' ').toLowerCase().includes('reachable') &&
        args.join(' ').includes('http://localhost:8888'),
      );
      expect(logged).toBe(true);
    });

    it('test_sidecar_setup_probeSidecar_unreachable: returns false when fetch rejects without throwing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
      );

      await expect(
        probeSidecar('http://localhost:8888', 200, mockLogger as never),
      ).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // classifyTaskType integration
  // ---------------------------------------------------------------------------

  describe('classifyTaskType', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.restoreAllMocks());

    const enabledConfig: SidecarConfig = {
      url: 'http://localhost:8888',
      confidenceThreshold: 0.65,
      timeoutMs: 200,
      enabled: true,
    };

    const disabledConfig: SidecarConfig = {
      url: null,
      confidenceThreshold: 0.65,
      timeoutMs: 200,
      enabled: false,
    };

    it('test_classifyTaskType_uses_sidecar_when_confident: returns source=sidecar when confidence >= threshold', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeFetchResponse(200, { model: 'claude-3-haiku-20240307', confidence: 0.9, latency_ms: 20, task_type: 'code' }),
        ),
      );

      const res = await classifyTaskType('/v1/messages', '{"model":"claude-3-haiku","messages":[]}', {
        sidecarConfig: enabledConfig,
        availableModels: ['claude-3-haiku-20240307'],
        logger: mockLogger as never,
      });

      expect(res.source).toBe('sidecar');
      expect(res.taskType).toBe('code');
      expect(res.confidence).toBe(0.9);
    });

    it('test_classifyTaskType_falls_back_when_low_confidence: returns source=regex when confidence < threshold', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeFetchResponse(200, { model: 'claude-3-haiku-20240307', confidence: 0.4, latency_ms: 20, task_type: 'code' }),
        ),
      );

      const res = await classifyTaskType('/v1/messages', '{"messages":[]}', {
        sidecarConfig: enabledConfig,
        logger: mockLogger as never,
      });

      expect(res.source).toBe('regex');
    });

    it('test_classifyTaskType_falls_back_when_sidecar_disabled: no fetch, source=regex', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const res = await classifyTaskType('/v1/messages', '{}', {
        sidecarConfig: disabledConfig,
        logger: mockLogger as never,
      });

      expect(res.source).toBe('regex');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // middleware route telemetry
  // ---------------------------------------------------------------------------

  describe('middleware route telemetry', () => {
    it('test_middleware_route_logs_classifier_source: classifierSource is defined in the classifier result', async () => {
      // Verify classifyTaskType always returns a classifierSource field (both paths)
      const disabledConfig: SidecarConfig = {
        url: null,
        confidenceThreshold: 0.65,
        timeoutMs: 200,
        enabled: false,
      };

      const res = await classifyTaskType('/v1/chat/completions', '{}', {
        sidecarConfig: disabledConfig,
      });

      expect(res).toHaveProperty('source');
      expect(['regex', 'sidecar']).toContain(res.source);
    });
  });
});
