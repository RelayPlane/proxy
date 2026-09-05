import React from 'react';
import { useRunDetail } from './useRunDetail';
import { useLiveRuns, fmtRunDur } from './useLiveRuns';
import { fmtUsd4, shortRunId, CopyButton, SourceBadge, StatusPill, BandPill } from './Runs';

// One run, end to end. Money at the top, then where it went: band, retries,
// agents, models, children, requests, alerts. No sparkline and no tree, the
// point is a number you can defend line by line.

const DEFAULT_IDLE_CLOSE_SECONDS = 600;

function fmtUsd6(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(4)}`;
}

function fmtTs(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortModel(m) {
  if (!m) return '-';
  return String(m).replace(/^(anthropic|openai|google)\//, '').replace(/^claude-/, '');
}

// Reads attribution.idleCloseSeconds off /v1/config, which serves the raw
// config file, so both the key and the whole block can be missing.
function useIdleCloseSeconds() {
  const [seconds, setSeconds] = React.useState(DEFAULT_IDLE_CLOSE_SECONDS);
  React.useEffect(() => {
    let alive = true;
    fetch('/v1/config')
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!alive || !j) return;
        const v = Number(j.attribution && j.attribution.idleCloseSeconds);
        if (Number.isFinite(v) && v > 0) setSeconds(v);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return seconds;
}

function StatTile({ eyebrow, value, sub, accent, title }) {
  return (
    <div className={'rdstat' + (accent ? ' rdstat--accent' : '')} title={title}>
      <span className="rp-eyebrow">{eyebrow}</span>
      <span className="rdstat__val">{value}</span>
      {sub && <span className="rdstat__sub">{sub}</span>}
    </div>
  );
}

// Horizontal band ruler: lo and hi ticks with the run's cost as the marker.
function BandBar({ band, cost }) {
  const lo = Number(band && band.lo);
  const hi = Number(band && band.hi);
  const cacheState = (band && band.cache_state) || 'unknown';
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) {
    return (
      <div className="rdband rdband--none">
        <span className="rp-eyebrow">EXPECTED BAND</span>
        <p className="rdband__none">
          no band for this label yet. five completed runs of the same label and cache state gives a suggested p25 to p75 band.
        </p>
      </div>
    );
  }
  // Scale so the band occupies the middle 60% of the ruler.
  const span = Math.max(hi - lo, 1e-9);
  const axisLo = lo - span * 0.6;
  const axisHi = hi + span * 0.6;
  const pos = v => Math.max(0, Math.min(100, ((v - axisLo) / (axisHi - axisLo)) * 100));
  const status = band.status || 'none';
  return (
    <div className={'rdband rdband--' + status}>
      <div className="rdband__hd">
        <span className="rp-eyebrow">EXPECTED BAND</span>
        <span className="rdband__label">
          band {fmtUsd4(lo)} to {fmtUsd4(hi)}, cache {cacheState}
        </span>
        <BandPill status={status} />
      </div>
      <div className="rdband__track">
        <i className="rdband__zone" style={{ left: pos(lo) + '%', width: (pos(hi) - pos(lo)) + '%' }} />
        <i className="rdband__tick" style={{ left: pos(lo) + '%' }} title={`lo ${fmtUsd4(lo)}`} />
        <i className="rdband__tick" style={{ left: pos(hi) + '%' }} title={`hi ${fmtUsd4(hi)}`} />
        <i
          className="rdband__marker"
          style={{ left: pos(Number(cost) || 0) + '%' }}
          title={`this run ${fmtUsd4(cost)}`}
        />
      </div>
      <div className="rdband__axis">
        <span>{fmtUsd4(axisLo)}</span>
        <span className="rdband__axismid">{fmtUsd4(lo)} · {fmtUsd4(hi)}</span>
        <span>{fmtUsd4(axisHi)}</span>
      </div>
    </div>
  );
}

function ModelChips({ modelsSeen }) {
  const entries = Object.entries(modelsSeen || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="dim">·</span>;
  return (
    <span className="rdchips">
      {entries.map(([model, n]) => (
        <span key={model} className="rdchip" title={`${model}, ${n} requests`}>
          {shortModel(model)} <b>x{n}</b>
        </span>
      ))}
    </span>
  );
}

function AgentTable({ agents }) {
  if (!agents || agents.length === 0) return null;
  return (
    <div className="rdsec">
      <div className="rdsec__hd"><span className="rp-eyebrow">AGENTS</span><span className="rdsec__meta">{agents.length} seen, cost desc</span></div>
      <div className="rdtable rdtable--agents">
        <div className="rdtable__hd">
          <span>agent</span>
          <span>source</span>
          <span className="r">reqs</span>
          <span className="r">tokens in/out</span>
          <span className="r">cost</span>
          <span className="r">retries</span>
          <span>models seen</span>
        </div>
        {agents.map(a => (
          <div className="rdtable__row" key={a.agent_label + a.thread_id}>
            <span className="rdtable__mono" title={a.thread_id}>{a.agent_label}</span>
            <span><SourceBadge source={a.agent_source === 'header' ? 'header' : 'inferred_cc'} /></span>
            <span className="r">{(Number(a.request_count) || 0).toLocaleString()}</span>
            <span className="r"><b>{(Number(a.tokens_in) || 0).toLocaleString()}</b><span className="dim">/{(Number(a.tokens_out) || 0).toLocaleString()}</span></span>
            <span className="r rdtable__cost">{fmtUsd4(a.cost_usd)}</span>
            <span className="r">{Number(a.retry_cost_usd) > 0 ? <span className="runrow__retry">{fmtUsd4(a.retry_cost_usd)}</span> : <span className="dim">·</span>}</span>
            <span><ModelChips modelsSeen={a.models_seen} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelMix({ byModel, total }) {
  if (!byModel || byModel.length === 0) return null;
  return (
    <div className="rdsec">
      <div className="rdsec__hd"><span className="rp-eyebrow">MODEL MIX</span><span className="rdsec__meta">{byModel.length} models</span></div>
      <div className="rdtable rdtable--models">
        <div className="rdtable__hd">
          <span>model</span>
          <span className="r">reqs</span>
          <span className="r">tokens in/out</span>
          <span className="r">cost</span>
          <span className="r">share</span>
        </div>
        {byModel.map(m => (
          <div className="rdtable__row" key={m.model}>
            <span className="rdtable__mono" title={m.model}>{shortModel(m.model)}</span>
            <span className="r">{(Number(m.request_count) || 0).toLocaleString()}</span>
            <span className="r"><b>{(Number(m.tokens_in) || 0).toLocaleString()}</b><span className="dim">/{(Number(m.tokens_out) || 0).toLocaleString()}</span></span>
            <span className="r rdtable__cost">{fmtUsd4(m.cost_usd)}</span>
            <span className="r dim">{total > 0 ? ((Number(m.cost_usd) / total) * 100).toFixed(0) : '0'}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChildRuns({ rows, onOpenRun }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="rdsec">
      <div className="rdsec__hd"><span className="rp-eyebrow">CHILD RUNS</span><span className="rdsec__meta">{rows.length} nested, one level</span></div>
      <div className="rdkids">
        {rows.map(c => (
          <button className="rdkid" key={c.run_id} onClick={() => onOpenRun && onOpenRun(c.run_id)} title={c.run_id}>
            <span className="rdkid__name">{c.label || shortRunId(c.run_id, 20)}</span>
            <StatusPill status={c.status} />
            <span className="rdkid__cost">{fmtUsd4(c.cost_usd)}</span>
            <span className="dim">{(Number(c.request_count) || 0).toLocaleString()} req</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RequestList({ requests }) {
  return (
    <div className="rdsec">
      <div className="rdsec__hd">
        <span className="rp-eyebrow">REQUESTS</span>
        <span className="rdsec__meta">{requests.length} most recent</span>
      </div>
      <div className="rdtable rdtable--reqs">
        <div className="rdtable__hd">
          <span>time</span>
          <span>agent</span>
          <span>model</span>
          <span className="r">tokens in/out</span>
          <span className="r">cost</span>
          <span className="r">latency</span>
          <span>status</span>
          <span>attempt</span>
        </div>
        {requests.length === 0 ? (
          <div className="rdtable__empty">no requests recorded against this run yet</div>
        ) : requests.map(q => {
          const drifted = q.requested_model && q.requested_model !== q.model;
          return (
            <div className={'rdtable__row' + (q.success ? '' : ' is-fail')} key={q.trace_id}>
              <span className="rdtable__mono dim">{fmtTs(q.ts)}</span>
              <span className="rdtable__mono">{q.agent_label}</span>
              <span className="rdtable__mono">
                {drifted && <span className="rdtable__from" title={`requested ${q.requested_model}`}>{shortModel(q.requested_model)} →</span>}
                {shortModel(q.model)}
              </span>
              <span className="r"><b>{(Number(q.tokens_in) || 0).toLocaleString()}</b><span className="dim">/{(Number(q.tokens_out) || 0).toLocaleString()}</span></span>
              <span className="r rdtable__cost">{fmtUsd6(q.cost_usd)}</span>
              <span className="r dim">{Number(q.latency_ms) || 0}ms</span>
              <span className={'rdstatus rdstatus--' + (q.success ? 'ok' : 'fail')}>
                {q.success ? 'ok' : (q.status_code || 'err')}
              </span>
              <span>
                {q.is_retry
                  ? <span className="runpill runpill--retry" title={q.retry_reason || 'retry'}>retry {q.attempt}{q.retry_reason ? ` · ${q.retry_reason}` : ''}</span>
                  : <span className="dim">1</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AlertList({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="rdsec">
      <div className="rdsec__hd"><span className="rp-eyebrow">ALERTS</span><span className="rdsec__meta">{alerts.length} on this run</span></div>
      <div className="rdalerts">
        {alerts.map(a => (
          <div className={'rdalert rdalert--' + a.severity} key={a.id}>
            <span className="rdalert__sev">{a.severity}</span>
            <span className="rdalert__kind">{a.kind}</span>
            <span className="rdalert__msg">{a.message}</span>
            <span className="rdalert__ts dim">{fmtTs(a.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunDetail({ id, onBack, onOpenRun }) {
  const { detail, requests, loading, error, refresh, actions } = useRunDetail(id, { intervalMs: 5000 });
  const { runs: activeRuns } = useLiveRuns({ intervalMs: 5000, active: true });
  const idleCloseSeconds = useIdleCloseSeconds();

  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState('');
  const [capping, setCapping] = React.useState(false);
  const [capValue, setCapValue] = React.useState('');
  const [busy, setBusy] = React.useState(null);
  const [msg, setMsg] = React.useState(null);

  const flash = (kind, text) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 2400);
  };
  const guard = (name, fn) => async () => {
    setBusy(name);
    try {
      await fn();
      flash('ok', `${name} ok`);
    } catch (e) {
      flash('err', `${name} failed`);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <section className="panel" data-screen-label="run-detail-error" style={{ padding: 24 }}>
        <button className="ghostbtn" onClick={onBack}>back to runs</button>
        <p style={{ color: 'var(--rp-signal-stop)', marginTop: 12 }}>{error}</p>
        <code style={{ color: 'var(--rp-fg-mute)' }}>{id}</code>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="panel" data-screen-label="run-detail-loading" style={{ padding: 24 }}>
        <button className="ghostbtn" onClick={onBack}>back to runs</button>
        <p style={{ color: 'var(--rp-fg-mute)', marginTop: 12 }}>{loading ? 'loading run…' : 'no run'}</p>
      </section>
    );
  }

  const run = detail.run;
  const live = activeRuns.find(r => r.run_id === run.run_id) || null;
  const burnPerMinute = run.status === 'running' && live ? (Number(live.cost_per_minute) || 0) : 0;
  const cost = Number(run.cost_usd) || 0;
  const projected = cost + (burnPerMinute * idleCloseSeconds) / 60;
  const baseline = Number(run.baseline_usd) || 0;
  const savings = Math.max(0, baseline - cost);
  const savingsPct = baseline > 0 ? (savings / baseline) * 100 : 0;
  const retries = detail.retries || { count: 0, cost_usd: 0, pct: 0 };
  const byModelTotal = (detail.by_model || []).reduce((a, m) => a + (Number(m.cost_usd) || 0), 0);
  const durMs = (Number(run.ended_at) || Number(run.last_seen_at) || 0) - (Number(run.started_at) || 0);
  const headerLine = `X-RelayPlane-Run: ${run.run_id}`;

  return (
    <section className="panel panel--rundetail" data-screen-label="run-detail">
      <header className="rdhead">
        <div className="rdhead__l">
          <button className="ghostbtn rdhead__back" onClick={onBack} title="back to the runs list">◂ runs</button>
          <div className="rdhead__ids">
            {renaming ? (
              <span className="rdhead__rename">
                <input
                  className="runs__filter"
                  autoFocus
                  value={renameValue}
                  placeholder="run label"
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }}
                />
                <button
                  className="ghostbtn"
                  disabled={busy === 'rename' || !renameValue.trim()}
                  onClick={guard('rename', async () => {
                    await actions.rename(renameValue.trim());
                    setRenaming(false);
                  })}
                >save</button>
                <button className="ghostbtn" onClick={() => setRenaming(false)}>cancel</button>
              </span>
            ) : (
              <h3 className="rdhead__title">{run.label || shortRunId(run.run_id, 32)}</h3>
            )}
            <code className="rdhead__runid" title={run.run_id}>{run.run_id}</code>
          </div>
          <StatusPill status={run.status} />
          <SourceBadge source={run.run_source} />
          {run.parent_run_id && (
            <button className="rdhead__parent" onClick={() => onOpenRun && onOpenRun(run.parent_run_id)} title={run.parent_run_id}>
              ▴ parent {shortRunId(run.parent_run_id, 16)}
            </button>
          )}
        </div>
        <div className="rdhead__r">
          {msg && <span className={'rdhead__msg rdhead__msg--' + msg.kind}>{msg.text}</span>}
          <CopyButton text={headerLine} title={`copy ${headerLine}`}>copy header</CopyButton>
          {!renaming && <button className="ghostbtn" onClick={() => { setRenameValue(run.label || ''); setRenaming(true); }}>rename</button>}
          {run.status === 'running' && (
            <button className="ghostbtn" disabled={busy === 'end run'} onClick={guard('end run', () => actions.end())}>end run</button>
          )}
          {capping ? (
            <span className="rdhead__rename">
              <input
                className="runs__filter"
                autoFocus
                type="number"
                min="0"
                step="0.01"
                value={capValue}
                placeholder="cap usd"
                onChange={e => setCapValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setCapping(false); }}
              />
              <button
                className="ghostbtn"
                disabled={busy === 'set cap'}
                onClick={guard('set cap', async () => {
                  await actions.setCap(capValue === '' ? null : Number(capValue));
                  setCapping(false);
                })}
              >save</button>
              <button className="ghostbtn" onClick={() => setCapping(false)}>cancel</button>
            </span>
          ) : (
            <button className="ghostbtn" onClick={() => { setCapValue(run.cap_usd == null ? '' : String(run.cap_usd)); setCapping(true); }}>
              {run.cap_usd == null ? 'set cap' : `cap ${fmtUsd4(run.cap_usd)}`}
            </button>
          )}
          <button className="ghostbtn" disabled={busy === 'export csv'} onClick={guard('export csv', () => actions.exportRun('csv'))}>csv</button>
          <button className="ghostbtn" disabled={busy === 'export json'} onClick={guard('export json', () => actions.exportRun('json'))}>json</button>
          <button className="ghostbtn" onClick={refresh}>refresh</button>
        </div>
      </header>

      <div className="rdstats">
        <StatTile
          eyebrow="COST SO FAR"
          value={fmtUsd4(cost)}
          sub={`notional, ${(Number(run.request_count) || 0).toLocaleString()} requests over ${fmtRunDur(durMs)}`}
          title="what these requests would cost at published provider rates"
        />
        <StatTile
          eyebrow="BURN"
          value={`${fmtUsd4(burnPerMinute)}/min`}
          sub={run.status === 'running' ? 'last 5 minutes' : 'run is closed, burn is zero'}
        />
        <StatTile
          eyebrow="PROJECTED AT IDLE CLOSE"
          value={fmtUsd4(projected)}
          sub={`if the burn holds for the ${idleCloseSeconds}s idle window`}
        />
        <StatTile
          eyebrow="VS ALL-OPUS BASELINE"
          value={fmtUsd4(savings)}
          accent
          sub={`${savingsPct.toFixed(0)}% under the ${fmtUsd4(baseline)} baseline`}
        />
      </div>

      <BandBar band={detail.band} cost={cost} />

      <p className="rdretry">
        <b>{fmtUsd4(cost)}</b> run, <b className="runrow__retry">{fmtUsd4(retries.cost_usd)}</b> in retries
        {' '}({((Number(retries.pct) || 0) * 100).toFixed(1)}%) across {Number(retries.count) || 0} retried
        {(Number(retries.count) || 0) === 1 ? ' request' : ' requests'}
        {Number(run.rate_limit_count) > 0 && <span className="rdretry__rl">· {run.rate_limit_count} rate limited</span>}
        {Number(run.drift_count) > 0 && <span className="rdretry__rl">· {run.drift_count} model drift</span>}
      </p>

      <AgentTable agents={detail.agents} />
      <ModelMix byModel={detail.by_model} total={byModelTotal} />
      <ChildRuns rows={detail.children} onOpenRun={onOpenRun} />
      <RequestList requests={requests} />
      <AlertList alerts={detail.alerts} />
    </section>
  );
}
