import React from 'react';

// Polls /v1/sessions and maps to the dashboard Sessions panel row shape.

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function toMix(modelMix) {
  const entries = Object.entries(modelMix || {});
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  return entries
    .map(([model, n]) => ({ model, pct: Math.round((n / total) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

function mapSession(s) {
  const idShort = (s.id || '').slice(0, 8);
  return {
    id: idShort,
    agent: s.session_source || 'unknown',
    started: fmtTime(s.started_at),
    dur: fmtDur(s.duration_ms ?? (s.last_seen_at - s.started_at)),
    requests: s.request_count ?? 0,
    cost: s.total_cost_usd ?? 0,
    savings: s.total_savings_usd ?? 0,
    mix: toMix(s.model_mix),
  };
}

async function fetchSessions(limit, days) {
  const r = await fetch(`/v1/sessions?limit=${limit}&days=${days}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.sessions || []).map(mapSession);
}

export function useLiveSessions({ intervalMs = 5000, limit = 20, days = 1 } = {}) {
  const [sessions, setSessions] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchSessions(limit, days)
        .then(s => { if (alive) setSessions(s); })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, limit, days]);
  return sessions;
}
