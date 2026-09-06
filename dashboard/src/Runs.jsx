import React from 'react';
import { useLiveRuns } from './useLiveRuns';

// Runs ledger. One row per attributed run, dense and monospaced like the rest
// of the dashboard. Clicking a row hands the id back up to App, which owns the
// #run=<id> hash and swaps in RunDetail, so deep links and the request-stream
// run chip land on the same view. Keeping the switch in App also keeps the
// import graph one-directional (RunDetail reuses the pills defined here).

const SOURCES = [
  { value: 'all', label: 'all sources' },
  { value: 'header', label: 'instrumented' },
  { value: 'inferred_cc', label: 'claude code' },
  { value: 'inferred_gap', label: 'idle gap' },
];

const SOURCE_BADGE = {
  header: { short: 'instrumented', title: 'instrumented, the run id came from the X-RelayPlane-Run header' },
  inferred_cc: { short: 'cc session', title: 'inferred from Claude Code session' },
  inferred_gap: { short: 'idle gap', title: 'inferred from idle gap' },
};

export const RUN_COMMANDS = [
  { hint: 'wrap any command', cmd: 'relayplane run --label nightly -- pytest -q' },
  { hint: 'or set one header', cmd: 'X-RelayPlane-Run: nightly-20260101-a1b2c3' },
];

export function fmtUsd4(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function shortRunId(id, max = 22) {
  const s = String(id || '');
  const tail = s.split('/').pop() || s;
  return tail.length > max ? `${tail.slice(0, max - 1)}…` : tail;
}

export function shortModel(m) {
  if (!m) return '-';
  return String(m).replace(/^(anthropic|openai|google)\//, '').replace(/^claude-/, '');
}

// Model family -> chip color class. The design gives each family its own hue
// (sonnet azure, opus violet, haiku/fable green/grey) so a run's model mix is
// legible without reading the labels. Everything else falls back to neutral.
export function modelClassOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gpt') || /\bo[0-9]\b/.test(m)) return 'gpt';
  return 'other';
}

// Colored model-mix chips with a percentage share. `mix` is [{ model, count }].
// One shared renderer for the runs table, the overview centerpiece and the
// run-detail header so the color language never drifts between views.
export function ModelMixChips({ mix, max = 4 }) {
  const rows = Array.isArray(mix) ? mix.filter(m => m && m.model) : [];
  if (rows.length === 0) return <span className="dim">·</span>;
  const total = rows.reduce((a, m) => a + (Number(m.count) || 0), 0) || 1;
  const shown = rows.slice(0, max);
  const rest = rows.length - shown.length;
  return (
    <span className="rdchips">
      {shown.map(m => {
        const pct = Math.round(((Number(m.count) || 0) / total) * 100);
        return (
          <span key={m.model} className={'modelchip modelchip--' + modelClassOf(m.model)} title={`${m.model} · ${m.count} calls · ${pct}%`}>
            {shortModel(m.model)}<b>{pct}%</b>
          </span>
        );
      })}
      {rest > 0 && <span className="modelchip modelchip--other" title={`${rest} more model${rest === 1 ? '' : 's'}`}>+{rest}</span>}
    </span>
  );
}

// Ratio-aware band tone: the design distinguishes a mild overage (1.2x, amber)
// from a runaway (3.1x, red), not just over/under. under = azure, in = green.
export function bandTone(status, ratio) {
  if (status === 'under') return 'var(--rp-signal-route)';
  if (!Number.isFinite(ratio)) return status === 'over' ? 'var(--rp-signal-stop)' : 'var(--rp-signal-relay)';
  if (status === 'under') return 'var(--rp-signal-route)';
  if (ratio <= 1.05) return 'var(--rp-signal-relay)';
  if (ratio <= 1.5) return 'var(--rp-signal-spend)';
  return 'var(--rp-signal-stop)';
}

export function CopyButton({ text, children, title }) {
  const [done, setDone] = React.useState(false);
  const copy = () => {
    const write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('no clipboard'));
    write.then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    }).catch(() => {
      setDone(false);
    });
  };
  return (
    <button className={'ghostbtn' + (done ? ' is-on' : '')} onClick={copy} title={title || `copy ${text}`}>
      {done ? 'copied' : (children || 'copy')}
    </button>
  );
}

export function SourceBadge({ source }) {
  const meta = SOURCE_BADGE[source] || { short: source || 'unknown', title: source || 'unknown source' };
  return <span className={'runsrc runsrc--' + (source || 'unknown')} title={meta.title}>{meta.short}</span>;
}

export function StatusPill({ status }) {
  const s = status || 'running';
  return <span className={'runpill runpill--' + s} title={`run status: ${s}`}>{s === 'stale_closed' ? 'stale' : s}</span>;
}

export function BandPill({ status }) {
  if (!status || status === 'none') return <span className="runpill runpill--none" title="no band configured for this label">no band</span>;
  const title = status === 'over'
    ? 'over the expected band for this label and cache state'
    : status === 'under'
      ? 'under the expected band, something may have been skipped'
      : 'inside the expected band';
  return <span className={'runpill runpill--band runpill--' + status} title={title}>{status}</span>;
}

// The design's small colored gauge + "1.0x / 1.2x / 3.1x" ratio chip: cost
// against the top of the expected band. band_lo/band_hi/band_status come
// straight off the run row from /v1/runs, no extra endpoint needed.
export function BandGauge({ lo, hi, status, cost }) {
  if (!Number.isFinite(hi) || hi <= 0) return <BandPill status={status} />;
  const ratio = (Number(cost) || 0) / hi;
  const color = bandTone(status, ratio);
  const fillPct = Math.max(4, Math.min(100, ratio * 50));
  const midPct = Number.isFinite(lo) && lo > 0 ? Math.min(96, (lo / hi) * 50) : 33;
  return (
    <span className="bandgauge" title={`${fmtUsd4(cost)} vs band top ${fmtUsd4(hi)}`}>
      <span className="bandgauge__track">
        <span className="bandgauge__fill" style={{ width: fillPct + '%', background: color }} />
        <span className="bandgauge__mid" style={{ left: midPct + '%' }} />
      </span>
      <span className="bandgauge__ratio" style={{ color }}>{ratio.toFixed(1)}x</span>
    </span>
  );
}

function WavePill({ on }) {
  if (!on) return null;
  return <span className="runpill runpill--wave" title="429 or 529 wave: repeated rate limits inside the alert window">429 wave</span>;
}

function EmptyState() {
  return (
    <div className="runs__empty">
      <div className="rp-eyebrow">NO RUNS IN THIS WINDOW</div>
      <p className="runs__emptylead">
        A run is one unit of work: a nightly job, an agent task, one CI build. There are two ways to get one.
      </p>
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
      <p className="runs__emptyfoot">
        Claude Code sessions and idle gaps get inferred runs automatically, so this list fills in even with nothing instrumented.
      </p>
    </div>
  );
}

function RunRow({ r, onOpen }) {
  const name = r.label || shortRunId(r.run_id);
  const retryPct = Number(r.retry_pct) || 0;
  return (
    <button
      className={'runrow runrow--' + (r.status || 'running') + (r.band_status === 'over' ? ' is-over' : '')}
      onClick={() => onOpen(r.run_id)}
      title={r.run_id}
    >
      <span className="runrow__name">
        <span className="runrow__label">{name}</span>
        {r.label && <span className="runrow__id">{shortRunId(r.run_id, 14)}</span>}
      </span>
      <span className="runrow__cell"><StatusPill status={r.status} /></span>
      <span className="runrow__cell"><SourceBadge source={r.run_source} /></span>
      <span className="runrow__cell dim">{r.startedLabel}</span>
      <span className="runrow__cell dim">{r.durLabel}</span>
      <span className="runrow__cell r">{(Number(r.request_count) || 0).toLocaleString()}</span>
      <span className="runrow__cell r runrow__cost">{fmtUsd4(r.cost_usd)}</span>
      <span className="runrow__cell r" title={`${(retryPct * 100).toFixed(1)}% of run cost was retried work`}>
        {Number(r.retry_cost_usd) > 0
          ? <span className="runrow__retry">{fmtUsd4(r.retry_cost_usd)}</span>
          : <span className="dim">{'·'}</span>}
      </span>
      <span className="runrow__cell">
        <BandGauge lo={Number(r.band_lo)} hi={Number(r.band_hi)} status={r.band_status} cost={r.cost_usd} />
      </span>
      <span className="runrow__cell"><WavePill on={Boolean(r.rate_limit_wave)} /></span>
      <span className="runrow__cell runrow__agent dim">{r.topAgent || (r.agent_count ? `${r.agent_count} agent${r.agent_count === 1 ? '' : 's'}` : '·')}</span>
    </button>
  );
}

export function Runs({ days = 1, onOpenRun }) {
  const [activeOnly, setActiveOnly] = React.useState(false);
  const [winDays, setWinDays] = React.useState(days);
  const [labelInput, setLabelInput] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [source, setSource] = React.useState('all');

  React.useEffect(() => { setWinDays(days); }, [days]);
  // Debounce the label box so typing does not hammer the API.
  React.useEffect(() => {
    const id = setTimeout(() => setLabel(labelInput.trim()), 350);
    return () => clearTimeout(id);
  }, [labelInput]);

  const open = React.useCallback((id) => {
    if (onOpenRun) onOpenRun(id);
  }, [onOpenRun]);

  const { runs, loading, error, refresh } = useLiveRuns({
    intervalMs: 5000,
    days: winDays,
    label,
    source,
    active: activeOnly,
  });

  const totalCost = runs.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
  const totalRetry = runs.reduce((a, r) => a + (Number(r.retry_cost_usd) || 0), 0);

  return (
    <section className="panel panel--runs" data-screen-label="runs">
      <header className="panel__hd">
        <div className="panel__hd-l">
          <span className="rp-eyebrow">RUNS {activeOnly ? '· ACTIVE' : `· LAST ${winDays === 1 ? '24H' : winDays + 'D'}`}</span>
          <h3 className="panel__h">
            {loading && runs.length === 0
              ? 'reading runs.db…'
              : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}, ${fmtUsd4(totalCost)} spent, ${fmtUsd4(totalRetry)} of it retried.`}
          </h3>
        </div>
        <div className="panel__hd-r runs__ctrls">
          <button
            className={'ghostbtn' + (activeOnly ? ' is-on' : '')}
            onClick={() => setActiveOnly(v => !v)}
            title="only runs with a request in the last 5 minutes"
          >
            {activeOnly ? '● active' : 'active'}
          </button>
          <div className="seg" role="group" aria-label="run window">
            {[1, 7, 30].map(d => (
              <button
                key={d}
                className={'seg__b' + (winDays === d && !activeOnly ? ' is-on' : '')}
                onClick={() => { setActiveOnly(false); setWinDays(d); }}
              >
                {d === 1 ? '24h' : d + 'd'}
              </button>
            ))}
          </div>
          <input
            className="runs__filter"
            type="text"
            value={labelInput}
            placeholder="label"
            aria-label="filter by run label"
            onChange={(e) => setLabelInput(e.target.value)}
          />
          <select
            className="runs__filter runs__filter--sel"
            value={source}
            aria-label="filter by run source"
            onChange={(e) => setSource(e.target.value)}
          >
            {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <button className="ghostbtn" onClick={refresh} title="refetch now">refresh</button>
        </div>
      </header>

      {error && <div className="runs__err">{error}</div>}

      <div className="runs__head">
        <span>run</span>
        <span>status</span>
        <span>source</span>
        <span>started</span>
        <span>duration</span>
        <span className="r">reqs</span>
        <span className="r">cost</span>
        <span className="r">retries</span>
        <span>band</span>
        <span>rate limit</span>
        <span>top agent</span>
      </div>
      <div className="runs__body">
        {runs.length === 0 && !loading
          ? <EmptyState />
          : runs.map(r => <RunRow key={r.run_id} r={r} onOpen={open} />)}
      </div>
      <div className="runs__foot">
        cost is notional: what these requests would have been billed at published provider rates. subscription billing does not itemize.
      </div>
    </section>
  );
}
