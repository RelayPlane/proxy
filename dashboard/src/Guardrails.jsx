import React from 'react';

// Cost guardrails: daily cap, on-breach action, routing mode.
// Backend endpoints:
//   GET  /control/budget         -> { limit_usd, on_breach, ... }
//   POST /control/budget/set     -> { dailyUsd }
//   GET  /v1/config              -> { routing: { mode }, budget: { onBreach } }
//   POST /control/config         -> merge patch

const ROUTING_MODES = [
  { value: 'auto', label: 'auto (smart routing)' },
  { value: 'complexity', label: 'complexity (route by prompt difficulty)' },
  { value: 'cascade', label: 'cascade (haiku then sonnet then opus)' },
  { value: 'passthrough', label: 'passthrough (no routing)' },
];

const ON_BREACH = [
  { value: 'warn', label: 'warn (allow, log)' },
  { value: 'block', label: 'block (reject requests)' },
  { value: 'downgrade', label: 'downgrade (force haiku)' },
];

// Client-side pre-PATCH validation for the guardrails payload. Mirrors the
// server-side rules in BudgetManager.applyGuardrailsPatch (budget.ts) so
// invalid input never reaches the network.
export function validateGuardrailsPayload(payload) {
  const { perSessionUsd, perDayUsd, ladder = [], retries, windowSec } = payload;

  if (typeof perSessionUsd === 'number' && perSessionUsd < 0) {
    return { ok: false, error: 'invalid_cap' };
  }
  if (typeof perDayUsd === 'number' && perDayUsd < 0) {
    return { ok: false, error: 'invalid_cap' };
  }
  for (const row of ladder) {
    if (!row.from || !row.to) {
      return { ok: false, error: 'invalid_ladder_row' };
    }
    if (row.triggerPct < 1 || row.triggerPct > 99) {
      return { ok: false, error: 'invalid_ladder_row' };
    }
  }
  if (typeof retries === 'number' && retries < 1) {
    return { ok: false, error: 'invalid_runaway' };
  }
  if (typeof windowSec === 'number' && windowSec < 5) {
    return { ok: false, error: 'invalid_runaway' };
  }

  return { ok: true };
}

export function Guardrails() {
  const [cap, setCap] = React.useState('');
  const [capSaved, setCapSaved] = React.useState('');
  const [onBreach, setOnBreach] = React.useState('warn');
  const [routingMode, setRoutingMode] = React.useState('auto');
  const [savingCap, setSavingCap] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [budgetRes, configRes] = await Promise.all([
          fetch('/control/budget').then(r => r.ok ? r.json() : null),
          fetch('/v1/config').then(r => r.ok ? r.json() : null),
        ]);
        if (!alive) return;
        if (budgetRes) {
          const limit = Number(budgetRes.limit_usd ?? 0);
          setCap(limit > 0 ? String(limit) : '');
          setCapSaved(limit > 0 ? String(limit) : '');
          if (budgetRes.on_breach) setOnBreach(budgetRes.on_breach);
        }
        if (configRes?.routing?.mode) setRoutingMode(configRes.routing.mode);
      } catch (e) {
        setMsg({ kind: 'err', text: 'failed to load current config' });
      }
    })();
    return () => { alive = false; };
  }, []);

  function flash(kind, text) {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 2400);
  }

  async function saveCap() {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0) {
      flash('err', 'enter a positive number');
      return;
    }
    setSavingCap(true);
    try {
      const res = await fetch('/control/budget/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyUsd: n }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCapSaved(String(n));
      flash('ok', `daily cap set to $${n}`);
    } catch (e) {
      flash('err', 'save failed');
    } finally {
      setSavingCap(false);
    }
  }

  async function patchConfig(patch, label) {
    try {
      const res = await fetch('/control/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());
      flash('ok', `${label} updated`);
    } catch (e) {
      flash('err', `${label} save failed`);
    }
  }

  function onChangeBreach(v) {
    setOnBreach(v);
    patchConfig({ budget: { onBreach: v } }, 'on-breach');
  }

  function onChangeRouting(v) {
    setRoutingMode(v);
    patchConfig({ routing: { mode: v } }, 'routing mode');
  }

  const capDirty = cap !== capSaved;

  return (
    <section className="panel" data-screen-label="guardrails" style={{ padding: 20 }}>
      <header className="panel__hd" style={{ marginBottom: 16 }}>
        <div className="panel__hd-l">
          <span className="rp-eyebrow">COST GUARDRAILS</span>
          <h3 className="panel__h">Self-serve kill switch</h3>
        </div>
        {msg && (
          <div className="panel__hd-r" style={{ color: msg.kind === 'ok' ? '#28C840' : '#FF5F57', fontSize: 13 }}>
            {msg.text}
          </div>
        )}
      </header>

      <div style={{ display: 'grid', gap: 20, maxWidth: 560 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--rp-fg-mute)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Daily spend cap (USD)
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="number"
              min="0"
              step="1"
              value={cap}
              placeholder="e.g. 50"
              onChange={(e) => setCap(e.target.value)}
              style={{
                flex: 1,
                padding: '8px 12px',
                background: 'var(--rp-bg-1, #0f0f12)',
                border: '1px solid var(--rp-line, #2a2a30)',
                color: 'var(--rp-fg)',
                borderRadius: 4,
                fontSize: 14,
                fontFamily: 'inherit',
              }}
            />
            <button
              className="ghostbtn"
              onClick={saveCap}
              disabled={savingCap || !capDirty}
              style={{ opacity: capDirty ? 1 : 0.5 }}
            >
              {savingCap ? 'saving' : 'save'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--rp-fg-mute)', marginTop: 6 }}>
            Current: {capSaved ? `$${capSaved}/day` : 'no cap set'}
          </p>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--rp-fg-mute)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            On breach
          </label>
          <select
            value={onBreach}
            onChange={(e) => onChangeBreach(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'var(--rp-bg-1, #0f0f12)',
              border: '1px solid var(--rp-line, #2a2a30)',
              color: 'var(--rp-fg)',
              borderRadius: 4,
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          >
            {ON_BREACH.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ fontSize: 12, color: 'var(--rp-fg-mute)', marginTop: 6 }}>
            What the proxy does when daily cap is exceeded.
          </p>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--rp-fg-mute)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Routing mode
          </label>
          <select
            value={routingMode}
            onChange={(e) => onChangeRouting(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'var(--rp-bg-1, #0f0f12)',
              border: '1px solid var(--rp-line, #2a2a30)',
              color: 'var(--rp-fg)',
              borderRadius: 4,
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          >
            {ROUTING_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ fontSize: 12, color: 'var(--rp-fg-mute)', marginTop: 6 }}>
            How RelayPlane chooses which model handles each request.
          </p>
        </div>
      </div>
    </section>
  );
}
