import React from 'react';

// Polls GET /v1/runs/alerts. Rows are newest first, straight from run_alerts.
// Used twice: the app-level critical strip and the per-run alert list.

export function useRunAlerts({ intervalMs = 15000, since = '1h', limit = 50, runId = null } = {}) {
  const [alerts, setAlerts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const refresh = React.useCallback(() => setNonce(n => n + 1), []);

  React.useEffect(() => {
    let alive = true;
    const q = new URLSearchParams();
    q.set('since', since);
    q.set('limit', String(limit));
    if (runId) q.set('run_id', runId);
    const tick = () => {
      fetch(`/v1/runs/alerts?${q.toString()}`)
        .then(r => {
          if (!r.ok) throw new Error(`alerts ${r.status}`);
          return r.json();
        })
        .then(j => {
          if (!alive) return;
          setAlerts(Array.isArray(j.alerts) ? j.alerts : []);
          setError(null);
          setLoading(false);
        })
        .catch(e => {
          if (!alive) return;
          setError(e.message || 'failed to load run alerts');
          setLoading(false);
        });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, since, limit, runId, nonce]);

  return { alerts, loading, error, refresh };
}
