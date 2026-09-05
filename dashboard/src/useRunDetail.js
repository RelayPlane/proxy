import React from 'react';

// Polls one run: GET /v1/runs/:id for the rollup and GET /v1/runs/:id/requests
// for the tail. Actions mutate through the same localhost-only API:
//   rename    -> POST /v1/runs/:id      { label }
//   end       -> POST /v1/runs/:id/end  {}
//   setCap    -> POST /v1/runs/:id      { cap_usd }   (null clears the cap)
//   exportRun -> POST /v1/runs/export   { run_ids, format }  downloaded via a Blob URL

const REQUEST_LIMIT = 100;

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Streams the export response to disk without leaving the page.
async function downloadExport(id, format) {
  const res = await fetch('/v1/runs/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_ids: [id], format }),
  });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `relayplane-run-${String(id).replace(/[^A-Za-z0-9_.-]/g, '-')}.${format === 'jsonl' ? 'jsonl' : format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export function useRunDetail(id, { intervalMs = 5000 } = {}) {
  const [detail, setDetail] = React.useState(null);
  const [requests, setRequests] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const refresh = React.useCallback(() => setNonce(n => n + 1), []);

  React.useEffect(() => {
    if (!id) {
      setDetail(null);
      setRequests([]);
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    const encoded = encodeURIComponent(id);
    const tick = () => {
      Promise.all([
        fetch(`/v1/runs/${encoded}`).then(r => {
          if (!r.ok) throw new Error(r.status === 404 ? 'run not found' : `run ${r.status}`);
          return r.json();
        }),
        fetch(`/v1/runs/${encoded}/requests?limit=${REQUEST_LIMIT}`)
          .then(r => (r.ok ? r.json() : { requests: [] }))
          .catch(() => ({ requests: [] })),
      ])
        .then(([d, reqs]) => {
          if (!alive) return;
          setDetail(d);
          setRequests(Array.isArray(reqs.requests) ? reqs.requests : []);
          setError(null);
          setLoading(false);
        })
        .catch(e => {
          if (!alive) return;
          setError(e.message || 'failed to load run');
          setLoading(false);
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, [id, intervalMs, nonce]);

  const actions = React.useMemo(() => ({
    async rename(label) {
      await postJson(`/v1/runs/${encodeURIComponent(id)}`, { label });
      refresh();
    },
    async end() {
      await postJson(`/v1/runs/${encodeURIComponent(id)}/end`, {});
      refresh();
    },
    async setCap(usd) {
      const cap = usd === null || usd === '' ? null : Number(usd);
      await postJson(`/v1/runs/${encodeURIComponent(id)}`, { cap_usd: cap });
      refresh();
    },
    async exportRun(format) {
      await downloadExport(id, format || 'json');
    },
  }), [id, refresh]);

  return { detail, requests, loading, error, refresh, actions };
}
