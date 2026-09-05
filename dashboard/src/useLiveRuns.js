import React from 'react';

// Polls the run attribution API and shapes rows for the Runs ledger.
//   active: true  -> GET /v1/runs/active  (running runs touched in the last 5 min,
//                    plus cost_per_minute / projected_cost_at_idle_close / rate_limit_wave)
//   active: false -> GET /v1/runs?days=&label=&source=&limit=100
// Rows keep every raw field from the API and add three presentation fields:
// startedLabel, durLabel, topAgent.

export function fmtRunClock(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

export function fmtRunDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// Highest-cost agent label, only available when the payload carries `agents`.
export function topAgentOf(run) {
  const agents = Array.isArray(run && run.agents) ? run.agents : null;
  if (!agents || agents.length === 0) return null;
  let best = null;
  for (const a of agents) {
    if (!best || (Number(a.cost_usd) || 0) > (Number(best.cost_usd) || 0)) best = a;
  }
  return best ? best.agent_label : null;
}

export function mapRun(run) {
  const started = Number(run.started_at) || 0;
  const end = Number(run.ended_at) || Number(run.last_seen_at) || started;
  return {
    ...run,
    startedLabel: fmtRunClock(started),
    durLabel: fmtRunDur(end - started),
    topAgent: topAgentOf(run),
  };
}

function buildUrl({ active, days, label, source }) {
  if (active) return '/v1/runs/active';
  const q = new URLSearchParams();
  q.set('days', String(days || 1));
  q.set('limit', '100');
  if (label) q.set('label', label);
  if (source && source !== 'all') q.set('source', source);
  return `/v1/runs?${q.toString()}`;
}

export function useLiveRuns({ intervalMs = 5000, days = 1, label = '', source = '', active = false } = {}) {
  const [runs, setRuns] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const refresh = React.useCallback(() => setNonce(n => n + 1), []);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch(buildUrl({ active, days, label, source }))
        .then(r => {
          if (!r.ok) throw new Error(`runs ${r.status}`);
          return r.json();
        })
        .then(j => {
          if (!alive) return;
          setRuns((Array.isArray(j.runs) ? j.runs : []).map(mapRun));
          setError(null);
          setLoading(false);
        })
        .catch(e => {
          if (!alive) return;
          setError(e.message || 'failed to load runs');
          setLoading(false);
        });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, days, label, source, active, nonce]);

  return { runs, loading, error, refresh };
}
