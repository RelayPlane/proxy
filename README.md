# @relayplane/proxy

**100% Local. Zero Cloud. Full Control.**

Intelligent AI model routing that cuts costs by 50-80% while maintaining quality.

> **Note:** Designed for standard API key users (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). MAX subscription OAuth is not currently supported — MAX users should continue using their provider directly.

> ⚠️ **Cost Monitoring Required**
>
> RelayPlane routes requests to LLM providers using your API keys. **This incurs real costs.**
>
> - Set up billing alerts with your providers (Anthropic, OpenAI, etc.)
> - Monitor usage through your provider's dashboard
> - Use `/relayplane stats` or `curl localhost:3001/control/stats` to track usage
> - Start with test requests to understand routing behavior
>
> RelayPlane provides cost *optimization*, not cost *elimination*. You are responsible for monitoring your actual spending.

[![CI](https://github.com/RelayPlane/proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/RelayPlane/proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@relayplane/proxy)](https://www.npmjs.com/package/@relayplane/proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
npm install @relayplane/proxy
```

Or run directly:

```bash
npx @relayplane/proxy
```

## CLI Commands

```bash
# Start the proxy server
npx @relayplane/proxy

# Start on custom port
npx @relayplane/proxy --port 8080

# View routing statistics
npx @relayplane/proxy stats

# View stats for last 30 days
npx @relayplane/proxy stats --days 30

# Show help
npx @relayplane/proxy --help
```

## OpenClaw Slash Commands

If you're using OpenClaw, these chat commands are available:

| Command | Description |
|---------|-------------|
| `/relayplane stats` | Show usage statistics and cost savings |
| `/relayplane status` | Show proxy health and configuration |
| `/relayplane switch <mode>` | Change routing mode (auto\|cost\|fast\|quality) |
| `/relayplane models` | List available routing models |

Example:
```
/relayplane stats
/relayplane switch cost
```

## Quick Start

### 1. Set your API keys

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
# Optional: GEMINI_API_KEY, XAI_API_KEY, MOONSHOT_API_KEY
```

### 2. Start the proxy

```bash
npx @relayplane/proxy --port 3001
```

### 3. Point your tools to the proxy

```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
export OPENAI_BASE_URL=http://localhost:3001

# Now run OpenClaw, Cursor, Aider, or any tool
openclaw
```

That's it. All API calls now route through RelayPlane for intelligent model selection.

## How It Works

```
Your Tool (OpenClaw, Cursor, etc.)
         │
         ▼
    RelayPlane Proxy
    ├── Infers task type (code_review, analysis, etc.)
    ├── Checks routing rules
    ├── Selects optimal model (Haiku for simple, Opus for complex)
    ├── Tracks outcomes (success/failure/latency)
    └── Learns patterns → improves over time
         │
         ▼
    Provider (Anthropic, OpenAI, etc.)
```

## Learning & Adaptation

RelayPlane doesn't just route — it **learns from every request**:

- **Outcome Tracking** — Records success/failure for each route decision
- **Pattern Detection** — Identifies what works for your specific codebase
- **Continuous Improvement** — Routing gets smarter the more you use it
- **Local Intelligence** — All learning happens in your local SQLite DB

```bash
# View your routing stats (last 7 days)
npx @relayplane/proxy stats

# View last 30 days
npx @relayplane/proxy stats --days 30

# Query the raw data directly
sqlite3 ~/.relayplane/data.db "SELECT model, task_type, COUNT(*) FROM runs GROUP BY model, task_type"
```

Unlike static routing rules, RelayPlane adapts to **your** usage patterns.

## Supported Providers

| Provider | Models | Streaming | Tools |
|----------|--------|-----------|-------|
| **Anthropic** | Claude 3.5 Haiku, Sonnet 4, Opus 4.5 | ✓ | ✓ |
| **OpenAI** | GPT-4o, GPT-4o-mini, GPT-4.1, o1, o3 | ✓ | ✓ |
| **Google** | Gemini 1.5 Flash, Gemini 1.5 Pro | ✓ | ✓ |
| **xAI** | Grok (grok-*) | ✓ | ✓ |
| **Moonshot** | Moonshot v1 (8k, 32k, 128k) | ✓ | ✓ |

## Routing Modes

| Model | Description |
|-------|-------------|
| `relayplane:auto` | Infers task type, routes to optimal model |
| `relayplane:cost` | Prioritizes cheapest models (maximum savings) |
| `relayplane:quality` | Uses best available model |

Or pass through explicit models: `claude-3-5-sonnet-latest`, `gpt-4o`, etc.

## Why RelayPlane?

| Without RelayPlane | With RelayPlane |
|-------------------|-----------------|
| Pay Opus token rates for simple tasks | Route simple tasks to Haiku (1/10 the cost) |
| Static model selection | Learns from outcomes over time |
| Manual optimization | Automatic cost-quality balance |
| No visibility into spend | Built-in savings tracking |

## Key Features

- **100% Local** — All data in SQLite (`~/.relayplane/data.db`)
- **Zero Friction** — Set 2 env vars, done
- **Learning** — Improves routing based on outcomes
- **Full Streaming** — SSE support for all providers
- **Tool Calls** — Function calling across providers

## Programmatic Usage

```typescript
import { startProxy, RelayPlane, calculateSavings } from '@relayplane/proxy';

// Start the proxy
await startProxy({ port: 3001, verbose: true });

// Or use RelayPlane directly
const relay = new RelayPlane({});
const result = await relay.run({ prompt: 'Review this code...' });
console.log(result.taskType); // 'code_review'
console.log(result.model);    // 'anthropic:claude-3-5-haiku-latest'

// Check savings
const savings = calculateSavings(relay.store, 30);
console.log(`Saved ${savings.savingsPercent}% this month`);

relay.close();
```

## CLI Options

```bash
npx @relayplane/proxy [options]

Options:
  --port <number>    Port to listen on (default: 3001)
  --host <string>    Host to bind to (default: 127.0.0.1)
  -v, --verbose      Enable verbose logging
  -h, --help         Show help
```

## REST API

The proxy exposes control endpoints for stats and monitoring:

### `GET /control/status`

Proxy status and current configuration.

```bash
curl http://localhost:3001/control/status
```

```json
{
  "enabled": true,
  "mode": "cascade",
  "modelOverrides": {}
}
```

### `GET /control/stats`

Aggregated statistics and routing counts.

```bash
curl http://localhost:3001/control/stats
```

```json
{
  "uptimeMs": 3600000,
  "uptimeFormatted": "60m 0s",
  "totalRequests": 142,
  "successfulRequests": 138,
  "failedRequests": 4,
  "successRate": "97.2%",
  "avgLatencyMs": 1203,
  "escalations": 12,
  "routingCounts": {
    "auto": 100,
    "cost": 30,
    "passthrough": 12
  },
  "modelCounts": {
    "anthropic/claude-3-5-haiku-latest": 98,
    "anthropic/claude-sonnet-4-20250514": 44
  }
}
```

### `POST /control/enable` / `POST /control/disable`

Enable or disable routing (passthrough mode when disabled).

```bash
curl -X POST http://localhost:3001/control/enable
curl -X POST http://localhost:3001/control/disable
```

### `POST /control/config`

Update configuration (hot-reload, merges with existing).

```bash
curl -X POST http://localhost:3001/control/config \
  -H "Content-Type: application/json" \
  -d '{"routing": {"mode": "cascade"}}'
```

## Configuration

RelayPlane creates a config file on first run at `~/.relayplane/config.json`:

```json
{
  "enabled": true,
  "routing": {
    "mode": "cascade",
    "cascade": {
      "enabled": true,
      "models": [
        "claude-3-haiku-20240307",
        "claude-3-5-sonnet-20241022",
        "claude-3-opus-20240229"
      ],
      "escalateOn": "uncertainty",
      "maxEscalations": 1
    },
    "complexity": {
      "enabled": true,
      "simple": "claude-3-haiku-20240307",
      "moderate": "claude-3-5-sonnet-20241022",
      "complex": "claude-3-opus-20240229"
    }
  },
  "reliability": {
    "cooldowns": {
      "enabled": true,
      "allowedFails": 3,
      "windowSeconds": 60,
      "cooldownSeconds": 120
    }
  },
  "modelOverrides": {}
}
```

**Edit and save — changes apply instantly** (hot-reload, no restart needed).

### Configuration Options

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable routing (false = passthrough mode) |
| `routing.mode` | `"cascade"` or `"standard"` |
| `routing.cascade.models` | Ordered list of models to try (cheapest first) |
| `routing.cascade.escalateOn` | When to escalate: `"uncertainty"`, `"refusal"`, or `"error"` |
| `routing.complexity.simple/moderate/complex` | Models for each complexity level |
| `reliability.cooldowns` | Auto-disable failing providers temporarily |
| `modelOverrides` | Map input model names to different targets |

### Examples

Use GPT-4o for complex tasks:
```json
{
  "routing": {
    "complexity": {
      "complex": "gpt-4o"
    }
  }
}
```

Override a specific model:
```json
{
  "modelOverrides": {
    "claude-3-opus": "claude-3-5-sonnet-20241022"
  }
}
```

## Data Storage

All data stored locally at `~/.relayplane/data.db` (SQLite).

```bash
# View recent runs
sqlite3 ~/.relayplane/data.db "SELECT * FROM runs ORDER BY created_at DESC LIMIT 10"

# Check routing rules
sqlite3 ~/.relayplane/data.db "SELECT * FROM routing_rules"
```

## Links

**Website:** https://relayplane.com

**Integration Guide:** https://relayplane.com/integrations/openclaw

**GitHub:** https://github.com/RelayPlane/proxy

**npm:** https://www.npmjs.com/package/@relayplane/proxy

## License

MIT
