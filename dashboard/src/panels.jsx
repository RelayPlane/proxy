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

// Collapses to one quiet line while every configured provider is healthy,
// so a good day does not spend a whole panel's worth of vertical space
// telling you nothing is wrong. Unhealthy or empty always expands.
export function ProviderStrip({ providers }) {
  const configured = providers.filter(p => p.health > 0).length;
  const healthy = providers.filter(p => p.health >= 80).length;
  const allHealthy = configured > 0 && healthy === configured;
  const [expanded, setExpanded] = React.useState(false);

  if (configured === 0) {
    return (
      <section className="panel panel--providers-empty" data-screen-label="providers">
        <header className="panel__hd">
          <div className="panel__hd-l">
            <span className="rp-eyebrow">PROVIDERS</span>
            <h3 className="panel__h">No providers configured yet.</h3>
          </div>
        </header>
        <p className="prov__addhint">Add one to <code>~/.relayplane/config.json</code> to start routing traffic.</p>
      </section>
    );
  }

  if (allHealthy && !expanded) {
    return (
      <button className="provline" data-screen-label="providers" onClick={() => setExpanded(true)}>
        <span className="provline__dot" />
        <span className="provline__lead">all {configured} provider{configured === 1 ? '' : 's'} healthy</span>
        <span className="provline__go">expand ▾</span>
      </button>
    );
  }

  return (
    <section className="panel" data-screen-label="providers">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">PROVIDERS</span>
          <h3 className="panel__h">{healthy} healthy of {configured} configured.</h3>
        </div>
        <div className="panel__hd-r">
          <span className="panel__hint">rolling 60s</span>
          {allHealthy && <button className="ghostbtn" onClick={() => setExpanded(false)}>collapse</button>}
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
  if (rows.length === 0) {
    return (
      <section className="panel" data-screen-label="token-pool">
        <header className="panel__hd">
          <div className="panel__hd-l">
            <span className="rp-eyebrow">TOKEN POOL</span>
            <h3 className="panel__h">No accounts pooled yet.</h3>
          </div>
          <div className="panel__hd-r">
            <button className="ghostbtn">+ add</button>
          </div>
        </header>
        <p className="prov__addhint">A single account works fine. Pool more than one for failover and higher combined rpm.</p>
      </section>
    );
  }
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

