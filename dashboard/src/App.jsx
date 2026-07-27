import React from 'react';
import wordmarkUrl from './assets/relayplane-wordmark.svg';
import { RP_TOKEN_POOL } from './fixtures';
import {
  useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSlider, TweakToggle,
} from './tweaks-panel';
import { ProviderStrip, RequestStream, TokenPool, Sessions, ByModelTable, ByAgentTable } from './panels';
import { useLiveToday } from './useLiveToday';
import { useLiveBreakdown } from './useLiveBreakdown';
import { useLiveRequests } from './useLiveRequests';
import { useLiveSessions } from './useLiveSessions';
import { useLiveStatus } from './useLiveStatus';
import { useLiveSpendCurve } from './useLiveSpendCurve';
import { useLiveProviders } from './useLiveProviders.js';
import { Guardrails } from './Guardrails';
import { useTier } from './useTier';

// Tabs exposed by the dashboard header. Only `overview` is wired today; the
// rest render a placeholder until their data layer lands.
const TABS = ['overview', 'requests', 'routing', 'tokens', 'sessions', 'policies', 'audit', 'config'];

function ComingSoon({ tabName }) {
  return (
    <section className="panel" data-screen-label={`tab-${tabName}-coming-soon`} style={{ padding: '48px 24px', textAlign: 'center' }}>
      <div className="rp-eyebrow" style={{ marginBottom: 8 }}>{tabName.toUpperCase()}</div>
      <h3 className="panel__h" style={{ marginBottom: 8 }}>Coming soon</h3>
      <p style={{ color: 'var(--rp-fg-mute)', maxWidth: 480, margin: '0 auto' }}>
        The {tabName} view is in progress. Until it ships, overview holds the canonical metrics.
      </p>
    </section>
  );
}

// RelayPlane local dashboard , top-level layout and hero modules.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "regular",
  "tickRate": 1400,
  "streamCap": 200,
  "showProjection": true
}/*EDITMODE-END*/;

// ============================================================================
// Header: chrome bar + brand bar with kill-switch on the right.
// ============================================================================

function DashHeader({ uptimeLabel, version, plan, killArmed, onArmKill, onUnarmKill, days, onDaysChange, activeTab, onTabChange }) {
  return (
    <header className="dh">
      <div className="dh__chrome">
        <div className="dh__lights">
          <span style={{ background: "#FF5F57" }} />
          <span style={{ background: "#FEBC2E" }} />
          <span style={{ background: "#28C840" }} />
        </div>
        <div className="dh__url">
          <span className="dh__lock">●</span>
          localhost:4100
          <span className="dh__urlsep">/</span>
          <span className="dh__urlpath">dashboard</span>
        </div>
        <div className="dh__chrome-right">
          <span className="dh__chip">
            <span className="dh__chip-dot" />
            proxy active
          </span>
          <span className="dh__sep">·</span>
          <span className="dh__muted">v{version}</span>
          <span className="dh__sep">·</span>
          <span className={"dh__plan dh__plan--" + (plan || 'free')} title="current plan">{(plan || 'free').toUpperCase()}</span>
          <span className="dh__sep">·</span>
          <span className="dh__muted">up {uptimeLabel}</span>
          <span className="dh__sep">·</span>
          <span className="dh__muted">refresh 5s</span>
        </div>
      </div>

      <div className="dh__bar">
        <div className="dh__brand">
          <img src={wordmarkUrl} alt="relayplane" className="dh__logo" />
          <span className="dh__sub">right task, right model, right rate.</span>
        </div>
        <nav className="dh__tabs">
          {TABS.map(name => (
            <button
              key={name}
              className={"dh__tab" + (activeTab === name ? " is-active" : "")}
              onClick={() => onTabChange?.(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="dh__actions">
          <div className="dh__tf" role="group" aria-label="timeframe">
            {[1, 7, 30].map(d => (
              <button
                key={d}
                className={"dh__tfpill" + (days === d ? " is-active" : "")}
                onClick={() => onDaysChange?.(d)}
              >
                {d === 1 ? "today" : d + "d"}
              </button>
            ))}
          </div>
          <a className="ghostbtn" href="https://relayplane.com/docs" target="_blank" rel="noreferrer">docs</a>
          <a className="ghostbtn" href="https://relayplane.com/docs/cli" target="_blank" rel="noreferrer">cli</a>
          <KillButton armed={killArmed} onArm={onArmKill} onUnarm={onUnarmKill} />
        </div>
      </div>
    </header>
  );
}

function KillButton({ armed, onArm, onUnarm }) {
  if (!armed) {
    return (
      <button className="killbtn" onClick={onArm} title="halt all routed traffic, response under 1s">
        <span className="killbtn__icon">■</span>
        <span className="killbtn__label">kill</span>
      </button>
    );
  }
  return (
    <div className="killbtn killbtn--armed">
      <span className="killbtn__icon">■</span>
      <span className="killbtn__label">halted</span>
      <button className="killbtn__undo" onClick={onUnarm}>resume</button>
    </div>
  );
}

// ============================================================================
// Hero stats row , 4 tiles.
// ============================================================================

function HeroStat({ eyebrow, value, unit, sub, delta, deltaDir, accent, footer, children }) {
  return (
    <div className={"hstat" + (accent ? " hstat--accent" : "")}>
      <div className="hstat__hd">
        <span className="rp-eyebrow">{eyebrow}</span>
        {delta != null && (
          <span className={"hstat__delta hstat__delta--" + (deltaDir || "up")}>
            {deltaDir === "down" ? "↘" : "↗"} {delta > 0 ? "+" : ""}{delta}%
          </span>
        )}
      </div>
      <div className="hstat__num">
        {unit && unit.startsWith("$") && <span className="hstat__cur">$</span>}
        <span className="hstat__val">{value}</span>
        {unit && !unit.startsWith("$") && <span className="hstat__unit">{unit}</span>}
      </div>
      {sub && <div className="hstat__sub">{sub}</div>}
      {children}
      {footer && <div className="hstat__footer">{footer}</div>}
    </div>
  );
}

function HeroStats({ today }) {
  return (
    <section className="hero-stats" data-screen-label="hero-stats">
      <HeroStat
        eyebrow="REQUESTS · TODAY"
        value={today.requests.toLocaleString()}
        delta={today.requestsDelta}
        deltaDir="up"
        sub="vs yesterday"
        footer={<span><b>{today.cacheHitRate.toFixed(1)}%</b> cache hit rate</span>}
      />
      <HeroStat
        eyebrow="COST · TODAY"
        value={today.cost.toFixed(2)}
        unit="$"
        delta={today.costDelta}
        deltaDir="down"
        sub="vs yesterday"
        footer={<span><b>${(today.budget - today.cost).toFixed(2)}</b> of {`$${today.budget.toFixed(0)}`} plan remaining</span>}
      />
      <HeroStat
        eyebrow="ROUTING SAVINGS · TODAY"
        value={today.savings.toFixed(2)}
        unit="$"
        accent
        sub={`${today.savingsPct.toFixed(0)}% cheaper than all-opus baseline`}
        footer={<span>verified per request at provider price</span>}
      />
      <HeroStat
        eyebrow="LATENCY · AVG"
        value={today.latencyAvg.toFixed(2)}
        unit="s"
        sub={`p95 ${today.latencyP95.toFixed(2)}s`}
        footer={<span>across {today.requests.toLocaleString()} requests</span>}
      />
    </section>
  );
}

// ============================================================================
// Budget meter , large, with today's spend curve + projection.
// ============================================================================

function BudgetMeter({ today, spendCurve, nowHr, tickRate, showProjection }) {
  const spent = today.cost;
  const budget = today.budget || 0;
  const remaining = Math.max(0, budget - spent);
  const pct = budget > 0 ? (spent / budget) * 100 : 0;
  const hoursLeft = today.burn > 0 ? remaining / today.burn : 99;
  const emptyAt = new Date(Date.now() + hoursLeft * 3600 * 1000);
  const emptyLabel = emptyAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const nowLabel = `${String(nowHr).padStart(2, '0')}:00`;
  const resetsInDays = (() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Math.max(0, Math.ceil((next - now) / 86400000));
  })();

  // Color shifts as spend approaches budget.
  const accent = pct < 50 ? "var(--rp-signal-relay)" : pct < 80 ? "var(--rp-signal-spend)" : "var(--rp-signal-stop)";

  // Chart math
  const W = 560, H = 96, pad = 8;
  const max = Math.max(...spendCurve, 1);
  const step = (W - pad * 2) / (spendCurve.length - 1);
  const actual = spendCurve.slice(0, nowHr + 1);
  const projected = spendCurve.slice(nowHr);
  const toPts = (arr, offset = 0) => arr
    .map((v, i) => `${(pad + (i + offset) * step).toFixed(1)},${(H - pad - (v / max) * (H - pad * 2)).toFixed(1)}`)
    .join(" ");
  const actualPts = toPts(actual);
  const projPts   = toPts(projected, nowHr);
  const areaPts   = `${pad},${H - pad} ${actualPts} ${(pad + nowHr * step).toFixed(1)},${H - pad}`;

  return (
    <section className="budget" data-screen-label="budget-meter" style={{ "--accent": accent }}>
      <div className="budget__l">
        <div className="budget__hd">
          <span className="rp-eyebrow">BUDGET</span>
          <span className="budget__plan">${budget.toFixed(0)} / month · resets in {resetsInDays} days</span>
        </div>
        <div className="budget__bignum">
          <span className="budget__cur">$</span>
          <span className="budget__val">{spent.toFixed(2)}</span>
          <span className="budget__of">of ${budget.toFixed(0)}</span>
        </div>
        <div className="budget__bar">
          <div className="budget__bar-track">
            <i className="budget__bar-fill" style={{ width: pct + "%" }} />
            <i className="budget__bar-marker" style={{ left: "50%" }} title="50%" />
            <i className="budget__bar-marker" style={{ left: "80%" }} title="80%" />
          </div>
          <div className="budget__bar-meta">
            <span><b>{pct.toFixed(1)}%</b> spent</span>
            <span><b>${remaining.toFixed(2)}</b> remaining</span>
          </div>
        </div>
        <div className="budget__sentences">
          <p className="budget__lead">
            burning <b>${today.burn.toFixed(2)}/hr</b>. at this rate, budget runs out <b>{emptyLabel}</b>.
          </p>
          <p className="budget__sub">
            without relayplane routing, today's traffic on all-opus would have spent <b>${(today.cost + today.savings).toFixed(2)}</b>. you saved <b className="rp-accent">${today.savings.toFixed(2)}</b>.
          </p>
        </div>
      </div>
      <div className="budget__r">
        <div className="budget__chart-hd">
          <span className="rp-eyebrow">SPEND CURVE · TODAY</span>
          <div className="budget__legend">
            <span className="lgnd lgnd--actual">actual</span>
            {showProjection && <span className="lgnd lgnd--proj">projected</span>}
            <span className="lgnd lgnd--cap">${budget.toFixed(0)} cap</span>
          </div>
        </div>
        <svg className="budget__chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {/* y-grid */}
          {[0.25, 0.5, 0.75].map(g => (
            <line key={g} x1={pad} x2={W - pad} y1={H - pad - g * (H - pad * 2)} y2={H - pad - g * (H - pad * 2)}
                  stroke="var(--rp-border-soft)" strokeDasharray="2 3" />
          ))}
          <polygon points={areaPts} fill={accent} opacity="0.10" />
          <polyline points={actualPts} fill="none" stroke={accent} strokeWidth="1.5" />
          {showProjection && (
            <polyline points={projPts} fill="none" stroke="var(--rp-fg-mute)" strokeWidth="1.25" strokeDasharray="3 3" />
          )}
          {/* now marker */}
          <line x1={pad + nowHr * step} x2={pad + nowHr * step} y1={pad} y2={H - pad}
                stroke="var(--rp-fg-1)" strokeWidth="0.75" strokeDasharray="1 2" opacity="0.5" />
          <circle cx={pad + nowHr * step} cy={H - pad - (spendCurve[nowHr] / max) * (H - pad * 2)} r="3" fill={accent} stroke="var(--rp-bg-card)" strokeWidth="1.5" />
        </svg>
        <div className="budget__xaxis">
          <span>00:00</span><span>06:00</span><span>12:00</span><span className="budget__now">{nowLabel} ◂ now</span><span>18:00</span><span>23:59</span>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Network learning callout , sits alongside the budget meter.
// ============================================================================

function NetworkCallout({ learning }) {
  return (
    <section className="learn" data-screen-label="network-learning">
      <div className="learn__hd">
        <span className="rp-eyebrow rp-eyebrow--accent">ROUTING IMPROVED BY NETWORK</span>
        <span className="learn__age">{learning.lastApplied}</span>
      </div>
      <div className="learn__big">
        <span className="learn__num">+{learning.matchRateDelta}%</span>
        <span className="learn__sublabel">match rate this week</span>
      </div>
      <p className="learn__body">
        <code>{learning.patternsFile}</code> updated to v{learning.version} from network consensus. your <code>rp:smart</code> and <code>rp:cheap</code> defaults rebalanced.
      </p>
      <div className="learn__changes">
        {learning.changes.map((c, i) => (
          <div className="lchange" key={i}>
            <span className="lchange__rule">{c.rule}</span>
            <span className="lchange__from">{c.from}</span>
            <span className="lchange__arrow">→</span>
            <span className="lchange__to">{c.to}</span>
            <span className="lchange__why">{c.reason}</span>
          </div>
        ))}
      </div>
      <div className="learn__files">
        <span className="rp-eyebrow">KNOWLEDGE</span>
        {learning.files.map(f => (
          <span className="lfile" key={f.name}>
            <span className="lfile__name">{f.name}</span>
            <span className="lfile__count">{f.count}</span>
          </span>
        ))}
      </div>
      <div className="learn__actions">
        <button className="ghostbtn">view diff</button>
        <button className="ghostbtn">revert</button>
        <button className="ghostbtn">opt out</button>
      </div>
    </section>
  );
}

// ============================================================================
// App
// ============================================================================

export function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [paused, setPaused] = React.useState(false);
  const [killArmed, setKillArmed] = React.useState(false);
  const [clearStamp, setClearStamp] = React.useState('');
  const [frozen, setFrozen] = React.useState(null);
  const [days, setDays] = React.useState(() => {
    const v = parseInt(localStorage.getItem('rp_tf') || '1', 10);
    return [1, 7, 30].includes(v) ? v : 1;
  });
  const handleDaysChange = (d) => {
    setDays(d);
    try { localStorage.setItem('rp_tf', String(d)); } catch {}
  };
  const [activeTab, setActiveTab] = React.useState('overview');
  const today = useLiveToday(5000, days);
  const liveReqs = useLiveRequests({ intervalMs: Math.max(1000, t.tickRate), limit: Math.max(50, t.streamCap), days });
  const liveSessions = useLiveSessions({ intervalMs: 5000, limit: 20, days });
  const status = useLiveStatus();
  const tier = useTier();
  const { curve: spendCurve, nowHr } = useLiveSpendCurve(30000, days);
  const { providers: liveProviders } = useLiveProviders({ intervalMs: 10000, days });
  const breakdown = useLiveBreakdown({ intervalMs: 10000, days });

  const reqs = React.useMemo(() => {
    if (paused || killArmed) return frozen ?? [];
    const filtered = clearStamp ? liveReqs.filter(r => r.t > clearStamp) : liveReqs;
    return filtered.slice(-t.streamCap);
  }, [liveReqs, paused, killArmed, clearStamp, t.streamCap, frozen]);

  const handleTogglePause = () => {
    setPaused(p => {
      const next = !p;
      setFrozen(next ? reqs : null);
      return next;
    });
  };
  const handleClear = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    setClearStamp(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}`);
    setFrozen([]);
  };

  return (
    <div className="dash" data-density={t.density} data-killed={killArmed ? "1" : "0"}>
      <DashHeader
        uptimeLabel={status.uptimeLabel}
        version={status.version}
        plan={tier}
        killArmed={killArmed}
        onArmKill={() => setKillArmed(true)}
        onUnarmKill={() => setKillArmed(false)}
        days={days}
        onDaysChange={handleDaysChange}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {killArmed && (
        <div className="killband">
          <span className="killband__icon">■</span>
          <b>traffic halted.</b> 0 routed since 14:32:14. issue <code>DELETE /v1/tenants/*/kill</code> resolved in 0.71s.
          <button className="ghostbtn killband__btn" onClick={() => setKillArmed(false)}>resume routing</button>
        </div>
      )}

      <main className="body">
        {activeTab === 'overview' ? (
          <>
            <HeroStats today={today} />

            <section className="row row--full">
              <BudgetMeter
                today={today}
                spendCurve={spendCurve}
                nowHr={nowHr}
                tickRate={t.tickRate}
                showProjection={t.showProjection}
              />
            </section>

            <ProviderStrip providers={liveProviders} />

            <section className="row row--2-asym">
              <RequestStream
                rows={reqs}
                paused={paused}
                onTogglePause={handleTogglePause}
                onClear={handleClear}
                density={t.density}
              />
              <TokenPool rows={RP_TOKEN_POOL} />
            </section>

            <section className="row row--2">
              <ByModelTable rows={breakdown.byModel} />
              <ByAgentTable rows={breakdown.byAgent} />
            </section>

            <Sessions sessions={liveSessions} />
          </>
        ) : activeTab === 'config' ? (
          <Guardrails />
        ) : (
          <ComingSoon tabName={activeTab} />
        )}

        <footer className="footer">
          <span className="footer__lock">●</span>
          <span>request bodies stay local. nothing leaves this machine.</span>
          <span className="footer__sep">·</span>
          <span>relayplane v{status.version || '…'}</span>
          <span className="footer__sep">·</span>
          <code>github.com/RelayPlane/proxy</code>
          <span className="footer__sep">·</span>
          <code>$ relayplane status</code>
          <span className="footer__sep">·</span>
          <span className="footer__r">MIT licensed.</span>
        </footer>
      </main>

      <TweaksPanel>
        <TweakSection label="Density" />
        <TweakRadio label="Stream rows" value={t.density} options={["compact", "regular", "comfy"]}
                    onChange={v => setTweak("density", v)} />
        <TweakSection label="Live stream" />
        <TweakSlider label="Tick rate" value={t.tickRate} min={400} max={4000} step={100} unit="ms"
                    onChange={v => setTweak("tickRate", v)} />
        <TweakSlider label="Buffer" value={t.streamCap} min={50} max={500} step={50} unit=" rows"
                    onChange={v => setTweak("streamCap", v)} />
        <TweakSection label="Budget" />
        <TweakToggle label="Show projection" value={t.showProjection}
                    onChange={v => setTweak("showProjection", v)} />
      </TweaksPanel>
    </div>
  );
}

