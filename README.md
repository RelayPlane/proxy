# @relayplane/proxy

**Cut your OpenClaw API costs by 40-60%.** Intelligent routing that uses the right model for each task.

## The Problem

OpenClaw agents burn through API credits fast. Every tool call, every thinking step, every retry — it adds up. Most users spend $30-300/month; power users hit $1,000+.

**The fix:** Route simple tasks to cheaper models automatically. Keep Opus for complex reasoning, use Haiku for tool calls and quick tasks.

## Quick Start (OpenClaw)

### Option 1: ClawHub Skill (Recommended)

```bash
clawhub install relayplane
```

Then use `/relayplane` commands:
- `/relayplane stats` — See your usage and savings
- `/relayplane proxy start` — Start the proxy
- `/relayplane doctor` — Diagnose issues

### Option 2: Standalone Install

```bash
npm install -g @relayplane/proxy

# Start proxy
relayplane-proxy

# Add to your OpenClaw config (config.yaml)
# providers:
#   anthropic:
#     baseUrl: http://localhost:3001
```

## How It Works

```
Your Agent → RelayPlane Proxy → Right Model
                  ↓
         Analyzes task type
         Routes to optimal model
         Tracks costs locally
```

**Routing logic:**
- Quick tool calls → Haiku ($0.25/MTok)
- Code review → Sonnet ($3/MTok)  
- Complex reasoning → Opus ($15/MTok)

Your prompts never leave your machine. Only anonymous usage stats (tokens, latency, model) are collected to improve routing.

## Features

- **Smart Routing** — Automatic model selection based on task complexity
- **Cost Tracking** — Real-time spend monitoring across all providers
- **Multi-Provider** — Anthropic, OpenAI, Gemini, xAI, OpenRouter
- **Privacy First** — Prompts stay local, only metadata is collected
- **Offline Mode** — Run fully local with `--offline`

## CLI Commands

```bash
relayplane-proxy                    # Start proxy (default port 3001)
relayplane-proxy stats              # View usage statistics
relayplane-proxy telemetry off      # Disable telemetry
relayplane-proxy telemetry status   # Check telemetry setting
relayplane-proxy --audit            # See telemetry before sending
relayplane-proxy --offline          # No external calls except LLM APIs
```

## Telemetry

Anonymous telemetry helps improve routing decisions. Here's exactly what's collected:

```json
{
  "device_id": "anon_8f3a...",
  "task_type": "code_review",
  "model": "claude-sonnet-4",
  "tokens_in": 1847,
  "tokens_out": 423,
  "latency_ms": 2341,
  "success": true,
  "cost_usd": 0.02
}
```

**Never collected:** prompts, responses, file paths, anything identifying.

**Opt out anytime:**
```bash
relayplane-proxy telemetry off
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `XAI_API_KEY` | xAI/Grok API key |
| `RELAYPLANE_API_KEY` | Optional — enables cloud dashboard |

## Links

- **Docs:** [relayplane.com/docs](https://relayplane.com/docs)
- **Dashboard:** [relayplane.com/dashboard](https://relayplane.com/dashboard)
- **ClawHub Skill:** [clawhub.com/skills/relayplane](https://clawhub.com/skills/relayplane)
- **OpenClaw:** [openclaw.ai](https://openclaw.ai)

## License

MIT
