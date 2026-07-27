import React from 'react';

// Polls /v1/memory/episodic and shapes events into RequestStream rows.
// Falls back to empty list on error. Newest event last (RequestStream reverses).

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

function shortModel(m) {
  if (!m) return 'unknown';
  return String(m).replace(/^(anthropic|openai|google)\//, '');
}

function statusFrom(outcome) {
  if (!outcome) return 'ok';
  const o = String(outcome).toLowerCase();
  if (o.includes('error') || o.includes('fail') || o.includes('deny')) return 'deny';
  if (o.includes('warn') || o.includes('throttle') || o.includes('retry')) return 'warn';
  return 'ok';
}

async function fetchRecent(limit) {
  const r = await fetch(`/v1/memory/episodic?limit=${limit}`);
  if (!r.ok) return [];
  const data = await r.json();
  const events = Array.isArray(data?.events) ? data.events : [];
  // API returns DESC by timestamp; flip to ASC so newest is last
  const asc = events.slice().reverse();
  return asc.map(e => {
    const model = shortModel(e.model_used);
    return {
      t: fmtTime(e.timestamp),
      status: statusFrom(e.outcome),
      agent: e.session_id ? String(e.session_id).slice(0, 8) : 'agent',
      rule: e.event_type || 'route',
      from: model,
      to: model,
      provider: (e.model_used || '').split('/')[0] || 'unknown',
      tokIn: Number(e.tokens_in) || 0,
      tokOut: Number(e.tokens_out) || 0,
      cost: Number(e.cost_usd) || 0,
      latMs: Number(e.duration_ms) || 0,
      reason: e.outcome_detail || '',
      cache: 0,
    };
  });
}

export function useLiveRequests({ intervalMs = 3000, limit = 60, days = 1 } = {}) {
  const [rows, setRows] = React.useState([]);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchRecent(limit)
        .then(d => { if (alive) setRows(d); })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    // days is accepted to allow callers to retrigger on pill change; the
    // episodic endpoint is small-window only, so we currently re-poll on
    // change without altering the URL.
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, limit, days]);

  return rows;
}
