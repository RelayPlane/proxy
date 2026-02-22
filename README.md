# @relayplane/proxy

[![npm](https://img.shields.io/npm/v/@relayplane/proxy)](https://www.npmjs.com/package/@relayplane/proxy)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

An open-source LLM proxy that sits between your AI agents and providers. Tracks every request, shows where the money goes, and offers configurable task-aware routing — all running locally.

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

## Architecture (Current)

```text
Client (Claude Code / Aider / Cursor)
        |
        |  OpenAI/Anthropic-compatible request
        v
+-----------------------------------------------+
| RelayPlane Proxy (local)                       |
|-----------------------------------------------|
| 1) Parse request                               |
| 2) Infer task/complexity (pre-request)         |
| 3) Select route/model                          |
|    - explicit model / passthrough             |
|    - relayplane:auto/cost/fast/quality        |
|    - configured complexity/cascade rules       |
| 4) Forward request to provider                 |
| 5) Return provider response                    |
| 6) (Optional) record telemetry metadata        |
+-----------------------------------------------+
        |
        v
Provider APIs (Anthropic/OpenAI/Gemini/xAI/Moonshot/...)
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

## Circuit Breaker

If the proxy ever fails, all traffic automatically bypasses it — your agent talks directly to the provider. When RelayPlane recovers, traffic resumes. No manual intervention needed.

## Your Keys Stay Yours

RelayPlane requires your own provider API keys. Your prompts go directly to LLM providers — never through RelayPlane servers. All proxy execution is local. Telemetry (anonymous metadata only) is opt-in.

## License

[MIT](https://github.com/RelayPlane/proxy/blob/main/LICENSE)

---

[relayplane.com](https://relayplane.com) · [GitHub](https://github.com/RelayPlane/proxy)

