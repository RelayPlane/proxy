# Changelog

## 1.10.0 (unreleased)

Run attribution: tag work at dispatch time, and the proxy rolls cost up by run, agent
and thread. All figures are notional list price for the traffic, never an invoice.

### Features

- **Attribution ledger**: `~/.relayplane/runs.db` records every request against a run, an
  agent and a thread, written once per request by trace id. Configured under the new
  `attribution` block in `~/.relayplane/config.json`, hot-reloaded.
- **Header contract**: `X-RelayPlane-Run`, `-Agent`, `-Parent-Run`, `-Run-Label`, `-Tags`,
  `-Attempt`, `-Run-Cap-Usd` and `-Run-End` on requests; `X-RelayPlane-Run-Id`,
  `-Run-Source`, `-Run-Cost-Usd` and `-Run-Band` on every proxied response, streaming and
  not. All of them are listed in the CORS allow and expose lists.
- **Inference**: untagged traffic still groups. Claude Code sessions become
  `cc-<session>` runs with no setup; everything else falls back to a client fingerprint
  plus an idle gap.
- **`/v1/runs` API** (localhost only): list, active, detail, requests, bands, alerts,
  export, open, update and end.
- **`relayplane run`**: wraps any command as one attributed run, with zero code changes,
  and prints the rollup on exit. **`relayplane runs`**: `list`, `show`, `export`, `band`
  and `alerts`.
- **Dashboard Runs tab**: run table, run detail with the agent split, model mix, retries,
  band position and per-run alerts.
- **Per-run caps**: `--cap`, `X-RelayPlane-Run-Cap-Usd`, `POST /v1/runs/<id> {cap_usd}` or
  `attribution.defaultRunCapUsd`. Blocks the request that would cross the cap with 429
  `run_budget_exceeded`, or warns instead when `runCapAction` is `warn`. Every block lands
  in the existing kill history.
- **Expected-cost bands** per label and cache state, with an observed p25 to p75
  suggestion after five completed runs and `relayplane runs band <label> --apply`.
- **429 wave detection**: five 429 or 529 responses inside 60 seconds on one run raises
  `run.rate_limit_wave`, at most once every five minutes per run.
- **Model drift**: within a run when the served model differs from the requested one, and
  across runs when an agent's dominant model changes between windows.
- **Export**: CSV, JSON and JSONL, one row per request, 26 columns. Prompt and response
  text only when `include_content` is explicitly set.
- **Lifecycle events**: `run.first_attributed`, `run.milestone_10` and
  `run.milestone_100` join the existing anonymous pings. They carry no run ids, no
  labels, no agent names and no costs, and only header-tagged runs count. Off with
  `relayplane lifecycle off`.

### Fixes

- **Positional cost accounting under concurrent fan-out**: request costs are now keyed by
  trace id rather than by arrival position, so parallel sub-agents no longer attribute
  each other's spend.
- **`/v1/telemetry/runs?session_id=`**: the filter is now applied instead of ignored.

### Note

This file was stale from 1.9.0 onward. Backfilling the 1.9.x entries is a separate chore
and is not attempted here.

## v1.9.0 (2026-04-02)

### Features

**Multi-account token pooling** (`packages/proxy`): transparently pool multiple Anthropic API keys / Claude Max OAT tokens and select the best available one per request.

- **Auto-detect incoming tokens**: tokens sent by Claude Code, Cursor, or any client via `Authorization: Bearer` are registered in the pool automatically (priority 10). Zero config change required for single-account users.
- **Explicit config accounts**: add additional tokens under `providers.anthropic.accounts[]` in `~/.relayplane/config.json` (priority 0 by default = tried first). Perfect for users with 2+ Claude Max subscriptions.
- **Smart selection**: pool skips rate-limited tokens and proactively throttles at 90% of the known upstream RPM limit. Ties broken by fewest requests this minute.
- **Transparent 429 retry**: if the selected token receives a 429, the proxy immediately retries with the next available token. Accurate `retry-after` is returned to the client only when all tokens are exhausted.
- **Learn from headers**: `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, and `retry-after` headers are observed on every response to keep per-token rate-limit state fresh.
- **Status endpoint**: `GET /v1/token-pool/status` returns per-account label, priority, requests-this-minute, known RPM limit, and rate-limit expiry.
- **Dashboard widget**: new "Token Pool" collapsible section in the embedded dashboard shows live per-token status and a utilisation bar.

### Config example

```json
{
  "providers": {
    "anthropic": {
      "accounts": [
        { "label": "newmax", "apiKey": "sk-ant-oat01-...", "priority": 0 },
        { "label": "default", "apiKey": "sk-ant-oat01-...", "priority": 1 }
      ]
    }
  }
}
```

Backward compatible: single-token users (env var `ANTHROPIC_API_KEY` or incoming auth passthrough) see no behaviour change.

---

## v1.8.40 and earlier

See git log for prior release notes.
