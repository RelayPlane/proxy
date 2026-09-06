/**
 * Dashboard redesign, RelayPlane Overview state resolution.
 *
 * The approved design (notes/dashboard-design-files/RelayPlane Overview.dc.html)
 * defines exactly 5 mutually exclusive dashboard states, driven by live data
 * from /control/status (kill switch), /control/budget + /v1/telemetry/stats
 * (budget exceeded), /v1/runs/alerts (a run tracking over its expected band,
 * "runaway"), and /v1/telemetry/stats + /v1/runs/active (first run, no
 * traffic yet). Anything else is the plain "active" state.
 *
 * `resolveDashboardState` is the single source of truth for which of the 5
 * states wins when more than one condition is true at once. Priority, most
 * severe first: kill-switch > budget-exceeded > runaway > first-run > active.
 * This mirrors the banner precedence in the approved design, where only one
 * state chip is ever selected at a time.
 */
import { describe, it, expect } from 'vitest';
import { resolveDashboardState } from '../dashboard/src/dashboardState.js';

function flags(overrides: Partial<{
  killSwitchActive: boolean;
  isBudgetExceeded: boolean;
  hasRunawayAlert: boolean;
  isFirstRun: boolean;
}> = {}) {
  return {
    killSwitchActive: false,
    isBudgetExceeded: false,
    hasRunawayAlert: false,
    isFirstRun: false,
    ...overrides,
  };
}

describe('resolveDashboardState', () => {
  it('returns "active" when nothing else applies', () => {
    expect(resolveDashboardState(flags())).toBe('active');
  });

  it('returns "first-run" when there is no traffic yet and nothing else applies', () => {
    expect(resolveDashboardState(flags({ isFirstRun: true }))).toBe('first-run');
  });

  it('returns "runaway" when a run alert is tracking over its expected band', () => {
    expect(resolveDashboardState(flags({ hasRunawayAlert: true }))).toBe('runaway');
  });

  it('returns "budget-exceeded" when today\'s spend has crossed the cap', () => {
    expect(resolveDashboardState(flags({ isBudgetExceeded: true }))).toBe('budget-exceeded');
  });

  it('returns "kill-switch" when traffic is halted', () => {
    expect(resolveDashboardState(flags({ killSwitchActive: true }))).toBe('kill-switch');
  });

  it('kill-switch outranks every other condition', () => {
    const state = resolveDashboardState(flags({
      killSwitchActive: true,
      isBudgetExceeded: true,
      hasRunawayAlert: true,
      isFirstRun: true,
    }));
    expect(state).toBe('kill-switch');
  });

  it('budget-exceeded outranks runaway and first-run when the kill switch is off', () => {
    const state = resolveDashboardState(flags({
      isBudgetExceeded: true,
      hasRunawayAlert: true,
      isFirstRun: true,
    }));
    expect(state).toBe('budget-exceeded');
  });

  it('runaway outranks first-run when the kill switch is off and budget is not exceeded', () => {
    const state = resolveDashboardState(flags({
      hasRunawayAlert: true,
      isFirstRun: true,
    }));
    expect(state).toBe('runaway');
  });

  it('only ever returns one of the 5 approved-design states', () => {
    const allStates = new Set<string>();
    for (const killSwitchActive of [false, true]) {
      for (const isBudgetExceeded of [false, true]) {
        for (const hasRunawayAlert of [false, true]) {
          for (const isFirstRun of [false, true]) {
            allStates.add(resolveDashboardState({
              killSwitchActive, isBudgetExceeded, hasRunawayAlert, isFirstRun,
            }));
          }
        }
      }
    }
    expect(allStates).toEqual(new Set(['active', 'first-run', 'runaway', 'budget-exceeded', 'kill-switch']));
  });
});
