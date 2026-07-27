/**
 * TDD Phase 1: Failing tests for PR D proxy wiring of elite cost guardrails.
 *
 * The EliteGuardrails class (src/elite-guardrails.ts) exists and is unit-tested,
 * but standalone-proxy.ts does not import or use it. The proxy classifies
 * complexity (including 'elite') but never checks guardrail caps before routing.
 *
 * These tests verify the integration: standalone-proxy must export a
 * routeWithGuardrails function (or equivalent) that:
 *   1. Applies per-session call cap before routing elite requests
 *   2. Applies per-day spend cap before routing elite requests
 *   3. Passes through non-elite tiers untouched even with blown caps
 *   4. Emits a warning header on high-token elite calls
 *
 * These tests MUST fail until the proxy wiring is built.
 */
import { describe, it, expect } from 'vitest';

import {
  routeWithGuardrails,
  getEliteGuardrailsInstance,
} from '../src/standalone-proxy.js';

describe('PR D proxy wiring: elite guardrails in routing path', () => {
  describe('routeWithGuardrails is exported and callable', () => {
    it('routeWithGuardrails is a function', () => {
      expect(typeof routeWithGuardrails).toBe('function');
    });

    it('getEliteGuardrailsInstance returns the singleton guardrails', () => {
      expect(typeof getEliteGuardrailsInstance).toBe('function');
      const instance = getEliteGuardrailsInstance();
      expect(instance).toBeDefined();
      expect(typeof instance.checkRoute).toBe('function');
      expect(typeof instance.recordEliteCall).toBe('function');
    });
  });

  describe('per-session cap enforcement via proxy routing', () => {
    it('downgrades elite to complex after 3 calls in same session', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.clearSession('proxy-test-sess');
      guardrails.resetDailySpend();

      for (let i = 0; i < 3; i++) {
        guardrails.recordEliteCall({
          sessionId: 'proxy-test-sess',
          costUsd: 0.01,
        });
      }

      const result = routeWithGuardrails({
        sessionId: 'proxy-test-sess',
        classifiedTier: 'elite',
        estimatedTokens: 500,
      });

      expect(result.tier).toBe('complex');
      expect(result.downgraded).toBe(true);
      expect(result.reason).toBe('per_session_cap');
    });

    it('allows elite when session count is below cap', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.clearSession('proxy-test-fresh');
      guardrails.resetDailySpend();

      const result = routeWithGuardrails({
        sessionId: 'proxy-test-fresh',
        classifiedTier: 'elite',
        estimatedTokens: 500,
      });

      expect(result.tier).toBe('elite');
      expect(result.downgraded).toBe(false);
    });
  });

  describe('per-day spend cap enforcement via proxy routing', () => {
    it('downgrades elite to complex when daily spend exceeds $5', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.resetDailySpend();

      for (let i = 0; i < 10; i++) {
        guardrails.recordEliteCall({
          sessionId: `spend-sess-${i}`,
          costUsd: 0.6,
        });
      }

      const result = routeWithGuardrails({
        sessionId: 'spend-sess-new',
        classifiedTier: 'elite',
        estimatedTokens: 500,
      });

      expect(result.tier).toBe('complex');
      expect(result.downgraded).toBe(true);
      expect(result.reason).toBe('per_day_cap');
    });
  });

  describe('non-elite tiers pass through untouched', () => {
    it('complex tier is never downgraded even with blown caps', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.resetDailySpend();

      for (let i = 0; i < 50; i++) {
        guardrails.recordEliteCall({
          sessionId: 'passthrough-sess',
          costUsd: 10,
        });
      }

      for (const tier of ['simple', 'moderate', 'complex'] as const) {
        const result = routeWithGuardrails({
          sessionId: 'passthrough-sess',
          classifiedTier: tier,
          estimatedTokens: 500,
        });
        expect(result.tier).toBe(tier);
        expect(result.downgraded).toBe(false);
      }
    });
  });

  describe('high-token warning on elite calls', () => {
    it('returns a warning when elite call exceeds 10K estimated tokens', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.clearSession('warn-sess');
      guardrails.resetDailySpend();

      const result = routeWithGuardrails({
        sessionId: 'warn-sess',
        classifiedTier: 'elite',
        estimatedTokens: 15000,
      });

      expect(result.tier).toBe('elite');
      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/token|cost|expensive/i);
    });

    it('does not warn on elite calls under 10K tokens', () => {
      const guardrails = getEliteGuardrailsInstance();
      guardrails.clearSession('no-warn-sess');
      guardrails.resetDailySpend();

      const result = routeWithGuardrails({
        sessionId: 'no-warn-sess',
        classifiedTier: 'elite',
        estimatedTokens: 5000,
      });

      expect(result.warning).toBeFalsy();
    });
  });
});
