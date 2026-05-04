/**
 * Tests for the pre-flight cost estimation feature.
 *
 * Covers:
 * 1. Correct token count for known input
 * 2. Correct cost formula applied
 * 3. Pro gate enforced (402 for free tier)
 * 4. Handles unknown model gracefully
 * 5. MCP tool shape / integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  countTextTokens,
  countMessagesTokens,
  inferProvider,
  isProTier,
  estimateChatRequest,
  handleEstimateRequest,
  MODEL_PRICING,
  type InvalidRequestError,
} from '../src/estimate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Token counting
// ---------------------------------------------------------------------------

describe('countTextTokens', () => {
  it('counts tokens at ~4 chars per token', () => {
    // "Hello world" = 11 chars → ceil(11/4) = 3
    expect(countTextTokens('Hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(countTextTokens('')).toBe(0);
  });

  it('counts a longer known string accurately', () => {
    // 40 chars → ceil(40/4) = 10
    const text = 'a'.repeat(40);
    expect(countTextTokens(text)).toBe(10);
  });
});

describe('countMessagesTokens', () => {
  it('counts tokens across multiple messages including overhead', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' }, // 27 chars = 7 + 4 overhead = 11
      { role: 'user', content: 'Hello!' },                         // 6 chars = 2 + 4 overhead = 6
    ];
    const count = countMessagesTokens(messages);
    // system: ceil(27/4) + 4 = 7 + 4 = 11
    // user:   ceil(6/4)  + 4 = 2 + 4 = 6
    // total: 17
    expect(count).toBe(17);
  });

  it('returns 0 for empty messages array', () => {
    expect(countMessagesTokens([])).toBe(0);
  });

  it('handles content blocks (array format)', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }], // 11 chars = 3 tokens + 4 overhead = 7
      },
    ];
    expect(countMessagesTokens(messages)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. Correct cost formula
// ---------------------------------------------------------------------------

describe('estimateChatRequest', () => {
  it('uses max_tokens when provided', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = estimateChatRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      });

      expect(result.estimated_output_tokens).toBe(100);
      expect(result.model).toBe('gpt-4o');
      expect(result.provider).toBe('openai');
      expect(result.note).toBe('estimate only');
    });
  });

  it('defaults output to 1.5x input when max_tokens not specified', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const messages = [{ role: 'user', content: 'a'.repeat(40) }]; // 10 tokens + 4 overhead = 14
      const result = estimateChatRequest({ model: 'gpt-4o', messages });
      const expectedOutput = Math.ceil(14 * 1.5); // 21
      expect(result.estimated_output_tokens).toBe(expectedOutput);
    });
  });

  it('calculates cost using the MODEL_PRICING table', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const pricing = MODEL_PRICING['gpt-4o'];
      expect(pricing).toBeDefined();

      // 1M input tokens at pricing.input + 1M output at pricing.output = total
      const result = estimateChatRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'a'.repeat(4_000_000) }], // ~1M tokens
        max_tokens: 1_000_000,
      });

      const inputTokens = result.input_tokens;
      const expectedCost =
        (inputTokens / 1_000_000) * pricing.input +
        (1_000_000 / 1_000_000) * pricing.output;

      expect(result.estimated_cost_usd).toBeCloseTo(expectedCost, 6);
    });
  });

  it('returns numeric cost (not NaN or negative)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = estimateChatRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Write me a poem' }],
        max_tokens: 500,
      });

      expect(typeof result.estimated_cost_usd).toBe('number');
      expect(result.estimated_cost_usd).toBeGreaterThan(0);
      expect(Number.isNaN(result.estimated_cost_usd)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Pro gate enforced (402 for free tier)
// ---------------------------------------------------------------------------

describe('handleEstimateRequest — Pro gate', () => {
  it('returns 402 for free-tier users (no env override, no credentials)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', undefined, () => {
      const result = handleEstimateRequest(
        JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        })
      );
      expect(result.status).toBe(402);
      expect((result.body as any).error).toBe('upgrade_required');
      expect((result.body as any).url).toContain('relayplane.com/pricing');
    });
  });

  it('returns 200 for Pro users (env override = true)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', 'true', () => {
      const result = handleEstimateRequest(
        JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        })
      );
      expect(result.status).toBe(200);
      expect((result.body as any).note).toBe('estimate only');
    });
  });

  it('402 response includes upgrade URL', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '0', () => {
      const result = handleEstimateRequest(
        JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        })
      );
      expect(result.status).toBe(402);
      const body = result.body as any;
      expect(body.url).toBe('https://relayplane.com/pricing');
      expect(body.message).toMatch(/upgrade/i);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Handles unknown model gracefully
// ---------------------------------------------------------------------------

describe('Unknown model handling', () => {
  it('returns a cost estimate for an unknown model (uses default pricing)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = estimateChatRequest({
        model: 'unknown-model-xyz-99',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      });

      // Should not throw and should return a positive cost
      expect(result.estimated_cost_usd).toBeGreaterThan(0);
      expect(result.model).toBe('unknown-model-xyz-99');
    });
  });

  it('infers provider as "unknown" for unrecognized model names', () => {
    expect(inferProvider('unknown-model-xyz')).toBe('unknown');
  });

  it('still returns full response shape for unknown models', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = estimateChatRequest({
        model: 'totally-made-up-model',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('estimated_cost_usd');
      expect(result).toHaveProperty('input_tokens');
      expect(result).toHaveProperty('estimated_output_tokens');
      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('note');
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Provider inference
// ---------------------------------------------------------------------------

describe('inferProvider', () => {
  it('identifies Anthropic models', () => {
    expect(inferProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(inferProvider('claude-opus-4-5')).toBe('anthropic');
    expect(inferProvider('claude-3-5-haiku-20241022')).toBe('anthropic');
  });

  it('identifies OpenAI models', () => {
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('gpt-4o-mini')).toBe('openai');
    expect(inferProvider('gpt-4.1')).toBe('openai');
  });

  it('identifies Google models', () => {
    expect(inferProvider('gemini-2.5-pro')).toBe('google');
    expect(inferProvider('gemini-1.5-flash')).toBe('google');
  });
});

// ---------------------------------------------------------------------------
// 6. MCP tool shape
// ---------------------------------------------------------------------------

describe('MCP relay_estimate_cost tool integration', () => {
  it('tool definition has the correct name and required fields', async () => {
    const { relayEstimateCostDefinition } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );

    expect(relayEstimateCostDefinition.name).toBe('relay_estimate_cost');
    expect(relayEstimateCostDefinition.inputSchema.required).toContain('model');
    expect(relayEstimateCostDefinition.inputSchema.required).toContain('messages');
  });

  it('relayEstimateCost returns upgrade error when proxy returns 402', async () => {
    const { relayEstimateCost } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );

    // Mock fetch to simulate a 402 response
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({
        error: 'upgrade_required',
        message: 'Upgrade to Pro for pre-flight cost estimation',
        url: 'https://relayplane.com/pricing',
      }),
    }) as any;

    try {
      const result = await relayEstimateCost({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/upgrade/i);
        expect(result.upgradeUrl).toContain('relayplane.com/pricing');
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('relayEstimateCost returns valid estimate when proxy succeeds', async () => {
    const { relayEstimateCost } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );

    const mockEstimate = {
      model: 'gpt-4o',
      estimated_cost_usd: 0.00025,
      input_tokens: 10,
      estimated_output_tokens: 15,
      provider: 'openai',
      note: 'estimate only',
    };

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockEstimate,
    }) as any;

    try {
      const result = await relayEstimateCost({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test prompt' }],
        max_tokens: 15,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.estimate.model).toBe('gpt-4o');
        expect(result.estimate.note).toBe('estimate only');
        expect(result.estimate.estimated_cost_usd).toBeGreaterThan(0);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Security fixes (sentinel findings)
// ---------------------------------------------------------------------------

// Fix #2: RELAYPLANE_PRO_ESTIMATE env bypass blocked in production
describe('isProTier — production env override gate (Fix #2)', () => {
  it('env override is NOT respected when NODE_ENV=production', () => {
    const origNode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    withEnv('RELAYPLANE_PRO_ESTIMATE', 'true', () => {
      // In production the env override must be ignored; credentials don't exist, so returns false
      expect(isProTier()).toBe(false);
    });
    process.env.NODE_ENV = origNode;
  });

  it('env override IS respected when NODE_ENV=test', () => {
    const origNode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      expect(isProTier()).toBe(true);
    });
    process.env.NODE_ENV = origNode;
  });
});

// Fix #5: Unbounded max_tokens validation
describe('handleEstimateRequest — max_tokens bounds (Fix #5)', () => {
  it('returns 400 invalid_request for max_tokens = 0', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 })
      );
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
      expect((result.body as InvalidRequestError).message).toMatch(/max_tokens/);
    });
  });

  it('returns 400 invalid_request for max_tokens = -1', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: -1 })
      );
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('returns 400 invalid_request for max_tokens > 200000', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 999_999 })
      );
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('returns 400 invalid_request for max_tokens = Infinity', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      // JSON.stringify converts Infinity to null — test the boundary separately
      const body = '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"max_tokens":1e400}';
      const result = handleEstimateRequest(body);
      // 1e400 parses as Infinity in JS
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('accepts max_tokens = 1 (lower bound)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
      );
      expect(result.status).toBe(200);
    });
  });

  it('accepts max_tokens = 200000 (upper bound)', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 200_000 })
      );
      expect(result.status).toBe(200);
    });
  });
});

// Fix #6: Wrong error code on 400 responses
describe('handleEstimateRequest — correct error codes on 400 (Fix #6)', () => {
  it('returns error: invalid_request (not upgrade_required) for bad JSON', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest('not-valid-json{{{');
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('returns error: invalid_request for missing model field', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(
        JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('returns error: invalid_request for missing messages field', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', '1', () => {
      const result = handleEstimateRequest(JSON.stringify({ model: 'gpt-4o' }));
      expect(result.status).toBe(400);
      expect((result.body as InvalidRequestError).error).toBe('invalid_request');
    });
  });

  it('402 responses still use error: upgrade_required', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', undefined, () => {
      const result = handleEstimateRequest(
        JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(result.status).toBe(402);
      expect((result.body as any).error).toBe('upgrade_required');
    });
  });
});

// Fix #4: SSRF via RELAYPLANE_PROXY_URL
describe('relayEstimateCost — SSRF validation (Fix #4)', () => {
  it('rejects non-localhost URLs', async () => {
    const { relayEstimateCost } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );
    const origUrl = process.env.RELAYPLANE_PROXY_URL;
    process.env.RELAYPLANE_PROXY_URL = 'http://evil.attacker.com/';
    try {
      const result = await relayEstimateCost({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/localhost|invalid/i);
      }
    } finally {
      if (origUrl === undefined) delete process.env.RELAYPLANE_PROXY_URL;
      else process.env.RELAYPLANE_PROXY_URL = origUrl;
    }
  });

  it('rejects file:// scheme URLs', async () => {
    const { relayEstimateCost } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );
    const origUrl = process.env.RELAYPLANE_PROXY_URL;
    process.env.RELAYPLANE_PROXY_URL = 'file:///etc/passwd';
    try {
      const result = await relayEstimateCost({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.success).toBe(false);
    } finally {
      if (origUrl === undefined) delete process.env.RELAYPLANE_PROXY_URL;
      else process.env.RELAYPLANE_PROXY_URL = origUrl;
    }
  });

  it('accepts the default localhost URL', async () => {
    const { relayEstimateCost } = await import(
      '../../mcp-server/src/tools/relay-estimate-cost.js'
    );
    // Mock fetch since we don't have a real proxy running
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    try {
      const result = await relayEstimateCost({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });
      // Connection refused is expected (no proxy running), but SSRF check passed
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/ECONNREFUSED|reach/i);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 0 item 2: free-tier access to /v1/estimate (rp-estimate-free-tier)
// ---------------------------------------------------------------------------

describe('handleEstimateRequest — free-tier access (Phase 0)', () => {
  it('returns 200 EstimateResponse for free-tier users (no plan, no env override)', () => {
    // Simulate a free-tier user: clear RELAYPLANE_PRO_ESTIMATE and set NODE_ENV=production
    // so the env-override bypass path is not taken.  The Pro gate must NOT fire.
    withEnv('RELAYPLANE_PRO_ESTIMATE', undefined, () => {
      const origNode = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const result = handleEstimateRequest(
          JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'How much will this cost?' }],
          })
        );
        // Must NOT return upgrade_required for free-tier users
        expect(result.status).toBe(200);
        expect((result.body as any).note).toBe('estimate only');
        expect((result.body as any).estimated_cost_usd).toBeGreaterThan(0);
      } finally {
        process.env.NODE_ENV = origNode;
      }
    });
  });

  it('free-tier users receive full EstimateResponse shape', () => {
    withEnv('RELAYPLANE_PRO_ESTIMATE', undefined, () => {
      const origNode = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const result = handleEstimateRequest(
          JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: 'Tell me a story' }],
            max_tokens: 200,
          })
        );
        expect(result.status).toBe(200);
        const body = result.body as any;
        expect(body).toHaveProperty('model', 'claude-sonnet-4-6');
        expect(body).toHaveProperty('estimated_cost_usd');
        expect(body).toHaveProperty('input_tokens');
        expect(body).toHaveProperty('estimated_output_tokens', 200);
        expect(body).toHaveProperty('provider', 'anthropic');
        expect(body).toHaveProperty('note', 'estimate only');
      } finally {
        process.env.NODE_ENV = origNode;
      }
    });
  });

  it('JSDoc no longer describes /v1/estimate as a Pro-tier feature', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/estimate.ts'),
      'utf8'
    );
    // The old JSDoc said "Pro-tier feature" — it must be removed
    expect(src).not.toMatch(/Pro-tier feature/);
  });
});
