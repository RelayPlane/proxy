## 1. Telemetry data plumbing (foundation)

- [ ] 1.1 Thread the resolved vendor + endpoint host from `resolveNativeDelegate()`
      into the telemetry record; replace the hard-coded `openrouter` provider label
      in the logger with the resolved vendor (`minimax`/`zai`/`byteplus`/`anthropic`)
- [ ] 1.2 Persist the per-event Opus-baseline cost (`estimateCost('claude-opus-…')`)
      on every telemetry event, including in passthrough mode
- [ ] 1.3 Flag each event as `direct` or `leaked-to-orchestrator` (non-anthropic
      slug forwarded to the Anthropic endpoint)
- [ ] 1.4 Retain the latest `anthropic-ratelimit-*` / `retry-after` values per
      provider, and a bounded ring buffer of recent latencies per provider
- [ ] 1.5 Tag events with session/agent identifiers sufficient for unit-economics
      and quality-retry correlation (reuse the agent-tracker identifiers)

## 2. Verified savings (capability: dashboard-verified-savings)

- [ ] 2.1 Compute per-event `savedUsd = max(0, baselineOpusUsd - actualUsd)` and
      window aggregates in `/v1/telemetry/savings`
- [ ] 2.2 Implement the quality-retry discount: correlate failed delegated tasks to
      their Claude retry; subtract wasted worker cost; fall back to "gross" label
      when correlation is unavailable
- [ ] 2.3 Add the headline **Verified Savings Rate** tile + actual-vs-Opus totals
      to the dashboard, replacing the `$0` Routing Savings tile
- [ ] 2.4 Add the daily verified-savings trend

## 3. Delegation integrity (capability: dashboard-delegation-integrity)

- [ ] 3.1 New `/v1/telemetry/delegation` endpoint returning direct-vs-leaked shares
      and per-vendor endpoint provenance
- [ ] 3.2 Integrity panel: % direct-to-vendor vs leaked-to-orchestrator, offending
      vendor surfaced on leak
- [ ] 3.3 Correct the Model/Provider columns and request log line to show resolved
      vendor + endpoint host
- [ ] 3.4 Derive provider-health dot from trailing observed success rate
      (healthy/amber/red/unknown); stop showing "down" for healthy providers

## 4. Quota headroom (capability: dashboard-quota-headroom)

- [ ] 4.1 New `/v1/telemetry/quota` endpoint: consumed%, burn rate, time-to-limit
      from retained rate-limit headers
- [ ] 4.2 Quota-headroom gauge + burn-rate + time-to-limit tiles with a warning
      state before exhaustion
- [ ] 4.3 Graceful "unknown" rendering when headers are absent

## 5. Unit economics & reliability (capability: dashboard-unit-economics)

- [ ] 5.1 New `/v1/telemetry/latency` endpoint exposing p50/p95/p99 and the
      cause-bucketed failure taxonomy (timeout/auth/quota/upstream-5xx/other)
- [ ] 5.2 Replace the average-latency tile with a p50/p95/p99 distribution view
- [ ] 5.3 Cost-per-session and cost-per-agent-run tiles, flagging any worker whose
      effective per-success cost exceeds the orchestrator's
- [ ] 5.4 Failure-taxonomy breakdown panel

## 6. Verification

- [ ] 6.1 `openspec validate add-vision-dashboard --strict` passes
- [ ] 6.2 Unit tests for savings math (incl. retry discount + gross fallback),
      leak detection, percentile calc, and quota derivations
- [ ] 6.3 Confirm observability-only: no change to forwarding latency, auth, or
      routing decisions (hot path untouched)
- [ ] 6.4 Manual dashboard pass against live telemetry: savings non-zero, labels
      truthful, health dots correct, quota gauge populated
