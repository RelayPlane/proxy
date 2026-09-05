import React from 'react';

// Cost guardrails: daily cap, on-breach action, routing mode.
// Backend endpoints:
//   GET  /control/budget         -> { limit_usd, on_breach, ... }
//   POST /control/budget/set     -> { dailyUsd }
//   GET  /v1/config              -> { routing: { mode }, budget: { onBreach }, attribution: {...} }
//   POST /control/config         -> merge patch (deep, so nested blocks like
//                                   attribution.alerts merge rather than replace)
//
// Run attribution defaults mirror DEFAULT_ATTRIBUTION_CONFIG in run-attribution.ts.
// /v1/config serves the raw config file, so the attribution block can be absent
// on a fresh install; fall back to these rather than rendering empty inputs.

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

export const ATTRIBUTION_DEFAULTS = {
  idleCloseSeconds: 600,
  defaultRunCapUsd: null,
  runCapAction: 'block',
  runCostUsd: null,
  webhookUrl: '',
  overBand: true,
  modelDrift: true,
};

const ATTRIBUTION_ERRORS = {
  invalid_idle_close: 'idle close must be at least 30 seconds',
  invalid_cap: 'caps must be a positive number, or empty for none',
  invalid_cap_action: 'cap action must be block or warn',
  invalid_webhook: 'webhook must be an http or https url',
};

const RUN_CAP_ACTIONS = [
  { value: 'block', label: 'block (reject once the run is over its cap)' },
  { value: 'warn', label: 'warn (allow, record a run alert)' },
];

// Client-side pre-PATCH validation for the attribution payload. Same shape as
// validateGuardrailsPayload above: never let bad input reach /control/config.
// Caps and the cost alert are "a positive number, or null for none".
export function validateAttributionPayload(payload) {
  const { idleCloseSeconds, defaultRunCapUsd, runCapAction, runCostUsd, webhookUrl } = payload || {};

  if (typeof idleCloseSeconds !== 'number' || !Number.isFinite(idleCloseSeconds) || idleCloseSeconds < 30) {
    return { ok: false, error: 'invalid_idle_close' };
  }
  for (const cap of [defaultRunCapUsd, runCostUsd]) {
    if (cap === null || cap === undefined) continue;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      return { ok: false, error: 'invalid_cap' };
    }
  }
  if (runCapAction !== undefined && runCapAction !== 'block' && runCapAction !== 'warn') {
    return { ok: false, error: 'invalid_cap_action' };
  }
  if (webhookUrl !== undefined && webhookUrl !== null && webhookUrl !== '') {
    if (typeof webhookUrl !== 'string' || !/^https?:\/\/\S+$/.test(webhookUrl)) {
      return { ok: false, error: 'invalid_webhook' };
    }
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
  const [attr, setAttr] = React.useState(ATTRIBUTION_DEFAULTS);
  const [savingAttr, setSavingAttr] = React.useState(false);

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
        const a = configRes?.attribution;
        if (a) {
          setAttr({
            idleCloseSeconds: Number(a.idleCloseSeconds) > 0 ? Number(a.idleCloseSeconds) : ATTRIBUTION_DEFAULTS.idleCloseSeconds,
            defaultRunCapUsd: a.defaultRunCapUsd == null ? null : Number(a.defaultRunCapUsd),
            runCapAction: a.runCapAction === 'warn' ? 'warn' : 'block',
            runCostUsd: a.alerts?.runCostUsd == null ? null : Number(a.alerts.runCostUsd),
            webhookUrl: a.alerts?.webhookUrl || '',
            overBand: a.alerts?.overBand !== false,
            modelDrift: a.alerts?.modelDrift !== false,
          });
        }
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

  function setAttrField(key, value) {
    setAttr(prev => ({ ...prev, [key]: value }));
  }

  // Toggles write straight through (optimistic, same as the selects above);
  // the numeric and text fields batch behind Save so half-typed URLs and caps
  // never hit the config file.
  async function saveAttribution(overrides) {
    const next = { ...attr, ...(overrides || {}) };
    const check = validateAttributionPayload(next);
    if (!check.ok) {
      flash('err', ATTRIBUTION_ERRORS[check.error] || check.error);
      return;
    }
    setSavingAttr(true);
    try {
      await patchConfig({
        attribution: {
          idleCloseSeconds: next.idleCloseSeconds,
          defaultRunCapUsd: next.defaultRunCapUsd,
          runCapAction: next.runCapAction,
          alerts: {
            runCostUsd: next.runCostUsd,
            webhookUrl: next.webhookUrl === '' ? null : next.webhookUrl,
            overBand: next.overBand,
            modelDrift: next.modelDrift,
          },
        },
      }, 'attribution');
    } finally {
      setSavingAttr(false);
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
    <>
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

    <section className="panel gattr" data-screen-label="attribution" style={{ marginTop: 12 }}>
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">ATTRIBUTION</span>
          <h3 className="panel__h">What counts as a run, and when it shouts</h3>
        </div>
        <div className="panel__hd-r">
          <span className="panel__hint">runs.db · per run, not global</span>
        </div>
      </header>

      <div className="gattr__grid">
        <label className="gattr__field">
          <span className="gattr__k">idle close seconds</span>
          <input
            className="gattr__in"
            type="number"
            min="30"
            step="30"
            value={attr.idleCloseSeconds}
            onChange={(e) => setAttrField('idleCloseSeconds', Number(e.target.value))}
          />
          <span className="gattr__hint">a run with no request for this long is closed and rolled up. minimum 30s.</span>
        </label>

        <label className="gattr__field">
          <span className="gattr__k">default run cap (USD)</span>
          <input
            className="gattr__in"
            type="number"
            min="0"
            step="0.5"
            placeholder="none"
            value={attr.defaultRunCapUsd == null ? '' : attr.defaultRunCapUsd}
            onChange={(e) => setAttrField('defaultRunCapUsd', e.target.value === '' ? null : Number(e.target.value))}
          />
          <span className="gattr__hint">applied to every run that does not carry its own cap. empty for none.</span>
        </label>

        <label className="gattr__field">
          <span className="gattr__k">run cap action</span>
          <select
            className="gattr__in"
            value={attr.runCapAction}
            onChange={(e) => setAttrField('runCapAction', e.target.value)}
          >
            {RUN_CAP_ACTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="gattr__hint">what the proxy does to the next request once a run is over its cap.</span>
        </label>

        <label className="gattr__field">
          <span className="gattr__k">run cost alert (USD)</span>
          <input
            className="gattr__in"
            type="number"
            min="0"
            step="0.5"
            placeholder="none"
            value={attr.runCostUsd == null ? '' : attr.runCostUsd}
            onChange={(e) => setAttrField('runCostUsd', e.target.value === '' ? null : Number(e.target.value))}
          />
          <span className="gattr__hint">fires a run alert at this spend. does not block anything. empty for none.</span>
        </label>

        <label className="gattr__field gattr__field--wide">
          <span className="gattr__k">webhook URL</span>
          <input
            className="gattr__in"
            type="text"
            placeholder="https://hooks.example.com/relayplane"
            value={attr.webhookUrl}
            onChange={(e) => setAttrField('webhookUrl', e.target.value)}
          />
          <span className="gattr__hint">one JSON POST per run alert, 5s timeout, no retry. also mirrored into the alert manager.</span>
        </label>
      </div>

      <div className="gattr__toggles">
        <button
          className={'gattr__toggle' + (attr.overBand ? ' is-on' : '')}
          onClick={() => { const v = !attr.overBand; setAttrField('overBand', v); saveAttribution({ overBand: v }); }}
          title="alert when a run costs more than the expected band for its label"
        >
          <span className="gattr__sw" />over band
        </button>
        <button
          className={'gattr__toggle' + (attr.modelDrift ? ' is-on' : '')}
          onClick={() => { const v = !attr.modelDrift; setAttrField('modelDrift', v); saveAttribution({ modelDrift: v }); }}
          title="alert when an agent's dominant model changes between runs of the same label"
        >
          <span className="gattr__sw" />model drift
        </button>
        <span className="gattr__spacer" />
        <button className="ghostbtn" disabled={savingAttr} onClick={() => saveAttribution()}>
          {savingAttr ? 'saving' : 'save attribution'}
        </button>
      </div>
    </section>
    </>
  );
}
