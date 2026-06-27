## Why

The dashboard today shows vanity totals (Total Cost, raw request counts) and three
**actively misleading** tiles that fail to back the product vision — "Claude Code
as the orchestration shell, cheap models as the workers":

- **Routing Savings shows `$0`** even though the fork saves real money, because
  passthrough mode never computes the Opus counterfactual. The single most
  important number for the vision is dark.
- **Every delegated vendor is labelled `openrouter`** (a cosmetic default in the
  telemetry logger) — so the user cannot verify that `minimax/*` actually went to
  MiniMax direct and was not silently leaked back to Opus.
- **Provider Status shows "down"** for healthy providers because active probing is
  not wired, so the live success-rate is contradicted by a red dot.

Three real incidents this session — token-pool poisoning (401s), quota-recovery
flapping, and long-generation timeouts — were all *invisible* on the dashboard
until reproduced by hand. A dashboard is outstanding when it would have caught each
at a glance. This change makes the invisible visible and turns the dashboard into
the scoreboard for the vision.

## What Changes

- **Verified savings** — revive the Opus-baseline counterfactual so the dashboard
  shows actual cost vs. the all-Opus cost, and a headline **Verified Savings Rate**
  (discounted by quality-retries that bounced back to Claude).
- **Delegation integrity** — surface, per request and in aggregate, the *real*
  resolved provider/endpoint for each `vendor/model` slug; a "% direct-to-vendor
  vs leaked-to-orchestrator" panel; and corrected provider labels + health dots.
- **Quota headroom** — a leading-indicator gauge: current burn rate (tokens/min),
  Opus/Anthropic quota consumed, and estimated time-to-limit, sourced from
  `anthropic-ratelimit-*` headers.
- **Unit economics & reliability** — cost-per-session and cost-per-agent-run,
  latency distribution (p50/p95/p99, not just the misleading average), and a
  failure taxonomy bucketed by cause (timeout / auth / quota / upstream-5xx).

## Capabilities

### New Capabilities
- `dashboard-verified-savings`: Opus-baseline counterfactual cost and the
  quality-discounted Verified Savings Rate as the dashboard headline metric.
- `dashboard-delegation-integrity`: per-request real provider/endpoint provenance,
  direct-vs-leaked routing breakdown, and corrected provider labels/health.
- `dashboard-quota-headroom`: burn-rate, quota-consumed, and time-to-limit leading
  indicators sourced from upstream rate-limit headers.
- `dashboard-unit-economics`: cost-per-session/agent-run, latency percentiles, and
  a cause-bucketed failure taxonomy.

### Modified Capabilities
<!-- No existing OpenSpec capabilities; all spec behavior here is net-new. -->

## Impact

- **Code:** `src/standalone-proxy.ts` (telemetry logger provider label, dashboard
  HTML + the `/v1/telemetry/*` and `/v1/token-pool/status` endpoints), the
  baseline-cost path in the telemetry recorder (`estimateCost` / `baseline_cost`),
  and rate-limit header capture for quota headroom.
- **APIs:** new/extended read-only dashboard JSON endpoints (e.g.
  `/v1/telemetry/savings`, `/v1/telemetry/delegation`, `/v1/telemetry/quota`,
  `/v1/telemetry/latency`). No change to the request-forwarding hot path semantics.
- **Data:** telemetry events must persist the resolved provider/endpoint and the
  Opus-baseline cost per event; rate-limit headers must be retained per provider.
- **No change** to auth, routing decisions, or delegation behavior — this is an
  observability change.
