export type DashboardState = 'active' | 'first-run' | 'runaway' | 'budget-exceeded' | 'kill-switch';

export interface DashboardStateFlags {
  killSwitchActive: boolean;
  isBudgetExceeded: boolean;
  hasRunawayAlert: boolean;
  isFirstRun: boolean;
}

/**
 * Single source of truth for which of the 5 approved-design dashboard states
 * wins when more than one condition is true at once. Priority, most severe
 * first: kill-switch > budget-exceeded > runaway > first-run > active.
 */
export function resolveDashboardState(flags: DashboardStateFlags): DashboardState {
  if (flags.killSwitchActive) return 'kill-switch';
  if (flags.isBudgetExceeded) return 'budget-exceeded';
  if (flags.hasRunawayAlert) return 'runaway';
  if (flags.isFirstRun) return 'first-run';
  return 'active';
}
