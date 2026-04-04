# @relayplane/proxy

[![npm](https://img.shields.io/npm/v/@relayplane/proxy)](https://www.npmjs.com/package/@relayplane/proxy)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

A **Node.js npm LLM proxy** that sits between your AI agents and providers. Drop-in replacement for OpenAI and Anthropic base URLs — no Docker, no Python, just `npm install`. Tracks every request, shows where the money goes, and offers configurable task-aware routing — all running **locally, for free**.

**Live savings dashboard:** [relayplane.com/live](https://relayplane.com/live) — see real-time aggregate savings from developers worldwide.

**The npm-native LLM proxy for Node.js developers.** Works with Claude Code, Cursor, OpenClaw, and any tool that supports `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`.

**Free, open-source proxy features:**
- 📊 Per-request cost tracking across 11 providers
- 💰 **Cache-aware cost tracking** - accurately tracks Anthropic prompt caching with cache read savings, creation costs, and true per-request costs
- 🔀 Configurable task-aware routing (complexity-based, cascade, model overrides)
- 🛡️ Circuit breaker - if the proxy fails, your agent doesn't notice
- 📈 **Local dashboard** at `localhost:4100` - cost breakdown, savings analysis, provider health, agent breakdown
- 💵 **Budget enforcement** - daily/hourly/per-request spend limits with block, warn, downgrade, or alert actions
- 🔍 **Anomaly detection** - catches runaway agent loops, cost spikes, and token explosions in real time
- 🔔 **Cost alerts** - threshold alerts at configurable percentages, webhook delivery, alert history
- ⬇️ **Auto-downgrade** - automatically switches to cheaper models when budget thresholds are hit
- 📦 **Aggressive cache** - exact-match response caching with gzipped disk persistence
- 🤖 **Per-agent cost tracking** - identifies agents by system prompt fingerprint and tracks cost per agent
- 📝 **Content logging** - dashboard shows system prompt preview, user message, and response preview per request
- 🔐 **OAuth passthrough** - correctly forwards `user-agent` and `x-app` headers for Claude Max subscription users (OpenClaw compatible)
- 🧠 **Osmosis mesh** - collective learning layer that shares anonymized routing signals across users (on by default, opt-out: `relayplane mesh off`)
- 🔧 **systemd/launchd service** - `relayplane service install` for always-on operation with auto-restart
- 🏥 **Health watchdog** - `/health` endpoint with uptime tracking and active probing
- 🛡️ **Config resilience** - atomic writes, automatic backup/restore, credential separation

> **Cloud dashboard available separately** - see [Cloud Dashboard & Pro Features](#cloud-dashboard--pro-features) below. Your prompts always stay local.

## Quick Start

```bash
npm install -g @relayplane/proxy
relayplane init
relayplane start
# Dashboard at http://localhost:4100
```

Works with any agent framework that talks to OpenAI or Anthropic APIs. Point your client at `http://localhost:4100` (set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`) and the proxy handles the rest.

### Auto-start with Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "relayplane ensure-running"
          }
        ]
      }
    ]
  }
}
```

RelayPlane will start automatically when Claude Code opens. If it's already running (multiple sessions), the hook exits immediately. No duplicate processes.

## What's New in v1.8.35

**Recent additions:**

- **[relayplane.com/live](https://relayplane.com/live)** — Atlas public proof-of-work dashboard showing real-time aggregate savings from developers worldwide
- **Osmosis Phase 1 shipped** — local telemetry capture tracks every routing decision; mesh is on by default
- **Service installer hardened** — detects invoking user, loads env files correctly on systemd installs
- **Provider-aware auto-routing** — Gemini, OpenRouter, xAI supported natively without extra config
- **Agent-native signup flow** — `relayplane login` handles device OAuth inline

**Note for upgraders from pre-v1.8.14:** Telemetry and mesh are now ON by default. Disable both: `relayplane telemetry off && relayplane mesh off`

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

All configuration is optional - sensible defaults are applied for every field. The proxy merges your config with its defaults via deep merge, so you only need to specify what you want to change.

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

RelayPlane is a local HTTP proxy. You point your agent at `localhost:4100` by setting `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. The proxy:

1. **Intercepts** your LLM API requests
2. **Classifies** the task using heuristics (token count, prompt patterns, keyword matching - no LLM calls)
3. **Routes** to the configured model based on classification and your routing rules (or passes through to the original model by default)
4. **Forwards** the request directly to the LLM provider (your prompts go straight to the provider, not through RelayPlane servers)
5. **Records** token counts, latency, and cost locally for your dashboard

**Default behavior is passthrough** - requests go to whatever model your agent requested. Routing (cascade, complexity-based) is configurable and must be explicitly enabled.

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

- **Simple** - Short prompts, straightforward Q&A, basic code tasks
- **Moderate** - Multi-step reasoning, code review, analysis with context
- **Complex** - Architecture decisions, large codebases, tasks with many tools, long prompts with evaluation/comparison language

The classifier scores requests based on message count, total token length, tool usage, and content patterns (e.g., words like "analyze", "compare", "evaluate" increase the score). This happens locally - no prompt content is sent anywhere.

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

| Alias | Resolves to | Via |
|-------|------------|-----|
| `rp:best` | `anthropic/claude-sonnet-4-5` | OpenRouter |
| `rp:fast` | `anthropic/claude-3-5-haiku` | OpenRouter |
| `rp:cheap` | `google/gemini-2.0-flash-001` | OpenRouter |
| `rp:balanced` | `anthropic/claude-3-5-haiku` | OpenRouter |
| `relayplane:auto` | Same as `rp:balanced` | - |
| `rp:auto` | Same as `rp:balanced` | - |

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

The suffix is stripped before provider lookup - the base model must still be valid. Suffixes influence routing decisions when the proxy has multiple options.

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

- When a request targets a model matching any pattern in `useMaxForModels`, the proxy uses `anthropicMaxToken` via `x-api-key` header
- All other Anthropic requests use the standard `ANTHROPIC_API_KEY` env var with `x-api-key` header
- Pattern matching is case-insensitive substring match, so `"opus"` matches `claude-opus-4-20250514`
- Both `sk-ant-api*` and `sk-ant-oat*` tokens are sent as `x-api-key` (Anthropic accepts all token types via this header)

Set your standard key in the environment as usual:

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

## Telemetry

**Telemetry is enabled by default.** This powers the cloud dashboard and helps improve routing recommendations. Only anonymous metadata is sent, never prompts or responses.

Disable with:
```bash
relayplane telemetry off
```

The proxy sends anonymized metadata to `api.relayplane.com`:

- **device_id** - Random anonymous hash (no PII)
- **task_type** - Heuristic classification label (e.g., "code_generation", "summarization")
- **model** - Which model was used
- **tokens_in/out** - Token counts
- **latency_ms** - Response time
- **cost_usd** - Estimated cost

**Never collected:** prompts, responses, file paths, or anything that could identify you or your project. Your prompts go directly to LLM providers, never through RelayPlane servers. Mesh (on by default) shares anonymized metadata: model, tokens, cost, latency, success/fail. Opt out: `relayplane mesh off`.

> **Cloud dashboard:** To see your data at [relayplane.com/dashboard](https://relayplane.com/dashboard), run `relayplane login`. Telemetry is already on by default. The cloud dashboard requires telemetry to function. You can disable telemetry anytime, but cloud features won't work without it.

When the proxy connects and telemetry is enabled, it will confirm:
```
[RelayPlane] Cloud dashboard connected - telemetry enabled.
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
- Cost breakdown by model and provider (with provider column to distinguish `anthropic` vs `openrouter` for same model names)
- **Agent Cost Breakdown** - per-agent spend table identifying agents by system prompt fingerprint
- Recent request history with agent column and expandable rows (state persists across the 5-second auto-refresh)
- **Content previews** - system prompt preview, user message, and response preview in expandable rows
- **Honest savings breakdown** - routing savings (RelayPlane's contribution) vs cache savings (Anthropic's feature), with tooltip explaining the calculation
- Error detail capture - failed requests show the error message and HTTP status code
- Provider health status
- Wider 1600px layout for dense data views

### Per-Agent Cost Tracking

RelayPlane v1.7 identifies each agent by fingerprinting its system prompt. This groups all requests from the same agent together - even across sessions - so you can see exactly which agent is responsible for which costs.

The Agent Cost Breakdown table in the dashboard shows total spend, request count, and average cost per request for each distinct agent. No configuration required - fingerprinting happens automatically.

### Content Logging

When content logging is enabled, the dashboard stores and displays:

- A preview of the system prompt
- The first user message in the conversation
- A preview of the model's response

This makes it easy to correlate a cost spike with the actual request that caused it. Content is stored locally only - nothing is sent to RelayPlane servers.

### Auth Passthrough (Claude Max / OpenClaw Users)

If you use a Claude Max subscription (tokens starting with `sk-ant-oat*`), the proxy handles them correctly via the `x-api-key` header. No special configuration needed. The proxy also forwards `user-agent` and `x-app` headers required by Anthropic for subscription validation.

**Important:** All Anthropic token types (`sk-ant-api*` and `sk-ant-oat*`) are sent via `x-api-key`. The proxy does not use `Authorization: Bearer` for Anthropic requests.

## OpenClaw Integration

The simplest way to use RelayPlane with OpenClaw is to point the Anthropic provider at the proxy. This routes all Anthropic model requests through RelayPlane transparently, with no changes to model names or agent configs.

### Setup

1. Install and start the proxy:

```bash
npm install -g @relayplane/proxy
relayplane init
relayplane start
```

2. Point OpenClaw's Anthropic provider at the proxy:

```bash
openclaw config set models.providers.anthropic.baseUrl http://localhost:4100
```

That's it. All `anthropic/*` model requests now flow through RelayPlane. Your existing model names (`anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-6`) work unchanged.

### What you get

- **Cost tracking** per agent, per model, per day
- **Complexity-based routing** (e.g., simple tasks use Sonnet, complex tasks use Opus)
- **Budget enforcement** with automatic downgrades
- **Dashboard** at http://localhost:4100

### Complexity routing example

Configure the proxy to automatically route simple tasks to Sonnet and complex tasks to Opus:

```json
{
  "routing": {
    "mode": "complexity",
    "complexity": {
      "enabled": true,
      "simple": "claude-sonnet-4-6",
      "moderate": "claude-sonnet-4-6",
      "complex": "claude-opus-4-6"
    }
  }
}
```

OpenClaw agents request whatever model they're configured with. The proxy classifies the task and routes accordingly. No agent config changes needed.

### Auth

The proxy passes through whatever API key OpenClaw sends. If you use a MAX subscription, OpenClaw sends your `sk-ant-oat*` token and the proxy forwards it directly to Anthropic. No extra auth configuration in the proxy is needed for passthrough mode.

For hybrid auth (MAX token for expensive models, standard key for cheap ones), see [Hybrid Auth](#hybrid-auth).

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

Opt-in collective learning layer. Share anonymized routing signals (model, task type, tokens, cost - never prompts) and benefit from the network's routing intelligence.

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

On by default. Opt out: `relayplane mesh off`. Free users receive provider health alerts; Pro users receive full routing intelligence.

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

- **Atomic writes** - config is written to a `.tmp` file then renamed (no partial writes)
- **Automatic backup** - `config.json.bak` is updated before every save
- **Auto-restore** - if `config.json` is corrupt/missing, the proxy restores from backup
- **Credential separation** - API keys live in `credentials.json`, surviving config resets

## Circuit Breaker

If the proxy ever fails, all traffic automatically bypasses it - your agent talks directly to the provider. When RelayPlane recovers, traffic resumes. No manual intervention needed.

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
| `ensure-running` | Start proxy if not running (idempotent, safe for hooks) |

**Server options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4100` | Port to listen on |
| `--host <s>` | `127.0.0.1` | Host to bind to |
| `--offline` | - | No network calls except LLM endpoints |
| `--audit` | - | Show telemetry payloads before sending |
| `-v, --verbose` | - | Verbose logging |

## Cloud Dashboard & Pro Features

The proxy is fully functional without a cloud account. All features above are **local and free**.

Cloud dashboard is **free for all signed-up users**. Just `relayplane login`. For extended history, full mesh intelligence, and governance, [relayplane.com](https://relayplane.com) offers:

| Feature | Plan |
|---------|------|
| Cloud dashboard - run history, cost trends, analytics | Free (all tiers) |
| 30-day cloud history, weekly cost digest, routing recommendations | Starter ($9/mo) |
| Full mesh intelligence - routing signals from thousands of agents | Pro ($29/mo) |
| 90-day history, data export, cost spike alerts | Pro |
| Private team mesh, per-agent spend limits, approval flows | Max ($99/mo) |
| Governance & compliance rules, audit logs | Max |

**[View pricing →](https://relayplane.com/pricing)**

### Connecting to Cloud

```bash
relayplane login    # authenticate - unlocks cloud dashboard (free)
```

Telemetry is on by default. The cloud dashboard requires it to display your data. Disable anytime: `relayplane telemetry off`.

> **Privacy-first:** Telemetry sends only anonymous metadata - model name, token counts, cost, latency. Your prompts, inputs, and outputs **never leave your machine**. Mesh is also on by default; opt out: `relayplane mesh off`.

---

## Your Keys Stay Yours

RelayPlane requires your own provider API keys. Your prompts go directly to LLM providers - never through RelayPlane servers. All proxy execution is local. Mesh telemetry (anonymous metadata only) is on by default. Opt out: `relayplane mesh off`. Your prompts always go directly to providers.

## License

[MIT](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

---

[relayplane.com](https://relayplane.com) · [GitHub](https://github.com/RelayPlane/proxy)

