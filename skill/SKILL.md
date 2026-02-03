---
name: relayplane
description: Intelligent AI model routing proxy. Cut API costs 50-80% with automatic model selection. Haiku for simple tasks, Opus for complex ones.
user-invocable: true
homepage: https://relayplane.com/integrations/openclaw
version: 1.0.0
author: RelayPlane
license: MIT
metadata: { "openclaw": { "emoji": "🚀", "category": "ai-tools", "requires": { "bins": ["node", "curl"] } } }
---

# RelayPlane Proxy

> **100% Local. Zero Cloud. Full Control.**

Intelligent AI model routing that cuts costs by 50-80% while maintaining quality.

---

## ⚠️ IMPORTANT: API Key Users Only

This is for standard API key users (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

**MAX subscription users should NOT use this** — MAX already gives unlimited usage, the proxy would just add complexity.

---

## ⚠️ Cost Monitoring Required

RelayPlane routes requests to LLM providers using your API keys. **This incurs real costs.**

Set up billing alerts with your providers and use `/relayplane stats` to track usage.

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/relayplane stats` | Show usage statistics and cost savings |
| `/relayplane status` | Show proxy health and configuration |
| `/relayplane switch <mode>` | Change routing mode (auto\|cost\|fast\|quality) |
| `/relayplane models` | List available routing models |

---

## Quick Start (Help Users Set This Up)

### 1. Set API keys
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."  # Optional
```

### 2. Start the proxy
```bash
npx @relayplane/proxy --port 3001
```

### 3. Point tools to proxy
```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
export OPENAI_BASE_URL=http://localhost:3001
openclaw  # or any tool
```

---

## Routing Modes

| Mode | Model Name | Description |
|------|------------|-------------|
| Auto | `relayplane:auto` | Smart routing - infers task, picks optimal model |
| Cost | `relayplane:cost` | Always cheapest (Haiku) - maximum savings |
| Fast | `relayplane:fast` | Lowest latency models |
| Quality | `relayplane:quality` | Always best model (Opus) |

---

## Supported Providers

- **Anthropic:** Claude 3.5 Haiku, Sonnet 4, Opus 4.5
- **OpenAI:** GPT-4o, GPT-4o-mini, o1, o3
- **Google:** Gemini 1.5 Flash, Gemini 1.5 Pro
- **xAI:** Grok models
- **Moonshot:** v1 (8k, 32k, 128k)

---

## How It Works

```
User's Tool (OpenClaw, Cursor, etc.)
         │
         ▼
    RelayPlane Proxy (localhost:3001)
    ├── Infers task type (code_review, analysis, etc.)
    ├── Routes to optimal model (Haiku for simple, Opus for complex)
    ├── Tracks outcomes for learning
    └── Streams response back
         │
         ▼
    Provider API (Anthropic, OpenAI, etc.)
```

---

## REST Endpoints

```bash
# Check status
curl http://localhost:3001/control/status

# Get stats
curl http://localhost:3001/control/stats

# Enable/disable routing
curl -X POST http://localhost:3001/control/enable
curl -X POST http://localhost:3001/control/disable
```

---

## Configuration

Config file: `~/.relayplane/config.json` (hot-reloads on save)

```json
{
  "enabled": true,
  "routing": {
    "mode": "cascade",
    "cascade": {
      "models": ["claude-3-haiku-20240307", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"],
      "escalateOn": "uncertainty"
    }
  }
}
```

---

## Data Storage

All data local: `~/.relayplane/data.db` (SQLite)

---

## Troubleshooting

**Proxy not running?**
```bash
npx @relayplane/proxy --port 3001 -v
```

**Wrong model being used?**
Check `ANTHROPIC_BASE_URL` is set to `http://localhost:3001`

---

## Links

**Website:** https://relayplane.com

**Integration Guide:** https://relayplane.com/integrations/openclaw

**GitHub:** https://github.com/RelayPlane/proxy

**npm:** https://www.npmjs.com/package/@relayplane/proxy
