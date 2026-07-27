import React from 'react';

// Returns current dashboard tier: 'free' | 'trial' | 'pro' | 'fleet' | 'max'.
// Reads from /health (proxy returns RELAYPLANE_PLAN env var). Falls back to
// ?tier= query override for local development.

const ORDER = ['free', 'trial', 'pro', 'fleet', 'max'];

export function useTier() {
  const [tier, setTier] = React.useState(() => {
    if (typeof window === 'undefined') return 'free';
    const q = new URLSearchParams(window.location.search).get('tier');
    return ORDER.includes(q) ? q : 'free';
  });
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search).get('tier');
    if (ORDER.includes(q)) return;
    let alive = true;
    fetch('/health')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j) return;
        const p = (j.plan || 'free').toLowerCase();
        if (ORDER.includes(p)) setTier(p);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return tier;
}
