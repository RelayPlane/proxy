import React from 'react';
import { RP_TODAY } from './fixtures';

// Fetches today's hero stats from the proxy. Budget cap and burn come solely
// from /control/budget (no hardcoded literal). Today's metrics come from
// /v1/telemetry/stats?days=N's `today` summary object.
//
// days arg controls the budget window:
//   days=1  -> cap = limit_usd
//   days=7  -> cap = this_week_usd  (fallback: limit_usd * 7)
//   days=30 -> cap = this_month_usd (fallback: limit_usd * 30)

export function budgetCapFor(budget, days) {
  if (!budget) return 0;
  const limit = Number(budget.limit_usd) || 0;
  if (days === 7) {
    const wk = Number(budget.this_week_usd);
    return Number.isFinite(wk) && wk > 0 ? wk : limit * 7;
  }
  if (days === 30) {
    const mo = Number(budget.this_month_usd);
    return Number.isFinite(mo) && mo > 0 ? mo : limit * 30;
  }
  return limit;
}

export async function fetchToday(days = 1) {
  const [statsR, savingsR, budgetR] = await Promise.all([
    fetch(`/v1/telemetry/stats?days=${days}`),
    fetch(`/v1/telemetry/savings?days=${days}`),
    fetch('/control/budget'),
  ]);
  const stats = statsR.ok ? await statsR.json() : null;
  const savings = savingsR.ok ? await savingsR.json() : null;
  const budget = budgetR.ok ? await budgetR.json() : null;

  const today = stats?.today || {};
  const requests = Number(today.totalRequests) || 0;
  const cost = Number(today.totalCost) || 0;
  const latencyAvgMs = Number(today.avgLatencyMs) || 0;
  const latencyP95Ms = Number(today.latencyP95 ?? stats?.latencyP95) || 0;
  const errorRate = Number(today.errorRate) || 0;
  const cacheHitRate = Number(today.cacheHitRate ?? stats?.cacheHitRate) || 0;

  return {
    ...RP_TODAY,
    requests,
    cost,
    latencyAvg: latencyAvgMs / 1000,
    latencyP95: latencyP95Ms / 1000,
    errorRate,
    cacheHitRate,
    savings: savings?.savedAmount ?? 0,
    savingsPct: savings?.percentage ?? 0,
    budget: budgetCapFor(budget, days),
    burn: Number(budget?.hourly_usd) || 0,
  };
}

export function useLiveToday(intervalMs = 5000, days = 1) {
  const [today, setToday] = React.useState(RP_TODAY);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchToday(days)
        .then(d => { if (alive) setToday(d); })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, days]);

  return today;
}
