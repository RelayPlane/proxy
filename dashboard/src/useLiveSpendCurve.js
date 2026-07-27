import React from 'react';

// 24-bucket hourly spend curve, sourced from /v1/telemetry/spend-by-hour
// (server-side, no client episodic bucketing). For days>1 we sum N days of
// spend-by-hour into a single 24-bucket curve (hour-of-day rollup) so the
// chart shape stays stable across TODAY/7D/30D pills.
// Return shape: { curve: number[24] (cumulative), nowHr: number }.

function utcDayString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchOneDay(day) {
  const r = await fetch(`/v1/telemetry/spend-by-hour?day=${day}`);
  if (!r.ok) return null;
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.buckets) ? j.buckets : null);
  if (!arr) return null;
  const out = new Array(24).fill(0);
  for (const e of arr) {
    const h = Number(e?.hour);
    const v = Number(e?.usd) || 0;
    if (Number.isInteger(h) && h >= 0 && h < 24) out[h] += v;
  }
  return out;
}

async function fetchCurve(days = 1) {
  const buckets = new Array(24).fill(0);
  const promises = [];
  for (let i = 0; i < days; i++) {
    promises.push(fetchOneDay(utcDayString(i)));
  }
  const results = await Promise.all(promises);
  for (const arr of results) {
    if (!arr) continue;
    for (let h = 0; h < 24; h++) buckets[h] += arr[h];
  }
  // Cumulative, the chart expects a monotonically growing curve.
  const curve = buckets.slice();
  for (let i = 1; i < 24; i++) curve[i] += curve[i - 1];
  return { curve, nowHr: new Date().getHours() };
}

export function useLiveSpendCurve(intervalMs = 30000, days = 1) {
  const [state, setState] = React.useState({ curve: new Array(24).fill(0), nowHr: new Date().getHours() });
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchCurve(days)
        .then(d => { if (alive) setState(d); })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, days]);
  return state;
}
