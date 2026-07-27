import React from 'react';

// Polls /v1/telemetry/providers?days=N and maps server shape
// ({provider, share, p95Ms, rpm, health, primary, note}) into the
// ProviderStrip tile shape ({id, share, p95, rpmUsed, rpmCap, health,
// primary, note}). Refetches whenever `days` changes.

function mapProvider(p) {
  const rpm = Number(p?.rpm) || 0;
  const p95Ms = Number(p?.p95Ms) || 0;
  // ProviderTile expects p.p95 as a string with a trim()-able value.
  const p95Str = p95Ms > 0 ? `${(p95Ms / 1000).toFixed(2)}s` : '0s';
  // Server doesn't currently expose a rpm cap; surface used=rpm, cap=rpm
  // so the tile renders something sensible without lying about headroom.
  return {
    id: String(p?.provider || 'unknown'),
    share: Number(p?.share) * 100 || 0, // server returns 0..1, UI expects %
    p95: p95Str,
    rpmUsed: rpm,
    rpmCap: rpm,
    health: Number(p?.health) || 0,
    primary: Boolean(p?.primary),
    note: p?.note ? String(p.note) : '',
  };
}

async function fetchProviders(days) {
  const r = await fetch(`/v1/telemetry/providers?days=${days}`);
  if (!r.ok) throw new Error(`providers ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.providers) ? j.providers : []);
  return arr.map(mapProvider);
}

export function useLiveProviders({ intervalMs = 10000, days = 1 } = {}) {
  const [providers, setProviders] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      fetchProviders(days)
        .then(p => { if (alive) { setProviders(p); setError(null); setLoading(false); } })
        .catch(e => { if (alive) { setError(e); setLoading(false); } });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs, days]);

  return { providers, loading, error };
}
