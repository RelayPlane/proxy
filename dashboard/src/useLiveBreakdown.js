import React from 'react';

// Polls /v1/telemetry/stats for byModel + byAgent breakdown rows.
// Empty arrays when proxy is fresh; component handles empty-state.

export function useLiveBreakdown({ intervalMs = 10000, days = 1 } = {}) {
  const [data, setData] = React.useState({ byModel: [], byAgent: [] });

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch(`/v1/telemetry/stats?days=${days}`)
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!alive || !j) return;
          setData({
            byModel: Array.isArray(j.byModel) ? j.byModel : [],
            byAgent: Array.isArray(j.byAgent) ? j.byAgent : [],
          });
        })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, days]);

  return data;
}
