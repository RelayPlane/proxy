import React from 'react';
import wordmarkUrl from './assets/relayplane-wordmark.svg';
import { RP_TOKEN_POOL } from './fixtures';
import {
  useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSlider, TweakToggle,
} from './tweaks-panel';
import { ProviderStrip, RequestStream, TokenPool } from './panels';
import { useLiveToday } from './useLiveToday';
import { useLiveRequests } from './useLiveRequests';
import { useLiveStatus } from './useLiveStatus';
import { useLiveSpendCurve } from './useLiveSpendCurve';
import { useLiveProviders } from './useLiveProviders.js';
import { Guardrails } from './Guardrails';
import { useTier } from './useTier';
import { Runs } from './Runs';
import { RunDetail } from './RunDetail';
import { RunsCenterpiece } from './RunsCenterpiece';
import { useLiveRuns } from './useLiveRuns';
import { useRunAlerts } from './useRunAlerts';

// Tabs exposed by the dashboard header. `overview`, `runs`, `requests` and
// `config` are wired; `routing` and `policies` render a placeholder until
// their data layer lands. `sessions` folded into `runs`, `tokens` and
// `audit` were never real tabs, dropped rather than left as dead links.
const TABS = ['overview', 'runs', 'requests', 'routing', 'policies', 'config'];

// Deep link contract: `#run=<id>` opens the runs tab on that run. The CLI
// prints this URL at run start and the request stream's run chip writes it.
const RUN_HASH = /^#run=(.+)$/;

export function parseRunHash(hash) {
  const raw = typeof hash === 'string' ? hash : (typeof window === 'undefined' ? '' : window.location.hash);
  const m = RUN_HASH.exec(raw || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// A run alert only earns the strip while it is fresh; ten minutes is the
// window where you can still do something about it.
const RUN_ALERT_MAX_AGE_MS = 10 * 60 * 1000;

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

// The fourth line under the tiles: what is burning right now, per run, with a
// jump into the ledger. Live runs are the only number here that can change
// between two blinks, so it gets its own rule rather than a fifth tile.
function RunsInFlight({ runs, onOpen }) {
  const inFlight = runs.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
  const burn = runs.reduce((a, r) => a + (Number(r.cost_per_minute) || 0), 0);
  const waves = runs.filter(r => r.rate_limit_wave).length;
  return (
    <button className={'runsline' + (runs.length > 0 ? ' is-live' : '')} onClick={onOpen} title="open the runs ledger">
      <span className="runsline__dot" />
      <span className="runsline__lead">
        <b>{runs.length}</b> {runs.length === 1 ? 'run' : 'runs'} active, <b>${inFlight.toFixed(2)}</b> in flight
      </span>
      {burn > 0 && <span className="runsline__burn">${burn.toFixed(2)}/min combined burn</span>}
      {waves > 0 && <span className="runpill runpill--wave">{waves} in a 429 wave</span>}
      <span className="runsline__go">open runs ▸</span>
    </button>
  );
}

// Honest by construction: the number is small and sourced, and "show the
// math" expands the actual per-request comparison in place rather than
// asserting a headline percentage the reader has to take on faith. This
// replaces the old "$12,721.61 · 94% cheaper than all-opus" hero tile,
// which compared every call to a baseline nobody would run and contradicted
// the $0.00 the same page showed elsewhere.
function SavingsStat({ today }) {
  const [showMath, setShowMath] = React.useState(false);
  const baselineTotal = today.cost + today.savings;
  return (
    <HeroStat
      eyebrow="ROUTING SAVINGS · TODAY"
      value={today.savings.toFixed(2)}
      unit="$"
      accent
      sub={`vs the same ${today.requests.toLocaleString()} calls on the fleet default model`}
      footer={<span>{today.savingsPct.toFixed(1)}% lower · <button className="hstat__mathbtn" onClick={() => setShowMath(v => !v)}>{showMath ? 'hide the math' : 'show the math'}</button></span>}
    >
      {showMath && (
        <div className="hstat__math">
          <div>fleet default, all {today.requests.toLocaleString()} calls: <b>${baselineTotal.toFixed(2)}</b></div>
          <div>actual routed spend: <b>${today.cost.toFixed(2)}</b></div>
          <div>difference, priced per request at provider rates: <b>${today.savings.toFixed(2)}</b></div>
        </div>
      )}
    </HeroStat>
  );
}

// SPEND tile , the design's lead number. Green while there is headroom, amber
// past 80% of the cap, red once the cap is crossed, with an inline progress bar
// and the "$X of $Y remaining · Z% spent" line underneath.
function SpendTile({ today }) {
  const budget = Number(today.budget) || 0;
  const spent = Number(today.cost) || 0;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const over = budget > 0 && spent >= budget;
  const tone = budget <= 0 ? 'relay' : over ? 'stop' : pct >= 80 ? 'spend' : 'relay';
  const remaining = Math.max(0, budget - spent);
  return (
    <div className={'hstat hstat--tone-' + tone}>
      <div className="hstat__hd"><span className="rp-eyebrow">SPEND · TODAY</span></div>
      <div className="hstat__num">
        <span className="hstat__cur">$</span>
        <span className="hstat__val">{spent.toFixed(2)}</span>
      </div>
      <div className="hstat__bar"><i style={{ width: pct.toFixed(1) + '%' }} /></div>
      <div className="hstat__footer">
        {budget > 0
          ? <span><b>${remaining.toFixed(2)}</b> of ${budget.toFixed(0)} remaining · {pct.toFixed(1)}% spent</span>
          : <span>no cap set · <b>${spent.toFixed(2)}</b> today</span>}
      </div>
    </div>
  );
}

// BURN RATE / PROJECTED RUNOUT , always amber: this is the "how long until the
// cap" read, a warning even when nothing is wrong yet.
function BurnTile({ today }) {
  const burn = Number(today.burn) || 0;
  const budget = Number(today.budget) || 0;
  const remaining = Math.max(0, budget - (Number(today.cost) || 0));
  const hoursLeft = burn > 0 ? remaining / burn : null;
  const runout = hoursLeft == null
    ? 'holding flat · no runout projected'
    : budget <= 0
      ? 'set a cap to project a runout'
      : (() => {
          const at = new Date(Date.now() + hoursLeft * 3600 * 1000);
          const label = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          return `at this rate the cap is reached ${label}`;
        })();
  return (
    <div className="hstat hstat--tone-spend">
      <div className="hstat__hd"><span className="rp-eyebrow">BURN RATE · PROJECTED RUNOUT</span></div>
      <div className="hstat__num">
        <span className="hstat__cur">$</span>
        <span className="hstat__val">{burn.toFixed(2)}</span>
        <span className="hstat__unit">/hr</span>
      </div>
      <div className="hstat__sub hstat__sub--strong">{runout}</div>
      <div className="hstat__footer">estimate · last 60 min of traffic, held flat</div>
    </div>
  );
}

// REQUESTS tile , neutral number with the cache/avg/p95 sub-stats and a small
// two-tone usage bar (cache-served share in green, the rest muted).
function RequestsTile({ today }) {
  const reqs = Number(today.requests) || 0;
  const cachePct = Math.max(0, Math.min(100, (Number(today.cacheHitRate) || 0) * 100));
  return (
    <div className="hstat">
      <div className="hstat__hd"><span className="rp-eyebrow">REQUESTS · TODAY</span></div>
      <div className="hstat__num"><span className="hstat__val">{reqs.toLocaleString()}</span></div>
      <div className="hstat__sub">
        {cachePct.toFixed(1)}% cache hit · {today.latencyAvg.toFixed(1)}s avg · p95 {today.latencyP95.toFixed(1)}s
      </div>
      <div className="hstat__usebar" title={`${cachePct.toFixed(1)}% served from cache`}>
        <i className="hstat__usebar-cache" style={{ flex: Math.max(0.0001, cachePct) }} />
        <i className="hstat__usebar-rest" style={{ flex: Math.max(0.0001, 100 - cachePct) }} />
      </div>
    </div>
  );
}

function HeroStats({ today, activeRuns, onOpenRuns }) {
  return (
    <section className="hero-stats" data-screen-label="hero-stats">
      <SpendTile today={today} />
      <BurnTile today={today} />
      <RequestsTile today={today} />
      <SavingsStat today={today} />
      <RunsInFlight runs={activeRuns || []} onOpen={onOpenRuns} />
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
// First-run / empty state , the make-or-break screen. No requests yet, so
// teach instead of showing a grid of zeros.
// ============================================================================

function FirstRun() {
  return (
    <section className="firstrun" data-screen-label="first-run">
      <div className="firstrun__grid">
        <div>
          <span className="rp-eyebrow">FIRST RUN · NO TRAFFIC YET</span>
          <h2 className="firstrun__head">Point one agent at the proxy. Costs start rolling up per run immediately.</h2>
          <p className="firstrun__lead">Nothing is tracked until a request arrives, and nothing leaves this machine when it does. Two lines and the panels below fill in.</p>

          <div className="firstrun__step">
            <div className="firstrun__stephd">
              <span>step 1 · route your agent</span>
              <CopyButtonInline text="export ANTHROPIC_BASE_URL=http://localhost:4100" />
            </div>
            <div className="firstrun__stepbody">
              <div><span className="firstrun__prompt">$</span> export ANTHROPIC_BASE_URL=<span className="firstrun__cmd">http://localhost:4100</span></div>
              <div><span className="firstrun__prompt">$</span> export RELAYPLANE_RUN_ID=<span className="firstrun__cmd">$(uuidgen)</span> <span className="firstrun__prompt"># groups sub-agents into one run</span></div>
            </div>
          </div>

          <div className="firstrun__step">
            <div className="firstrun__stephd"><span>step 2 · set a cap before you sleep</span></div>
            <div className="firstrun__stepbody">
              <div><span className="firstrun__prompt">$</span> relayplane budget --limit 500 --on-breach deny</div>
            </div>
          </div>

          <div className="firstrun__meta">
            <span>0 providers configured, <a className="rp-link" href="#" onClick={(e) => e.preventDefault()}>add one</a></span>
            <span>waiting for first request<span className="firstrun__waiting">…</span></span>
          </div>
        </div>

        <div>
          <div className="firstrun__previewhd">what will fill in here</div>
          <div className="firstrun__tiles">
            {['spend today', 'burn rate', 'requests', 'routing savings'].map(label => (
              <div className="firstrun__tile" key={label}>
                <div className="firstrun__tile-label">{label}</div>
                <div className="firstrun__tile-shimmer" />
              </div>
            ))}
          </div>
          <div className="firstrun__runspreview">
            <div className="firstrun__tile-label">runs · cost per agent run</div>
            <div className="firstrun__runspreview-note">One row per run, the orchestrator plus every sub-agent it fanned out to, not one row per call.</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CopyButtonInline({ text }) {
  const [done, setDone] = React.useState(false);
  const copy = () => {
    const write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('no clipboard'));
    write.then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => {});
  };
  return <button className="hstat__mathbtn" onClick={copy}>{done ? 'copied' : 'copy'}</button>;
}

// ============================================================================
// App
// ============================================================================

export function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [paused, setPaused] = React.useState(false);
  const [killArmed, setKillArmed] = React.useState(false);
  const [killedAt, setKilledAt] = React.useState(null);
  // The KILL button drives the proxy's real global kill switch. Before this it
  // only froze the live feed in the browser while traffic kept flowing.
  const armKill = React.useCallback(() => {
    fetch('/control/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, reason: 'dashboard' }),
    })
      .then((r) => r.json())
      .then((j) => { setKillArmed(true); setKilledAt(j && j.activated_at ? j.activated_at : new Date().toISOString()); })
      .catch(() => setKillArmed(true));
  }, []);
  const unarmKill = React.useCallback(() => {
    fetch('/control/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(() => { setKillArmed(false); setKilledAt(null); })
      .catch(() => setKillArmed(false));
  }, []);
  React.useEffect(() => {
    fetch('/control/status')
      .then((r) => r.json())
      .then((st) => {
        if (st && st.killSwitch && st.killSwitch.active) { setKillArmed(true); setKilledAt(st.killSwitch.activatedAt || null); }
      })
      .catch(() => {});
  }, []);
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
  const [activeTab, setActiveTab] = React.useState(() => (parseRunHash() ? 'runs' : 'overview'));
  const [runId, setRunId] = React.useState(() => parseRunHash());
  // `#run=<id>` is the only route this SPA has. Sync it on mount and on every
  // hashchange so the CLI's printed URL, the request-stream chip and the
  // browser back button all land on the same run.
  React.useEffect(() => {
    const apply = () => {
      const id = parseRunHash();
      setRunId(id);
      if (id) setActiveTab('runs');
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
  const openRun = React.useCallback((id) => {
    if (id) {
      window.location.hash = `#run=${encodeURIComponent(id)}`;
    } else if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setRunId(id || null);
    setActiveTab('runs');
  }, []);
  const today = useLiveToday(5000, days);
  const liveReqs = useLiveRequests({ intervalMs: Math.max(1000, t.tickRate), limit: Math.max(50, t.streamCap), days });
  const status = useLiveStatus();
  const tier = useTier();
  const { curve: spendCurve, nowHr } = useLiveSpendCurve(30000, days);
  const { providers: liveProviders } = useLiveProviders({ intervalMs: 10000, days });
  const { runs: activeRuns } = useLiveRuns({ intervalMs: 5000, active: true });
  const { alerts: runAlerts } = useRunAlerts({ intervalMs: 15000, since: '1h', limit: 50 });

  // Newest actionable run alert: a hard cap hit (critical) or a run tracking
  // over its expected band (the "runaway run" case the design calls out by
  // name, e.g. 3.1x expected cost) , both are things you can still do
  // something about inside the alert window.
  const criticalRunAlert = React.useMemo(() => {
    const cutoff = Date.now() - RUN_ALERT_MAX_AGE_MS;
    let newest = null;
    for (const a of runAlerts) {
      if (a.severity !== 'critical' && a.kind !== 'run.over_band') continue;
      if (!(Number(a.ts) > cutoff)) continue;
      if (!newest || Number(a.ts) > Number(newest.ts)) newest = a;
    }
    return newest;
  }, [runAlerts]);

  // Budget exceeded: spend has crossed the cap for the selected window.
  const isBudgetExceeded = today.budget > 0 && today.cost >= today.budget;

  // First-run: the API has answered, there is genuinely no traffic yet in
  // today's window, and no run is mid-flight. Only meaningful on the
  // "today" window, a quiet 7d/30d view is not the onboarding moment.
  const isFirstRun = days === 1 && today.loaded && today.requests === 0 && (activeRuns || []).length === 0;

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
        onArmKill={armKill}
        onUnarmKill={unarmKill}
        days={days}
        onDaysChange={handleDaysChange}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {killArmed && (
        <div className="killband">
          <span className="killband__icon">■</span>
          <b>traffic halted.</b> every /v1 request gets <code>503 kill_switch_active</code>{killedAt ? ` since ${new Date(killedAt).toLocaleTimeString()}` : ''}. nothing is forwarded to any provider.
          <button className="ghostbtn killband__btn" onClick={unarmKill}>resume routing</button>
        </div>
      )}

      {!killArmed && isBudgetExceeded && (
        <div className="budgetband" data-screen-label="budget-exceeded-strip">
          <span className="budgetband__icon">■</span>
          <b>budget exceeded.</b>
          <span className="budgetband__msg">${today.cost.toFixed(2)} of ${today.budget.toFixed(2)}. new requests may be denied depending on the on-breach policy.</span>
          <button className="ghostbtn budgetband__btn" onClick={() => setActiveTab('config')}>raise cap</button>
        </div>
      )}

      {criticalRunAlert && (
        <div className="runband" data-screen-label="run-alert-strip">
          <span className="runband__icon">▲</span>
          <b>{String(criticalRunAlert.kind || 'run alert').replace(/_/g, ' ')}.</b>
          <span className="runband__msg">{criticalRunAlert.message}</span>
          <code className="runband__id" title={criticalRunAlert.run_id}>{criticalRunAlert.run_id}</code>
          <button className="ghostbtn runband__btn" onClick={() => openRun(criticalRunAlert.run_id)}>
            {criticalRunAlert.kind === 'run.over_band' ? 'kill this run' : 'open run'}
          </button>
        </div>
      )}

      <main className="body">
        {activeTab === 'overview' ? (
          isFirstRun ? (
            <FirstRun />
          ) : (
            <>
              <HeroStats today={today} activeRuns={activeRuns} onOpenRuns={() => openRun(null)} />

              <section className="row row--full">
                <BudgetMeter
                  today={today}
                  spendCurve={spendCurve}
                  nowHr={nowHr}
                  tickRate={t.tickRate}
                  showProjection={t.showProjection}
                />
              </section>

              {/* The centerpiece: one row per run, not per call, expandable
                  in place to cost-by-agent, retries and the expected band.
                  Cost-by-model and cost-by-agent live inside a run now,
                  consolidated rather than stranded as separate tables. The
                  full filterable ledger is one click away on the Runs tab. */}
              <RunsCenterpiece
                days={days}
                todayCost={today.cost}
                onOpenRuns={() => openRun(null)}
                onOpenRun={openRun}
              />

              <ProviderStrip providers={liveProviders} />

              <TokenPool rows={RP_TOKEN_POOL} />
            </>
          )
        ) : activeTab === 'runs' ? (
          runId
            ? <RunDetail id={runId} onBack={() => openRun(null)} onOpenRun={openRun} />
            : <Runs days={days} onOpenRun={openRun} />
        ) : activeTab === 'requests' ? (
          <RequestStream
            rows={reqs}
            paused={paused}
            onTogglePause={handleTogglePause}
            onClear={handleClear}
            density={t.density}
          />
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

