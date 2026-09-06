import React from 'react';
import { useLiveRuns, fmtRunDur } from './useLiveRuns';
import { useRunDetail } from './useRunDetail';
import { fmtUsd4, shortRunId, StatusPill, BandPill, RUN_COMMANDS, CopyButton, ModelMixChips, bandTone as bandToneShared } from './Runs';
import { BandBar } from './RunDetail';

// The Overview's centerpiece: one row per run, most recent first, expandable
// in place. This is the consolidated replacement for the old Sessions /
// cost-by-model / cost-by-agent trio -- those three panels fragmented the
// same question ("where did the money go"); this answers it once, with
// drill-down for the rest. The full filterable ledger still lives on the
// Runs tab (Runs.jsx); this is the top slice for the 5-second read.
//
// Known gap: /v1/runs and /v1/runs/active do not carry a per-run model mix
// (only agent_count, a number). Model mix, per-agent cost, retries and the
// band ruler are only on GET /v1/runs/:id, so they only render once a row is
// expanded (lazy-fetched here, not N+1'd across the whole table).

const CENTERPIECE_LIMIT = 8;

function shortModel(m) {
  if (!m) return '-';
  return String(m).replace(/^(anthropic|openai|google)\//, '').replace(/^claude-/, '');
}

// cost / top-of-band, the same "how many multiples of expected" read as the
// design's 1.0x / 1.2x / 3.1x gauge. Only computable when the run has a band
// (band_hi ships on the list/active rows, not just on detail).
function bandRatio(r) {
  const hi = Number(r.band_hi);
  const cost = Number(r.cost_usd) || 0;
  if (!Number.isFinite(hi) || hi <= 0) return null;
  return cost / hi;
}

// The cost number itself picks up the band tone once a run runs hot, so the
// most expensive/over-band runs read red at a glance in the column.
function costTone(run) {
  const ratio = bandRatio(run);
  if (run.band_status === 'over' && ratio != null) {
    if (ratio > 1.5) return 'var(--rp-signal-stop)';
    return 'var(--rp-signal-spend)';
  }
  return 'var(--rp-fg-1)';
}

function BandGauge({ run }) {
  const ratio = bandRatio(run);
  const tone = bandToneShared(run.band_status, ratio == null ? NaN : ratio);
  if (ratio == null) return <span className="rcgauge rcgauge--none">no band</span>;
  // Band top sits at the 33% mark of the track (matches the design); the fill
  // grows past it into amber then red as the run runs away from its band.
  const width = Math.max(4, Math.min(100, (ratio / 3) * 100));
  return (
    <span className="rcgauge" title={`${ratio.toFixed(1)}x the top of the expected band`}>
      <span className="rcgauge__track">
        <i style={{ width: width + '%', background: tone }} />
        <span className="rcgauge__mid" />
      </span>
      <span className="rcgauge__num" style={{ color: tone }}>{ratio.toFixed(1)}x</span>
    </span>
  );
}

// Cost-by-agent bars, colored by spend rank. The design paints the dominant
// agent red on a runaway run (down through amber to green for the rest) and a
// calm green when the run is healthy, so the eye lands on where the money went.
function agentBarColor(frac, overBand) {
  if (overBand) {
    if (frac >= 0.85) return 'var(--rp-signal-stop)';
    if (frac >= 0.4) return 'var(--rp-signal-spend)';
    return 'var(--rp-signal-relay-dim)';
  }
  return frac >= 0.66 ? 'var(--rp-signal-relay)' : 'var(--rp-signal-relay-dim)';
}

function AgentBars({ agents, overBand }) {
  if (!agents || agents.length === 0) {
    return <p className="rc__note">no per-agent breakdown recorded for this run yet.</p>;
  }
  const max = Math.max(...agents.map(a => Number(a.cost_usd) || 0), 0.0001);
  return (
    <div className="rc__agentbars">
      {agents.map(a => {
        const frac = (Number(a.cost_usd) || 0) / max;
        const color = agentBarColor(frac, overBand);
        return (
          <div className="rc__agentbar" key={a.agent_label + a.thread_id}>
            <div className="rc__agentbar-hd">
              <span>{a.agent_label} <span className="dim">{(Number(a.request_count) || 0).toLocaleString()} calls</span></span>
              <span className="rc__agentbar-cost">{fmtUsd4(a.cost_usd)}</span>
            </div>
            <div className="rc__agentbar-track"><i style={{ width: `${frac * 100}%`, background: color }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function RetryCallout({ run, detail }) {
  const cost = Number(run.cost_usd) || 0;
  const retryCost = Number(run.retry_cost_usd) || 0;
  const pct = cost > 0 ? retryCost / cost : 0;
  const count = Number(run.retry_count) || 0;
  const rateLimited = Number(run.rate_limit_count) || 0;
  // Tone escalates with the share of the run that is retry work: a small tail
  // is amber, a wave that is eating the run is red (matches the design's $4.05
  // red callout on the runaway run).
  const severe = pct >= 0.15 || (rateLimited > 0 && retryCost > 0);
  const tone = retryCost <= 0 ? 'var(--rp-signal-relay)' : severe ? 'var(--rp-signal-stop)' : 'var(--rp-signal-spend)';
  const border = retryCost <= 0 ? 'var(--rp-border-soft)' : severe ? 'rgba(240,96,79,.42)' : 'rgba(232,177,60,.35)';
  let note;
  if (count === 0) {
    note = 'No retries. Cost matches first-attempt calls only.';
  } else if (rateLimited > 0) {
    note = `${(pct * 100).toFixed(0)}% of this run is retrying through a rate-limit (429/529) wave, ${count} retr${count === 1 ? 'y' : 'ies'} across ${rateLimited} rate-limited call${rateLimited === 1 ? '' : 's'}. Backing off can cost less than pushing through.`;
  } else {
    note = `${count} retried request${count === 1 ? '' : 's'} (${(pct * 100).toFixed(0)}% of run cost), counted here instead of buried in the call log.`;
  }
  return (
    <div className="rc__retrybox" style={{ borderColor: border }}>
      <div className="rc__retrybig">
        <span style={{ color: tone }}>{fmtUsd4(retryCost)}</span>
        <span className="dim">of {fmtUsd4(cost)} total</span>
      </div>
      <p className="rc__note">{note}</p>
      <div className="rc__retrybar">
        <i style={{ flex: Math.max(0, 1 - pct) }} />
        <i style={{ flex: Math.max(0.0001, pct), background: tone }} />
      </div>
      <div className="rc__retrylegend"><span>first attempts</span><span>retries</span></div>
      {detail && Number(detail.run?.drift_count) > 0 && (
        <p className="rc__note rc__note--drift">{driftNote(detail)}</p>
      )}
      {detail && !(Number(detail.run?.drift_count) > 0) && (
        <p className="rc__note rc__note--drift">No model drift detected. Every step ran on the model its rule selected.</p>
      )}
    </div>
  );
}

function driftNote(detail) {
  const drift = detail?.drift || [];
  if (drift.length === 0) return 'No model drift detected.';
  const top = drift[0];
  return `Drift: ${top.agent_label} moved from ${shortModel(top.requested_model)} to ${shortModel(top.model)} on ${top.count} request${top.count === 1 ? '' : 's'} -- that escalation is the premium.`;
}

function RunExpanded({ id, onOpenRun }) {
  const { detail, loading, error } = useRunDetail(id, { intervalMs: 5000 });
  if (error) return <div className="rc__expand"><p className="rc__note" style={{ color: 'var(--rp-signal-stop)' }}>{error}</p></div>;
  if (!detail) return <div className="rc__expand"><p className="rc__note">{loading ? 'loading run…' : 'no data'}</p></div>;
  const run = detail.run;
  const cost = Number(run.cost_usd) || 0;
  const overBand = run.band_status === 'over';
  const mix = (detail.by_model || []).map(m => ({ model: m.model, count: Number(m.request_count) || 0 }));
  return (
    <div className="rc__expand">
      <div className="rc__expand-grid">
        <div>
          <div className="rp-eyebrow">COST BY AGENT IN THIS RUN</div>
          <AgentBars agents={detail.agents} overBand={overBand} />
          <div className="rc__mix">
            <span className="rp-eyebrow">MODEL MIX</span>
            <ModelMixChips mix={mix} max={6} />
          </div>
        </div>
        <div>
          <div className="rp-eyebrow">RETRIES · THE HIDDEN COST</div>
          <RetryCallout run={run} detail={detail} />
        </div>
        <div>
          <div className="rp-eyebrow">EXPECTED VS ACTUAL</div>
          <BandBar band={detail.band} cost={cost} />
          <div className="rc__links">
            <a href={`#run=${encodeURIComponent(run.run_id)}`} onClick={() => onOpenRun(run.run_id)}>#run={shortRunId(run.run_id, 18)}</a>
            <span className="dim">open full run detail →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunRow({ r, open, onToggle, onOpenRun }) {
  const name = r.label || shortRunId(r.run_id);
  const ratio = bandRatio(r);
  const runaway = r.band_status === 'over' && ratio != null && ratio > 1.5;
  const wrapClass = 'rc__rowwrap' + (runaway ? ' is-runaway' : r.band_status === 'over' ? ' is-over' : '');
  return (
    <div className={wrapClass}>
      <button className="rc__row" onClick={onToggle} title={r.run_id}>
        <span className="rc__cell rc__name">
          <span className="rc__caret">{open ? '▾' : '▸'}</span>
          <span className="runrow__label">{name}</span>
          {r.label && <span className="runrow__id">{shortRunId(r.run_id, 12)}</span>}
        </span>
        <span className="rc__cell dim">{r.startedLabel}</span>
        <span className="rc__cell"><StatusPill status={r.status} /></span>
        <span className="rc__cell r rc__cost" style={{ color: costTone(r) }}>{fmtUsd4(r.cost_usd)}</span>
        <span className="rc__cell r dim">{(Number(r.request_count) || 0).toLocaleString()}</span>
        <span className="rc__cell rc__mixcell"><ModelMixChips mix={r.model_mix} max={3} /></span>
        <span className="rc__cell"><BandGauge run={r} /></span>
      </button>
      {open && <RunExpanded id={r.run_id} onOpenRun={onOpenRun} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="runs__empty">
      <div className="rp-eyebrow">NO RUNS IN THIS WINDOW</div>
      <p className="runs__emptylead">A run is one unit of work: a nightly job, an agent task, one CI build.</p>
      <ol className="runs__how">
        {RUN_COMMANDS.map((c, i) => (
          <li key={c.cmd} className="runs__howrow">
            <span className="runs__hownum">{i + 1}</span>
            <span className="runs__howtext">
              <span className="runs__howhint">{c.hint}</span>
              <code className="runs__howcmd">{c.cmd}</code>
            </span>
            <CopyButton text={c.cmd} title={`copy: ${c.cmd}`} />
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RunsCenterpiece({ days, todayCost, onOpenRuns, onOpenRun }) {
  const [openId, setOpenId] = React.useState(null);
  const { runs, loading } = useLiveRuns({ intervalMs: 5000, days, active: false });
  const shown = runs.slice(0, CENTERPIECE_LIMIT);
  const totalCost = runs.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
  const attributedPct = todayCost > 0 ? Math.min(100, (totalCost / todayCost) * 100) : null;
  const runningCount = runs.filter(r => r.status === 'running').length;

  return (
    <section className="panel panel--rc" data-screen-label="runs-centerpiece">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow rp-eyebrow--accent">RUNS</span>
          <h3 className="panel__h">
            {loading && runs.length === 0
              ? 'reading runs…'
              : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} ${days === 1 ? 'today' : `in ${days}d`} · ${fmtUsd4(totalCost)} attributed${runningCount ? ` · ${runningCount} running` : ''}`}
          </h3>
        </div>
        <div className="panel__hd-r">
          <span className="panel__hint">
            group: run · agent · model{attributedPct != null ? ` · ${attributedPct.toFixed(1)}% of cost attributed` : ''}
          </span>
          {runs.length > CENTERPIECE_LIMIT && (
            <button className="ghostbtn" onClick={onOpenRuns}>all {runs.length} runs ▸</button>
          )}
        </div>
      </header>
      {shown.length === 0 && !loading ? (
        <EmptyState />
      ) : (
        <>
          <div className="rc__head">
            <span>run</span><span>started</span><span>status</span>
            <span className="r">cost</span><span className="r">calls</span><span>model mix</span><span>expected band</span>
          </div>
          <div className="rc__body">
            {shown.map(r => (
              <RunRow
                key={r.run_id}
                r={r}
                open={openId === r.run_id}
                onToggle={() => setOpenId(o => (o === r.run_id ? null : r.run_id))}
                onOpenRun={onOpenRun}
              />
            ))}
          </div>
        </>
      )}
      <div className="runs__foot">
        cost is notional: what these requests would have been billed at published provider rates. subscription billing does not itemize. model mix and per-agent breakdown load when a row is expanded (not carried on the list endpoint).
      </div>
    </section>
  );
}
