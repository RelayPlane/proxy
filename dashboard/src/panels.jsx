import React from 'react';

// Component library for the RelayPlane local dashboard.
// Sections: provider strip, live request stream, token pool, sessions, learning callout.

// ---- Sparkline (tiny SVG, used in sessions + agents) ------------------------
export function Sparkline({ data, color, height = 18, width = 88, mode = "line" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 0.0001);
  const step = width / (data.length - 1 || 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`)
    .join(" ");
  const areaPoints = `0,${height} ${points} ${width},${height}`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {mode === "area" && <polygon points={areaPoints} fill={color} opacity="0.18" />}
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.25" />
    </svg>
  );
}

// ---- Provider strip ---------------------------------------------------------
function ProviderTile({ p }) {
  const stateClass = p.health === 0 ? "is-off" : p.health < 80 ? "is-warn" : "is-ok";
  const rpmPct = p.rpmCap > 0 ? (p.rpmUsed / p.rpmCap) * 100 : 0;
  return (
    <div className={`prov ${stateClass}` + (p.primary ? " is-primary" : "")}>
      <div className="prov__top">
        <div className="prov__id">
          <span className="prov__dot" />
          <span className="prov__name">{p.id}</span>
          {p.primary && <span className="prov__primary">primary</span>}
        </div>
        <span className="prov__health">{p.health}%</span>
      </div>
      <div className="prov__bar"><i style={{ width: p.health + "%" }} /></div>
      {p.health > 0 ? (
        <div className="prov__meta">
          <span><span className="k">share</span><b>{p.share.toFixed(1)}%</b></span>
          <span><span className="k">p95</span><b>{p.p95.trim()}</b></span>
          <span><span className="k">rpm</span><b>{p.rpmUsed}<span className="dim">/{p.rpmCap}</span></b></span>
        </div>
      ) : (
        <div className="prov__note">{p.note}</div>
      )}
      {p.note && p.health > 0 && <div className="prov__note prov__note--warn">{p.note}</div>}
    </div>
  );
}

export function ProviderStrip({ providers }) {
  const healthy = providers.filter(p => p.health >= 80).length;
  const configured = providers.filter(p => p.health > 0).length;
  return (
    <section className="panel" data-screen-label="providers">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">PROVIDERS</span>
          <h3 className="panel__h">{healthy} healthy of {configured} configured.</h3>
        </div>
        <div className="panel__hd-r">
          <span className="panel__hint">rolling 60s</span>
        </div>
      </header>
      <div className="prov-grid">
        {providers.map(p => <ProviderTile key={p.id} p={p} />)}
      </div>
    </section>
  );
}

// ---- Live request stream ----------------------------------------------------

// Run attribution chip. Clicking it writes the SPA's only route, `#run=<id>`,
// which App picks up on hashchange and opens in the runs tab.
export function RunChip({ runId, agentLabel }) {
  if (!runId) return null;
  const tail = String(runId).split('/').pop() || String(runId);
  const short = tail.length > 14 ? `${tail.slice(0, 13)}\u2026` : tail;
  return (
    <button
      className="runchip"
      title={`run ${runId}${agentLabel ? `, agent ${agentLabel}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        window.location.hash = `#run=${encodeURIComponent(runId)}`;
      }}
    >
      <span className="runchip__id">{short}</span>
      {agentLabel && <span className="runchip__agent">{agentLabel}</span>}
    </button>
  );
}

function ReqRow({ r }) {
  const statusClass = "req__status req__status--" + r.status;
  return (
    <div className={`req${r.from !== r.to && r.status === "ok" ? " req--rerouted" : ""}${r.cache > 0 ? " req--cache" : ""}`}>
      <span className="req__t">{r.t}</span>
      <span className={statusClass}>{r.status}</span>
      <span className="req__agent">{r.agent}</span>
      <span className="req__rule">{r.rule}</span>
      <span className="req__route">
        {r.from !== r.to ? (
          <>
            <span className="req__from">{r.from}</span>
            <span className="req__arrow">→</span>
            <span className="req__to">{r.to}</span>
          </>
        ) : (
          <span className="req__to">{r.to}</span>
        )}
      </span>
      <span className="req__prov">{r.provider}</span>
      <span className="req__tok"><b>{r.tokIn.toLocaleString()}</b><span className="dim">/{r.tokOut.toLocaleString()}</span></span>
      <span className="req__cost">${r.cost.toFixed(4)}</span>
      <span className="req__lat">{r.latMs}ms</span>
      <span className="req__reason">
        <RunChip runId={r.runId} agentLabel={r.agentLabel} />
        {r.reason}
      </span>
    </div>
  );
}

export function RequestStream({ rows, paused, onTogglePause, onClear, density }) {
  const bodyRef = React.useRef(null);
  const [follow, setFollow] = React.useState(true);
  const [filter, setFilter] = React.useState("all");

  React.useEffect(() => {
    if (!follow || !bodyRef.current) return;
    bodyRef.current.scrollTop = 0; // newest-on-top mode
  }, [rows, follow]);

  const filtered = React.useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "rerouted") return rows.filter(r => r.from !== r.to && r.status === "ok");
    if (filter === "cache") return rows.filter(r => r.cache > 0);
    if (filter === "deny") return rows.filter(r => r.status === "deny");
    if (filter === "warn") return rows.filter(r => r.status === "warn");
    return rows;
  }, [rows, filter]);

  return (
    <section className="panel panel--stream" data-screen-label="request-stream">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">REQUESTS · LIVE</span>
          <h3 className="panel__h">
            {rows.length.toLocaleString()} routed today. {paused ? "stream paused." : "streaming."}
          </h3>
        </div>
        <div className="panel__hd-r stream__ctrls">
          <div className="seg">
            {["all", "rerouted", "cache", "warn", "deny"].map(f => (
              <button key={f} className={"seg__b" + (filter === f ? " is-on" : "")} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
          <button className={"ghostbtn" + (follow ? " is-on" : "")} onClick={() => { setFollow(true); if (bodyRef.current) bodyRef.current.scrollTop = 0; }}>follow</button>
          <button className="ghostbtn" onClick={onTogglePause}>{paused ? "resume" : "pause"}</button>
          <button className="ghostbtn" onClick={onClear}>clear</button>
        </div>
      </header>
      <div className={"req__head" + (density === "compact" ? " is-compact" : "")}>
        <span>time</span>
        <span>status</span>
        <span>agent</span>
        <span>rule</span>
        <span>route</span>
        <span>provider</span>
        <span className="r">tokens in/out</span>
        <span className="r">cost</span>
        <span className="r">latency</span>
        <span>reason</span>
      </div>
      <div
        className={"req__body" + (density === "compact" ? " is-compact" : "")}
        ref={bodyRef}
        onScroll={(e) => setFollow(e.currentTarget.scrollTop < 24)}
      >
        {filtered.length === 0 ? (
          <div className="req__empty">NO REQUESTS MATCH FILTER · <code>{filter}</code></div>
        ) : (
          filtered.slice().reverse().map((r, i) => <ReqRow key={r.t + i} r={r} />)
        )}
      </div>
    </section>
  );
}

// ---- Token pool table -------------------------------------------------------
export function TokenPool({ rows }) {
  return (
    <section className="panel" data-screen-label="token-pool">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">TOKEN POOL</span>
          <h3 className="panel__h">{rows.filter(r => r.status === "available").length} of {rows.length} accounts available.</h3>
        </div>
        <div className="panel__hd-r">
          <button className="ghostbtn">+ add</button>
        </div>
      </header>
      <div className="pool">
        <div className="pool__head">
          <span>label</span>
          <span>src</span>
          <span className="r">prio</span>
          <span>type</span>
          <span>req/min</span>
          <span className="r">rpm cap</span>
          <span>status</span>
        </div>
        {rows.map(r => {
          const pct = r.rpmCap > 0 ? (r.rpm / r.rpmCap) * 100 : 0;
          const statusClass = "pool__status pool__status--" + r.status.replace(/[^a-z]/gi, "");
          return (
            <div className="pool__row" key={r.label}>
              <span className="pool__label" title={r.plan}>{r.label}</span>
              <span className={"pool__src pool__src--" + r.source}>{r.source}</span>
              <span className="r pool__prio">{r.priority}</span>
              <span className="pool__type">{r.type}</span>
              <span className="pool__rpm">
                <span className="pool__rpmbar"><i style={{ width: Math.min(100, pct) + "%" }} /></span>
                <b>{r.rpm}</b><span className="dim">/{r.rpmCap}</span>
              </span>
              <span className="r pool__cap">{r.rpmCap} rpm</span>
              <span className={statusClass}>{r.status}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- Sessions accordion -----------------------------------------------------
function SessionRow({ s, open, onToggle }) {
  return (
    <div className={"ses" + (open ? " is-open" : "")}>
      <button className="ses__hd" onClick={onToggle}>
        <span className="ses__chev">{open ? "▾" : "▸"}</span>
        <span className="ses__id">{s.id}</span>
        <span className="ses__agent">{s.agent}</span>
        <span className="ses__started">{s.started}</span>
        <span className="ses__dur">{s.dur}</span>
        <span className="ses__reqs"><b>{s.requests}</b><span className="dim"> req</span></span>
        <span className="ses__cost">${s.cost.toFixed(3)}</span>
        <span className="ses__sav">save ${s.savings.toFixed(2)}</span>
        <span className="ses__mix">
          {s.mix.map((m, i) => (
            <span key={m.model} className={"ses__mixchip ses__mixchip--" + (m.model.includes("opus") ? "opus" : m.model.includes("sonnet") ? "sonnet" : m.model.includes("haiku") ? "haiku" : "other")}>
              {m.model.replace("claude-", "").replace("gpt-", "")} <b>{m.pct}%</b>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="ses__body">
          <div className="ses__bar">
            {s.mix.map((m) => (
              <i key={m.model}
                 className={"ses__barseg ses__barseg--" + (m.model.includes("opus") ? "opus" : m.model.includes("sonnet") ? "sonnet" : m.model.includes("haiku") ? "haiku" : "other")}
                 style={{ width: m.pct + "%" }}
                 title={`${m.model} ${m.pct}%`} />
            ))}
          </div>
          <div className="ses__meta">
            <span><span className="k">cost / req</span><b>${(s.cost / s.requests).toFixed(4)}</b></span>
            <span><span className="k">save / req</span><b>${(s.savings / s.requests).toFixed(4)}</b></span>
            <span><span className="k">routing efficiency</span><b>{((s.savings / (s.cost + s.savings)) * 100).toFixed(1)}%</b></span>
            <span className="ses__metaspacer" />
            <button className="ghostbtn">replay</button>
            <button className="ghostbtn">export</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Sessions({ sessions }) {
  const [openId, setOpenId] = React.useState(sessions[0]?.id);
  return (
    <section className="panel" data-screen-label="sessions">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">SESSIONS · LAST 24H</span>
          <h3 className="panel__h">
            {sessions.length} sessions. ${sessions.reduce((a, s) => a + s.cost, 0).toFixed(2)} spent, ${sessions.reduce((a, s) => a + s.savings, 0).toFixed(2)} saved.
          </h3>
        </div>
        <div className="panel__hd-r">
          <span className="panel__hint">click row to expand</span>
        </div>
      </header>
      <div className="ses-list">
        <div className="ses__theadrow">
          <span></span>
          <span>session</span>
          <span>agent</span>
          <span>started</span>
          <span>duration</span>
          <span>requests</span>
          <span>cost</span>
          <span>savings</span>
          <span>model mix</span>
        </div>
        {sessions.map(s => (
          <SessionRow
            key={s.id}
            s={s}
            open={openId === s.id}
            onToggle={() => setOpenId(openId === s.id ? null : s.id)}
          />
        ))}
      </div>
    </section>
  );
}


// ============================================================================
// ByModel + ByAgent breakdown tables
// ============================================================================

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function shortModel(m) {
  if (!m) return '-';
  return m.replace(/^claude-/, '').replace(/^gpt-/, 'gpt-');
}

export function ByModelTable({ rows }) {
  const totalCost = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
  const totalCount = rows.reduce((s, r) => s + (r.count || 0), 0);
  const sorted = [...rows].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  return (
    <section className="panel" data-screen-label="by-model">
      <div className="panel__hd">
        <h3 className="panel__h">cost by model</h3>
        <span className="panel__meta">{totalCount.toLocaleString()} reqs · {fmtUsd(totalCost)} total</span>
      </div>
      {sorted.length === 0 ? (
        <div className="panel__empty" style={{ padding: '20px 16px', color: 'var(--rp-fg-mute)', fontSize: 13 }}>
          no requests yet in this window
        </div>
      ) : (
        <div className="panel__table">
          <div className="panel__row panel__row--hd" style={{ gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr' }}>
            <span>model</span>
            <span>provider</span>
            <span style={{ textAlign: 'right' }}>requests</span>
            <span style={{ textAlign: 'right' }}>cost</span>
            <span style={{ textAlign: 'right' }}>share</span>
          </div>
          {sorted.map((r) => {
            const share = totalCost > 0 ? (r.costUsd / totalCost) * 100 : 0;
            return (
              <div key={`${r.provider}/${r.model}`} className="panel__row" style={{ gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr' }}>
                <span className="mono">{shortModel(r.model)}</span>
                <span style={{ color: 'var(--rp-fg-mute)' }}>{r.provider || 'unknown'}</span>
                <span style={{ textAlign: 'right' }}>{r.count.toLocaleString()}</span>
                <span style={{ textAlign: 'right' }}>{fmtUsd(r.costUsd)}</span>
                <span style={{ textAlign: 'right', color: 'var(--rp-fg-mute)' }}>{share.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ByAgentTable({ rows }) {
  const totalCost = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
  const totalCount = rows.reduce((s, r) => s + (r.count || 0), 0);
  const sorted = [...rows].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  return (
    <section className="panel" data-screen-label="by-agent">
      <div className="panel__hd">
        <h3 className="panel__h">cost by agent</h3>
        <span className="panel__meta">{rows.length} agents · {totalCount.toLocaleString()} reqs · {fmtUsd(totalCost)} total</span>
      </div>
      {sorted.length === 0 ? (
        <div className="panel__empty" style={{ padding: '20px 16px', color: 'var(--rp-fg-mute)', fontSize: 13 }}>
          no agents detected yet. agent id is the Claude Code session header.
        </div>
      ) : (
        <div className="panel__table">
          <div className="panel__row panel__row--hd" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr' }}>
            <span>agent</span>
            <span style={{ textAlign: 'right' }}>requests</span>
            <span style={{ textAlign: 'right' }}>cost</span>
            <span style={{ textAlign: 'right' }}>share</span>
            <span style={{ textAlign: 'right' }}>last seen</span>
          </div>
          {sorted.map((r) => {
            const share = totalCost > 0 ? (r.costUsd / totalCost) * 100 : 0;
            const isUnattributed = r.agentId === 'unattributed';
            const label = isUnattributed ? 'unattributed' : r.agentId.slice(0, 12);
            return (
              <div key={r.agentId} className="panel__row" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr' }}>
                <span className="mono" style={{ color: isUnattributed ? 'var(--rp-fg-mute)' : 'var(--rp-fg-1)' }}>{label}</span>
                <span style={{ textAlign: 'right' }}>{r.count.toLocaleString()}</span>
                <span style={{ textAlign: 'right' }}>{fmtUsd(r.costUsd)}</span>
                <span style={{ textAlign: 'right', color: 'var(--rp-fg-mute)' }}>{share.toFixed(0)}%</span>
                <span style={{ textAlign: 'right', color: 'var(--rp-fg-mute)', fontSize: 12 }}>{fmtAgo(r.lastSeen)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
