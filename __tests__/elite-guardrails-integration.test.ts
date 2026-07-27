/**
 * TDD Phase 1: Integration-level failing tests for PR D elite cost guardrails.
 *
 * The unit-level EliteGuardrails class exists, but the proxy does not yet:
 *   1. Wire guardrails into its route selection path (checkRoute before dispatch)
 *   2. Expose observability getters (getSessionCount, getDailySpend)
 *   3. Provide a resetDailySpend method for day-boundary resets
 *   4. Persist config from relayplane config.json elite_guardrails section
 *
 * These tests MUST fail until the integration is built.
 */
import { describe, it, expect } from 'vitest';

import {
  EliteGuardrails,
  DEFAULT_ELITE_GUARDRAILS,
} from '../src/elite-guardrails.js';

describe('PR D integration: elite guardrails observability + reset', () => {
  describe('observability getters', () => {
    it('getSessionCount returns the number of elite calls for a session', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      expect(g.getSessionCount('sess-1')).toBe(0);
      g.recordEliteCall({ sessionId: 'sess-1', costUsd: 0.05 });
      g.recordEliteCall({ sessionId: 'sess-1', costUsd: 0.05 });
      expect(g.getSessionCount('sess-1')).toBe(2);
      expect(g.getSessionCount('sess-other')).toBe(0);
    });

    it('getDailySpend returns accumulated daily spend in USD', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      expect(g.getDailySpend()).toBe(0);
      g.recordEliteCall({ sessionId: 's1', costUsd: 1.5 });
      g.recordEliteCall({ sessionId: 's2', costUsd: 2.0 });
      expect(g.getDailySpend()).toBeCloseTo(3.5, 2);
    });
  });

  describe('daily spend reset', () => {
    it('resetDailySpend clears the accumulated spend to zero', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      g.recordEliteCall({ sessionId: 's1', costUsd: 4.0 });
      expect(g.getDailySpend()).toBeCloseTo(4.0, 2);
      g.resetDailySpend();
      expect(g.getDailySpend()).toBe(0);
    });

    it('after resetDailySpend, elite calls are allowed again', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      // Burn the daily cap
      g.recordEliteCall({ sessionId: 's1', costUsd: 6.0 });
      const blocked = g.checkRoute({
        sessionId: 's-new',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(blocked.downgraded).toBe(true);

      // Reset and verify elite is allowed again
      g.resetDailySpend();
      const allowed = g.checkRoute({
        sessionId: 's-new',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(allowed.tier).toBe('elite');
      expect(allowed.downgraded).toBe(false);
    });
  });

  describe('clearSession', () => {
    it('clearSession removes a specific session counter without affecting others', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      g.recordEliteCall({ sessionId: 'sess-A', costUsd: 0.01 });
      g.recordEliteCall({ sessionId: 'sess-A', costUsd: 0.01 });
      g.recordEliteCall({ sessionId: 'sess-B', costUsd: 0.01 });

      g.clearSession('sess-A');
      expect(g.getSessionCount('sess-A')).toBe(0);
      expect(g.getSessionCount('sess-B')).toBe(1);
    });
  });

  describe('config from relayplane config.json', () => {
    it('parseEliteGuardrailsConfig reads elite_guardrails from config object', async () => {
      const { parseEliteGuardrailsConfig } = await import('../src/elite-guardrails.js');
      const config = parseEliteGuardrailsConfig({
        routing: {
          allow_elite_auto: true,
          elite_guardrails: {
            per_session_calls: 5,
            per_day_usd: 10,
          },
        },
      });
      expect(config.enabled).toBe(true);
      expect(config.perSessionCalls).toBe(5);
      expect(config.perDayUsd).toBe(10);
    });

    it('parseEliteGuardrailsConfig returns defaults when section is absent', async () => {
      const { parseEliteGuardrailsConfig } = await import('../src/elite-guardrails.js');
      const config = parseEliteGuardrailsConfig({ routing: {} });
      expect(config.enabled).toBe(false);
      expect(config.perSessionCalls).toBe(DEFAULT_ELITE_GUARDRAILS.perSessionCalls);
      expect(config.perDayUsd).toBe(DEFAULT_ELITE_GUARDRAILS.perDayUsd);
    });
  });
});
