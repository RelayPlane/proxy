# @relayplane/proxy

**100% Local. Zero Cloud. Full Control.**

Intelligent AI model routing that cuts costs by 50-80% while maintaining quality.

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
| **Anthropic** | Claude 4.5 (Opus, Sonnet, Haiku) | ✓ | ✓ |
| **OpenAI** | GPT-5.2, GPT-5.2-Codex, o1, o3 | ✓ | ✓ |
| **Google** | Gemini 2.0 Flash, 2.0 Pro | ✓ | ✓ |
| **xAI** | Grok-3, Grok-3-mini | ✓ | ✓ |
| **Moonshot** | v1-8k, v1-32k, v1-128k | ✓ | ✓ |

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

The proxy exposes endpoints for stats and monitoring:

### `GET /health`

Server health and version info.

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "version": "0.1.7",
  "uptime": "2h 15m 30s",
  "providers": { "anthropic": true, "openai": true, "google": false },
  "totalRuns": 142
}
```

### `GET /stats`

Aggregated statistics and cost savings.

```bash
curl http://localhost:3001/stats
```

```json
{
  "totalRuns": 142,
  "savings": {
    "estimatedSavingsPercent": "73.2%",
    "actualCostUsd": "0.0234",
    "baselineCostUsd": "0.0873",
    "savedUsd": "0.0639"
  },
  "modelDistribution": {
    "anthropic/claude-3-5-haiku-latest": { "count": 98, "percentage": "69.0%" },
    "anthropic/claude-sonnet-4-20250514": { "count": 44, "percentage": "31.0%" }
  }
}
```

### `GET /runs`

Recent routing decisions.

```bash
curl "http://localhost:3001/runs?limit=10"
```

```json
{
  "runs": [
    {
      "runId": "abc123",
      "timestamp": "2026-02-03T13:26:03Z",
      "model": "anthropic/claude-3-5-haiku-latest",
      "taskType": "code_generation",
      "confidence": 0.92,
      "mode": "auto",
      "durationMs": 1203,
      "promptPreview": "Write a function that..."
    }
  ],
  "total": 142
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

- [Documentation](https://relayplane.com/integrations/openclaw)
- [GitHub](https://github.com/RelayPlane/proxy)
- [RelayPlane SDK](https://github.com/RelayPlane/sdk)

## License

MIT
