# Configuration reference

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

All configuration is optional, sensible defaults are applied for every field. The proxy merges your config with its defaults via deep merge, so you only need to specify what you want to change.

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

The classifier scores requests based on message count, total token length, tool usage, and content patterns (e.g., words like "analyze", "compare", "evaluate" increase the score). This happens locally, no prompt content is sent anywhere.

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

The suffix is stripped before provider lookup, the base model must still be valid. Suffixes influence routing decisions when the proxy has multiple options.

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

Caches LLM responses to avoid duplicate API calls. SHA-256 hash of the canonical request maps to a cached response, with gzipped disk persistence.

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

Opt-in collective learning layer. Share anonymized routing signals (model, task type, tokens, cost, never prompts) and benefit from the network's routing intelligence.

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

On by default. Opt out: `relayplane mesh off`.

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

If the proxy ever fails, all traffic automatically bypasses it, your agent talks directly to the provider. When RelayPlane recovers, traffic resumes. No manual intervention needed.
