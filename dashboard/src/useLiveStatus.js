import React from 'react';

// Polls /health for proxy version + uptime.

function fmtUptime(ms) {
  if (!ms || ms < 0) return '0m';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function useLiveStatus(intervalMs = 10000) {
  const [status, setStatus] = React.useState({ version: '', uptimeLabel: '0m', uptimeMs: 0 });
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch('/health')
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!alive || !j) return;
          setStatus({
            version: j.version || '',
            uptimeMs: j.uptimeMs ?? (j.uptime ? j.uptime * 1000 : 0),
            uptimeLabel: fmtUptime(j.uptimeMs ?? (j.uptime ? j.uptime * 1000 : 0)),
          });
        })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return status;
}
