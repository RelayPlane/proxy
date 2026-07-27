/**
 * TDD Phase 1: Failing tests for PR D, elite cost guardrails.
 *
 * Per the model-routing-modernization-plan (2026-06-09), PR D adds cost
 * guardrails that are active ONLY when elite is enabled:
 *   - per-session elite call cap (default 3 calls/session)
 *   - per-day elite spend cap (default $5/day)
 *   - auto-downgrade elite -> complex when a cap is hit
 *   - pre-flight warning for elite calls over 10K tokens
 *
 * When elite is disabled (default), no behavior change at all.
 *
 * These tests target an EliteGuardrails module that does not exist yet.
 * They MUST fail at this phase.
 */
import { describe, it, expect } from 'vitest';

// Importing a module that does not exist yet. The import itself will fail
// until PR D ships, which is a valid failing-test signal for TDD Phase 1.
// @ts-expect-error - module does not exist yet
import {
  EliteGuardrails,
  DEFAULT_ELITE_GUARDRAILS,
  ELITE_TOKEN_WARNING_THRESHOLD,
} from '../src/elite-guardrails.js';

describe('PR D: elite cost guardrails', () => {
  describe('defaults', () => {
    it('default per-session call cap is 3', () => {
      expect(DEFAULT_ELITE_GUARDRAILS.perSessionCalls).toBe(3);
    });

    it('default per-day spend cap is $5', () => {
      expect(DEFAULT_ELITE_GUARDRAILS.perDayUsd).toBe(5);
    });

    it('default pre-flight token warning threshold is 10000', () => {
      expect(ELITE_TOKEN_WARNING_THRESHOLD).toBe(10000);
    });
  });

  describe('elite disabled = no behavior change', () => {
    it('checkRoute returns elite unchanged when elite is disabled', () => {
      const g = new EliteGuardrails({
        ...DEFAULT_ELITE_GUARDRAILS,
        enabled: false,
      });
      // 100 prior calls + huge spend: still no downgrade because elite is off
      for (let i = 0; i < 100; i++) {
        g.recordEliteCall({ sessionId: 's1', costUsd: 100 });
      }
      const decision = g.checkRoute({
        sessionId: 's1',
        proposedTier: 'elite',
        estimatedTokens: 50000,
      });
      expect(decision.tier).toBe('elite');
      expect(decision.downgraded).toBe(false);
      expect(decision.warning).toBeFalsy();
    });
  });

  describe('per-session call cap (default 3)', () => {
    it('allows the first 3 elite calls in a session', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      for (let i = 0; i < 3; i++) {
        const d = g.checkRoute({
          sessionId: 'sess-A',
          proposedTier: 'elite',
          estimatedTokens: 100,
        });
        expect(d.tier).toBe('elite');
        expect(d.downgraded).toBe(false);
        g.recordEliteCall({ sessionId: 'sess-A', costUsd: 0.01 });
      }
    });

    it('downgrades the 4th elite call in a session to complex', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      for (let i = 0; i < 3; i++) {
        g.recordEliteCall({ sessionId: 'sess-A', costUsd: 0.01 });
      }
      const d = g.checkRoute({
        sessionId: 'sess-A',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(d.tier).toBe('complex');
      expect(d.downgraded).toBe(true);
      expect(d.reason).toBe('per_session_cap');
    });

    it('per-session cap is scoped per session, not global', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      for (let i = 0; i < 3; i++) {
        g.recordEliteCall({ sessionId: 'sess-A', costUsd: 0.01 });
      }
      // sess-B has its own counter
      const d = g.checkRoute({
        sessionId: 'sess-B',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(d.tier).toBe('elite');
      expect(d.downgraded).toBe(false);
    });
  });

  describe('per-day spend cap (default $5)', () => {
    it('downgrades elite to complex once the daily spend cap is hit', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      // Spread across many sessions so per-session cap is not the trigger
      for (let i = 0; i < 10; i++) {
        g.recordEliteCall({ sessionId: `s-${i}`, costUsd: 0.6 });
      }
      // $6 > $5 cap, next call (in a fresh session) must downgrade.
      const d = g.checkRoute({
        sessionId: 's-new',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(d.tier).toBe('complex');
      expect(d.downgraded).toBe(true);
      expect(d.reason).toBe('per_day_cap');
    });

    it('does not downgrade while daily spend is below cap', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      g.recordEliteCall({ sessionId: 's-1', costUsd: 1.0 });
      g.recordEliteCall({ sessionId: 's-2', costUsd: 1.0 });
      const d = g.checkRoute({
        sessionId: 's-3',
        proposedTier: 'elite',
        estimatedTokens: 100,
      });
      expect(d.tier).toBe('elite');
      expect(d.downgraded).toBe(false);
    });
  });

  describe('pre-flight warning for elite calls over 10K tokens', () => {
    it('emits a warning when an elite call exceeds 10K estimated tokens', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      const d = g.checkRoute({
        sessionId: 'sess-X',
        proposedTier: 'elite',
        estimatedTokens: 12000,
      });
      expect(d.tier).toBe('elite');
      expect(d.warning).toBeTruthy();
      expect(d.warning).toMatch(/token|cost|expensive/i);
    });

    it('does not emit a warning for elite calls under 10K tokens', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      const d = g.checkRoute({
        sessionId: 'sess-Y',
        proposedTier: 'elite',
        estimatedTokens: 5000,
      });
      expect(d.warning).toBeFalsy();
    });

    it('does not emit a warning when the proposed tier is not elite', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      const d = g.checkRoute({
        sessionId: 'sess-Z',
        proposedTier: 'complex',
        estimatedTokens: 50000,
      });
      expect(d.warning).toBeFalsy();
    });
  });

  describe('non-elite tiers pass through untouched', () => {
    it('checkRoute on a complex/moderate/simple tier never downgrades', () => {
      const g = new EliteGuardrails({ ...DEFAULT_ELITE_GUARDRAILS, enabled: true });
      // Burn the caps with elite calls
      for (let i = 0; i < 50; i++) {
        g.recordEliteCall({ sessionId: 'sess-A', costUsd: 10 });
      }
      for (const tier of ['simple', 'moderate', 'complex'] as const) {
        const d = g.checkRoute({
          sessionId: 'sess-A',
          proposedTier: tier,
          estimatedTokens: 100,
        });
        expect(d.tier).toBe(tier);
        expect(d.downgraded).toBe(false);
      }
    });
  });
});
