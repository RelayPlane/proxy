## Context

The proxy already records per-request telemetry (model, provider, tokens, cost,
latency, success) and serves a dashboard at `/` (and `/dashboard`) that polls
`/v1/telemetry/{stats,runs,savings,health}` and `/v1/token-pool/status`. The cost
recorder already computes an Opus baseline (`estimateCost('claude-opus-4-6', …)`)
but the dashboard reports `savings: 0` in passthrough mode. The telemetry logger
hard-codes `openrouter` as the provider label for native-delegate routes, and
`/v1/telemetry/health` reports `status: down` because no active probe runs.

This is an **observability-only** change. It must not alter auth, routing
decisions, the delegation hot path, or add latency to request forwarding.

## Goals / Non-Goals

**Goals:**
- Make the cheap-model delegation **provably correct and visible** (real provider,
  direct-vs-leaked).
- Surface the **Verified Savings Rate** as the headline metric, computed from the
  already-available Opus baseline.
- Add **leading indicators** (burn rate, quota headroom) that would have predicted
  the quota flap.
- Replace misleading aggregates (avg latency, "down" dots, `$0` savings) with
  honest ones (percentiles, real health, real savings).

**Non-Goals:**
- No control-plane *actions* in this change (buttons to flip routing, bump
  timeouts, quarantine tokens) — observability first; actions are a follow-up.
- No Claude-as-verifier / quality scoring of worker output (separate milestone);
  the "quality-retry discount" here uses only the signal we can cheaply observe.
- No new persistence engine; extend the existing telemetry event record.

## Decisions

1. **Persist resolved provider + endpoint per event.** `resolveNativeDelegate()`
   already knows the true vendor and base URL; thread that into the telemetry
   record instead of the hard-coded `openrouter` label. The telemetry logger's
   `provider` argument becomes the resolved vendor (`minimax`, `zai`, `byteplus`,
   `anthropic`), and a new `endpointHost` field records the actual host. The
   dashboard log line and Model/Provider columns then read truthfully. *This also
   fixes the cosmetic log-label issue noted earlier.*

2. **"Leaked-to-orchestrator" = a slug that should have delegated but resolved to
   Anthropic.** Define leak as: incoming `vendor/model` with `vendor != anthropic`
   whose request was nonetheless forwarded to the Anthropic endpoint (e.g. because
   a provider key env var was unset and it fell back). Count and surface these;
   they are the silent-regression the integrity panel exists to catch.

3. **Verified Savings Rate.** Per event, `savedUsd = max(0, baselineOpusUsd -
   actualUsd)`. Rate = `Σ savedUsd / Σ baselineOpusUsd` over the window. The
   **quality-retry discount**: when a delegated request fails and the *same logical
   task* is retried on a Claude model, the failed worker cost is added back as
   "wasted" and the eventual Claude cost replaces the baseline for that task, so a
   bounced task contributes ~0 (or negative) savings. Task correlation uses the
   existing agent/session identifiers already on telemetry events; where no
   correlation exists, fall back to undiscounted savings and flag the metric as
   "gross" so it is never silently overstated.

4. **Quota headroom from response headers.** The pool already observes
   `anthropic-ratelimit-requests-{limit,remaining}` and `retry-after`. Retain the
   latest per provider and derive: `consumedPct = 1 - remaining/limit`, `burnRate`
   = tokens (or requests) per minute over a trailing window, `timeToLimit` =
   remaining / burnRate. Degrade gracefully (show "unknown") when headers are
   absent rather than guessing.

5. **Honest latency + failure taxonomy.** Compute p50/p95/p99 from retained
   per-request latencies (reservoir or bounded ring buffer to cap memory). Bucket
   failures by cause using status/symptom already available: `timeout`
   (latency ≥ delegate timeout), `auth` (401/403), `quota` (429), `upstream_5xx`,
   `other`. Surface as a small stacked breakdown, not a single success-rate.

6. **Health dot reflects observed success, not active probing.** Until active
   probing is wired, derive provider health from the trailing observed success
   rate (e.g. green ≥ 0.95, amber ≥ 0.8, red otherwise, grey if no traffic) so the
   dot stops contradicting the numbers.

## Risks / Trade-offs

- **Memory growth from retained latencies/headers.** Mitigate with bounded
  buffers and the existing retention window; never unbounded.
- **Quality-retry correlation is heuristic.** Without Claude-as-verifier we cannot
  perfectly attribute a retry to a worker failure; the design fails *safe* by
  labelling the metric "gross" when correlation is unavailable, so savings are
  never overstated.
- **Quota headroom depends on provider headers** that some endpoints omit; the
  gauge must show "unknown" rather than a misleading full bar.
- **Touching the telemetry logger signature** ripples to all call sites; keep the
  `provider` argument meaning intact (resolved vendor) and add `endpointHost` as an
  optional field to limit blast radius.
- **Observability-only guarantee:** all computation happens off the hot path
  (on read / on the dashboard poll), so forwarding latency is unaffected.
