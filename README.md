# @relayplane/proxy

[![npm](https://img.shields.io/npm/v/@relayplane/proxy)](https://www.npmjs.com/package/@relayplane/proxy)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

An open-source LLM proxy that sits between your AI agents and providers. Tracks every request, shows where the money goes, and offers configurable task-aware routing — all running **locally, for free**.

**Free, open-source proxy features:**
- 📊 Per-request cost tracking across 11+ providers
- 💰 **Cache-aware cost tracking** — accurately tracks Anthropic prompt caching with cache read savings, creation costs, and true per-request costs
- 🔀 Configurable task-aware routing (complexity-based, cascade, model overrides)
- 🛡️ Circuit breaker — if the proxy fails, your agent doesn't notice
- 📈 **Local dashboard** at `localhost:4100` — cost breakdown, savings analysis, provider health
- 💵 **Budget enforcement** — daily/hourly/per-request spend limits with block, warn, downgrade, or alert actions
- 🔍 **Anomaly detection** — catches runaway agent loops, cost spikes, and token explosions in real time
- 🔔 **Cost alerts** — threshold alerts at configurable percentages, webhook delivery, alert history
- ⬇️ **Auto-downgrade** — automatically switches to cheaper models when budget thresholds are hit
- 📦 **Aggressive cache** — exact-match response caching with gzipped disk persistence
- 🧠 **Osmosis mesh** — opt-in collective learning layer that shares anonymized routing signals across users (free, opt-in)
- 🔧 **systemd/launchd service** — `relayplane service install` for always-on operation with auto-restart
- 🏥 **Health watchdog** — `/health` endpoint with uptime tracking and active probing
- 🛡️ **Config resilience** — atomic writes, automatic backup/restore, credential separation

> **Cloud dashboard available separately** — see [Cloud Dashboard & Pro Features](#cloud-dashboard--pro-features) below. Your prompts always stay local.

## Quick Start

```bash
npm install -g @relayplane/proxy
relayplane init
relayplane start
# Dashboard at http://localhost:4100
```

Works with any agent framework that talks to OpenAI or Anthropic APIs. Point your client at `http://localhost:4801` (set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`) and the proxy handles the rest.

## Supported Providers

**Anthropic** · **OpenAI** · **Google Gemini** · **xAI/Grok** · **OpenRouter** · **DeepSeek** · **Groq** · **Mistral** · **Together** · **Fireworks** · **Perplexity**

## Configuration

RelayPlane reads configuration from `~/.relayplane/config.json`. Override the path with the `RELAYPLANE_CONFIG_PATH` environment variable.

```bash
# Default location
~/.relayplane/config.json

# Override with env var
RELAYPLANE_CONFIG_PATH=/path/to/config.json relayplane start
```

A minimal config file:

```json
{
  "enabled": true,
  "modelOverrides": {},
  "routing": {
    "mode": "cascade",
    "cascade": { "enabled": true },
    "complexity": { "enabled": true }
  }
}
```

All configuration is optional — sensible defaults are applied for every field. The proxy merges your config with its defaults via deep merge, so you only need to specify what you want to change.

## Architecture

```text
Client (Claude Code / Aider / Cursor)
        |
        |  OpenAI/Anthropic-compatible request
        v
+-------------------------------------------------------+
| RelayPlane Proxy (local)                               |
|-------------------------------------------------------|
| 1) Parse request                                       |
| 2) Cache check (exact or aggressive mode)              |
|    └─ HIT → return cached response (skip provider)    |
| 3) Budget check (daily/hourly/per-request limits)      |
|    └─ BREACH → block / warn / downgrade / alert       |
| 4) Anomaly detection (velocity, cost spike, loops)     |
|    └─ DETECTED → alert + optional block               |
| 5) Auto-downgrade (if budget threshold exceeded)       |
|    └─ Rewrite model to cheaper alternative             |
| 6) Infer task/complexity (pre-request)                 |
| 7) Select route/model                                  |
|    - explicit model / passthrough                     |
|    - relayplane:auto/cost/fast/quality                |
|    - configured complexity/cascade rules               |
| 8) Forward request to provider                         |
| 9) Return provider response + cache it                 |
| 10) Record telemetry + update budget tracking          |
| 11) Mesh sync (push anonymized routing signals)        |
+-------------------------------------------------------+
        |
        v
Provider APIs (Anthropic/OpenAI/Gemini/xAI/...)
```

## How It Works

RelayPlane is a local HTTP proxy. You point your agent at `localhost:4801` by setting `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. The proxy:

1. **Intercepts** your LLM API requests
2. **Classifies** the task using heuristics (token count, prompt patterns, keyword matching — no LLM calls)
3. **Routes** to the configured model based on classification and your routing rules (or passes through to the original model by default)
4. **Forwards** the request directly to the LLM provider (your prompts go straight to the provider, not through RelayPlane servers)
5. **Records** token counts, latency, and cost locally for your dashboard

**Default behavior is passthrough** — requests go to whatever model your agent requested. Routing (cascade, complexity-based) is configurable and must be explicitly enabled.

## Complexity-Based Routing

The proxy classifies incoming requests by complexity (simple, moderate, complex) based on prompt length, token patterns, and the presence of tools. Each tier maps to a different model.

```json
{
  "routing": {
    "complexity": {
      "enabled": true,
      "simple": "claude-3-5-haiku-latest",
      "moderate": "claude-sonnet-4-20250514",
      "complex": "claude-opus-4-20250514"
    }
  }
}
```

**How classification works:**

- **Simple** — Short prompts, straightforward Q&A, basic code tasks
- **Moderate** — Multi-step reasoning, code review, analysis with context
- **Complex** — Architecture decisions, large codebases, tasks with many tools, long prompts with evaluation/comparison language

The classifier scores requests based on message count, total token length, tool usage, and content patterns (e.g., words like "analyze", "compare", "evaluate" increase the score). This happens locally — no prompt content is sent anywhere.

## Model Overrides

Map any model name to a different one. Useful for silently redirecting expensive models to cheaper alternatives without changing your agent configuration:

```json
{
  "modelOverrides": {
    "claude-opus-4-5": "claude-3-5-haiku",
    "gpt-4o": "gpt-4o-mini"
  }
}
```

Overrides are applied before any other routing logic. The original requested model is logged for tracking.

## Cascade Mode

Start with the cheapest model and escalate only when the response shows uncertainty or refusal. This gives you the cost savings of a cheap model with a safety net.

```json
{
  "routing": {
    "mode": "cascade",
    "cascade": {
      "enabled": true,
      "models": [
        "claude-3-5-haiku-latest",
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514"
      ],
      "escalateOn": "uncertainty",
      "maxEscalations": 2
    }
  }
}
```

**`escalateOn` options:**

| Value | Triggers escalation when... |
|-------|----------------------------|
| `uncertainty` | Response contains hedging language ("I'm not sure", "it's hard to say", "this is just a guess") |
| `refusal` | Model refuses to help ("I can't assist with that", "as an AI") |
| `error` | The request fails outright |

**`maxEscalations`** caps how many times the proxy will retry with a more expensive model. Default: `1`.

The cascade walks through the `models` array in order, starting from the first. Each escalation moves to the next model in the list.

## Smart Aliases

Use semantic model names instead of provider-specific IDs:

| Alias | Resolves to |
|-------|------------|
| `rp:best` | `anthropic/claude-sonnet-4-20250514` |
| `rp:fast` | `anthropic/claude-3-5-haiku-20241022` |
| `rp:cheap` | `openai/gpt-4o-mini` |
| `rp:balanced` | `anthropic/claude-3-5-haiku-20241022` |
| `relayplane:auto` | Same as `rp:balanced` |
| `rp:auto` | Same as `rp:balanced` |

Use these as the `model` field in your API requests:

```json
{
  "model": "rp:fast",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

## Routing Suffixes

Append `:cost`, `:fast`, or `:quality` to any model name to hint at routing preference:

```json
{
  "model": "claude-sonnet-4:cost",
  "messages": [{"role": "user", "content": "Summarize this"}]
}
```

| Suffix | Behavior |
|--------|----------|
| `:cost` | Optimize for lowest cost |
| `:fast` | Optimize for lowest latency |
| `:quality` | Optimize for best output quality |

The suffix is stripped before provider lookup — the base model must still be valid. Suffixes influence routing decisions when the proxy has multiple options.

## Provider Cooldowns / Reliability

When a provider starts failing, the proxy automatically cools it down to avoid hammering a broken endpoint:

```json
{
  "reliability": {
    "cooldowns": {
      "enabled": true,
      "allowedFails": 3,
      "windowSeconds": 60,
      "cooldownSeconds": 120
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable cooldown tracking |
| `allowedFails` | `3` | Failures within the window before cooldown triggers |
| `windowSeconds` | `60` | Rolling window for counting failures |
| `cooldownSeconds` | `120` | How long to avoid the provider after cooldown triggers |

After cooldown expires, the provider is automatically retried. Successful requests clear the failure counter.

## Hybrid Auth

Use your Anthropic MAX subscription token for expensive models (Opus) while using standard API keys for cheaper models (Haiku, Sonnet). This lets you leverage MAX plan pricing where it matters most.

```json
{
  "auth": {
    "anthropicMaxToken": "sk-ant-oat-...",
    "useMaxForModels": ["opus", "claude-opus"]
  }
}
```

**How it works:**

- When a request targets a model matching any pattern in `useMaxForModels`, the proxy uses `anthropicMaxToken` with `Authorization: Bearer` header (OAuth-style)
- All other Anthropic requests use the standard `ANTHROPIC_API_KEY` env var with `x-api-key` header
- Pattern matching is case-insensitive substring match — `"opus"` matches `claude-opus-4-20250514`

Set your standard key in the environment as usual:

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

## Telemetry

**Telemetry is disabled by default.** No data is sent to RelayPlane servers unless you explicitly opt in.

Enable with:
```bash
relayplane telemetry on
```

When enabled, the proxy sends anonymized metadata to `api.relayplane.com`:

- **device_id** — Random anonymous hash (no PII)
- **task_type** — Heuristic classification label (e.g., "code_generation", "summarization")
- **model** — Which model was used
- **tokens_in/out** — Token counts
- **latency_ms** — Response time
- **cost_usd** — Estimated cost

**Never collected:** prompts, responses, file paths, or anything that could identify you or your project. Your prompts go directly to LLM providers, never through RelayPlane servers.

> **Cloud dashboard setup:** To see your data at [relayplane.com/dashboard](https://relayplane.com/dashboard), run `relayplane login` then `relayplane telemetry on`. This is the explicit opt-in — you're choosing to send anonymous metadata to power the cloud dashboard. You can disable anytime.

When the proxy connects and telemetry is enabled, it will confirm:
```
[RelayPlane] Cloud dashboard connected — telemetry enabled.
Your prompts stay local. Only anonymous metadata (model, tokens, cost) is sent.
Disable anytime: relayplane telemetry off
```

### Audit mode

Audit mode buffers telemetry events in memory so you can inspect exactly what would be sent before it goes anywhere. Useful for compliance review.

```bash
relayplane start --audit
```

### Offline mode

```bash
relayplane start --offline
```

Disables all network calls except the actual LLM requests. No telemetry transmission, no cloud features. The proxy still tracks everything locally for your dashboard.

## Dashboard

The built-in dashboard runs at [http://localhost:4100](http://localhost:4100) (or `/dashboard`). It shows:

- Total requests, success rate, average latency
- Cost breakdown by model and provider
- Recent request history with routing decisions
- Savings from routing optimizations
- Provider health status

### API Endpoints

The dashboard is powered by JSON endpoints you can use directly:

| Endpoint | Description |
|----------|-------------|
| `GET /v1/telemetry/stats` | Aggregate statistics (total requests, costs, model counts) |
| `GET /v1/telemetry/runs?limit=N` | Recent request history |
| `GET /v1/telemetry/savings` | Cost savings from smart routing |
| `GET /v1/telemetry/health` | Provider health and cooldown status |

## Budget Enforcement

Set spending limits to prevent runaway costs. The budget manager tracks spend in rolling daily and hourly windows using SQLite with an in-memory cache for <5ms hot-path checks.

```json
{
  "budget": {
    "enabled": true,
    "dailyUsd": 50,
    "hourlyUsd": 10,
    "perRequestUsd": 2,
    "onBreach": "downgrade",
    "downgradeTo": "claude-sonnet-4-6",
    "alertThresholds": [50, 80, 95]
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable budget enforcement |
| `dailyUsd` | `50` | Daily spend limit |
| `hourlyUsd` | `10` | Hourly spend limit |
| `perRequestUsd` | `2` | Max cost for a single request |
| `onBreach` | `"downgrade"` | Action: `block`, `warn`, `downgrade`, or `alert` |
| `downgradeTo` | `"claude-sonnet-4-6"` | Model to use when downgrading |
| `alertThresholds` | `[50, 80, 95]` | Fire alerts at these % of daily limit |

```bash
relayplane budget status          # See current spend vs limits
relayplane budget set --daily 25  # Change daily limit
relayplane budget set --hourly 5  # Change hourly limit
relayplane budget reset           # Reset spend counters
```

## Anomaly Detection

Catches runaway agent loops and cost spikes using a sliding window over the last 100 requests.

```json
{
  "anomaly": {
    "enabled": true,
    "velocityThreshold": 50,
    "tokenExplosionUsd": 5.0,
    "repetitionThreshold": 20,
    "windowMs": 300000
  }
}
```

**Detection types:**

| Type | Triggers when... |
|------|-------------------|
| `velocity_spike` | Request rate exceeds threshold in 5-minute window |
| `cost_acceleration` | Spend rate is doubling every minute |
| `repetition` | Same model + similar token count >20 times in 5 min |
| `token_explosion` | Single request estimated cost exceeds $5 |

## Cost Alerts

Get notified when spending crosses thresholds. Alerts are deduplicated per window and stored in SQLite for history.

```json
{
  "alerts": {
    "enabled": true,
    "webhookUrl": "https://hooks.slack.com/...",
    "cooldownMs": 300000,
    "maxHistory": 500
  }
}
```

Alert types: `threshold` (budget %), `anomaly` (detection triggers), `breach` (limit exceeded). Severity levels: `info`, `warning`, `critical`.

```bash
relayplane alerts list            # Show recent alerts
relayplane alerts counts          # Count by type (threshold/anomaly/breach)
```

## Auto-Downgrade

When budget hits a configurable threshold (default 80%), the proxy automatically rewrites expensive models to cheaper alternatives. Adds `X-RelayPlane-Downgraded` headers so your agent knows.

```json
{
  "downgrade": {
    "enabled": true,
    "thresholdPercent": 80,
    "mapping": {
      "claude-opus-4-6": "claude-sonnet-4-6",
      "gpt-4o": "gpt-4o-mini",
      "gemini-2.5-pro": "gemini-2.0-flash"
    }
  }
}
```

Built-in mappings cover all major Anthropic, OpenAI, and Google models. Override with your own.

## Response Cache

Caches LLM responses to avoid duplicate API calls. SHA-256 hash of the canonical request → cached response with gzipped disk persistence.

```json
{
  "cache": {
    "enabled": true,
    "mode": "exact",
    "maxSizeMb": 100,
    "defaultTtlSeconds": 3600,
    "onlyWhenDeterministic": true
  }
}
```

| Mode | Behavior |
|------|----------|
| `exact` | Cache only identical requests (default) |
| `aggressive` | Broader matching with shorter TTL (30 min default) |

Only caches deterministic requests (temperature=0) by default. Skips responses with tool calls.

```bash
relayplane cache status   # Entries, size, hit rate, saved cost
relayplane cache stats    # Detailed breakdown by model and task type
relayplane cache clear    # Wipe the cache
relayplane cache on/off   # Toggle caching
```

## Osmosis Mesh

Opt-in collective learning layer. Share anonymized routing signals (model, task type, tokens, cost — never prompts) and benefit from the network's routing intelligence.

```json
{
  "mesh": {
    "enabled": true,
    "endpoint": "https://osmosis-mesh-dev.fly.dev",
    "sync_interval_ms": 60000,
    "contribute": true
  }
}
```

Auto-enabled for authenticated users. Contribution is opt-in — set `contribute: false` to consume signals without sharing.

```bash
relayplane mesh status              # Atoms local/synced, last sync, endpoint
relayplane mesh on/off              # Enable/disable mesh
relayplane mesh sync                # Force sync now
relayplane mesh contribute on/off   # Toggle contribution
```

## System Service

Install RelayPlane as a system service for always-on operation with auto-restart on crash.

```bash
# Linux (systemd)
sudo relayplane service install     # Install + enable + start
sudo relayplane service uninstall   # Stop + disable + remove
relayplane service status           # Check service state

# macOS (launchd)
relayplane service install          # Install as LaunchAgent
relayplane service uninstall        # Remove LaunchAgent
relayplane service status           # Check loaded state
```

The service unit includes `WatchdogSec=30` (systemd) and `KeepAlive` (launchd) for automatic health monitoring and restart. API keys from your current environment are captured into the service definition.

## Config Resilience

Configuration is protected against corruption:

- **Atomic writes** — config is written to a `.tmp` file then renamed (no partial writes)
- **Automatic backup** — `config.json.bak` is updated before every save
- **Auto-restore** — if `config.json` is corrupt/missing, the proxy restores from backup
- **Credential separation** — API keys live in `credentials.json`, surviving config resets

## Circuit Breaker

If the proxy ever fails, all traffic automatically bypasses it — your agent talks directly to the provider. When RelayPlane recovers, traffic resumes. No manual intervention needed.

## CLI Reference

```
relayplane [command] [options]
```

| Command | Description |
|---------|-------------|
| `(default)` / `start` | Start the proxy server |
| `init` | Initialize config and show setup instructions |
| `status` | Show proxy status, plan, and cloud sync info |
| `login` | Log in to RelayPlane (device OAuth flow) |
| `logout` | Clear stored credentials |
| `upgrade` | Open pricing page |
| `enable` / `disable` | Toggle proxy routing in OpenClaw config |
| `telemetry on\|off\|status` | Manage telemetry |
| `stats` | Show usage statistics and savings |
| `config [set-key <key>]` | Show or update configuration |
| `budget status\|set\|reset` | Manage spend limits |
| `alerts list\|counts` | View cost alert history |
| `cache status\|stats\|clear\|on\|off` | Manage response cache |
| `mesh status\|on\|off\|sync\|contribute` | Manage Osmosis mesh |
| `service install\|uninstall\|status` | System service management |
| `autostart on\|off\|status` | Legacy autostart (systemd) |

**Server options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4100` | Port to listen on |
| `--host <s>` | `127.0.0.1` | Host to bind to |
| `--offline` | — | No network calls except LLM endpoints |
| `--audit` | — | Show telemetry payloads before sending |
| `-v, --verbose` | — | Verbose logging |

## Cloud Dashboard & Pro Features

The proxy is fully functional without a cloud account. All features above are **local and free**.

For teams that want persistent cloud analytics, email digests, and shared routing intelligence, [relayplane.com](https://relayplane.com) offers:

| Feature | Plan |
|---------|------|
| Cloud dashboard — run history, cost trends, analytics | Starter ($9/mo) |
| Policy engine — budget rules, model allowlists, approval gates | Starter |
| Weekly cost digest emails | Starter |
| Routing recommendations from collective intelligence | Starter |
| 90-day history, data export | Pro ($29/mo) |
| Cloud anomaly alerts (email, webhook) | Pro |
| Team access & shared dashboards | Max ($99/mo) |
| Governance & compliance rules | Max |

**[View pricing →](https://relayplane.com/pricing)**

### Connecting to Cloud

```bash
relayplane login          # authenticate with your cloud account
relayplane telemetry on   # opt in to send anonymous metadata (model, tokens, cost, latency)
```

> **Privacy-first:** Enabling cloud telemetry sends only anonymous metadata — model name, token counts, cost, latency. Your prompts, inputs, and outputs **never leave your machine**. You can disable anytime: `relayplane telemetry off`.

---

## Your Keys Stay Yours

RelayPlane requires your own provider API keys. Your prompts go directly to LLM providers — never through RelayPlane servers. All proxy execution is local. Telemetry (anonymous metadata only) is opt-in.

## License

[MIT](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

---

[relayplane.com](https://relayplane.com) · [GitHub](https://github.com/RelayPlane/proxy)

