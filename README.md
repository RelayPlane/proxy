# RelayPlane

**Stop paying for your agent's mistakes.**

RelayPlane is an open source proxy that sits between your AI agents and LLM providers. It tracks every dollar, routes to the cheapest effective model, and learns from every agent on the network.

77% cost reduction. One install. Zero risk.

```bash
npm install -g @relayplane/proxy && relayplane init
```

## Why now

On February 18, 2026, Anthropic banned subscription OAuth tokens in OpenClaw and similar tools. Users who were paying $200/month now face $600–2,000+ in API costs for the same usage.

But the cost crisis started before the ban. The real problem: **your agent uses the most expensive model for everything.** Code formatting? Opus. Reading a file? Opus. Simple questions? Opus.

73% of typical agent spend is on the wrong model for the task.

## Three pillars

### 1. Observe — See where every dollar goes

Every LLM request flows through RelayPlane. Cost per request, model used, task type, tokens consumed — all tracked automatically.

### 2. Govern — Route to the cheapest model that works

A policy engine classifies each task and routes it to the most cost-effective model. Simple file reads → Haiku ($0.25/MTok). Complex architecture → Opus ($15/MTok). You set the rules or use defaults.

### 3. Learn — Every agent makes yours smarter

Opt into the collective mesh. Anonymized routing outcomes from thousands of agents improve everyone's routing. The network gets smarter without you doing anything.

## Safety first

RelayPlane uses a circuit breaker architecture. If the proxy fails, all traffic automatically bypasses it and goes directly to your provider. Your agent doesn't notice.

```
CLOSED (normal) → OPEN (after 3 failures) → HALF-OPEN (probe) → CLOSED (recovered)
```

Worst case: you pay what you would have paid anyway.

## Quick start

### Option 1: npm (recommended)

```bash
npm install -g @relayplane/proxy
relayplane init
relayplane start
```

Dashboard at `http://localhost:4100`. See your costs within the first hour.

### Option 2: OpenClaw config

```json
{
  "relayplane": {
    "enabled": true
  }
}
```

### Option 3: ClawHub skill

```bash
clawhub install relayplane
```

## How routing works

| Task type | Before | After | Savings |
|-----------|--------|-------|---------|
| File reads, edits | Opus ($15/MTok) | Haiku ($0.25/MTok) | 98% |
| Code generation | Opus ($15/MTok) | Sonnet ($3/MTok) | 80% |
| Complex architecture | Opus ($15/MTok) | Opus ($15/MTok) | 0% |
| Retried failures | Wasted spend | Eliminated | 100% |

## Programmatic API

```typescript
import {
  RelayPlaneMiddleware,
  CircuitBreaker,
  HealthMonitor,
  loadRelayConfig,
} from '@relayplane/proxy';

const config = loadRelayConfig();
const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 });
const middleware = new RelayPlaneMiddleware({ config, circuitBreaker: breaker });
```

## CLI

```bash
relayplane start                    # Start proxy (port 4100)
relayplane stats                    # View usage and savings
relayplane config                   # Show configuration
relayplane doctor                   # Diagnose issues
relayplane telemetry off            # Disable telemetry
```

## Privacy

Your prompts never leave your machine. Only anonymized metadata is shared (if you opt in):

- Task type, token count, model used, success/fail
- **Never:** prompts, responses, code, file paths, anything identifying

Free tier: nothing leaves your machine. Everything runs locally.

## Pricing

| Tier | Price | What you get |
|------|-------|-------------|
| **Free** | $0 forever | Full proxy, dashboard, smart routing, policy engine |
| **Contributor** | $0 forever | Share anonymized data, get mesh-enhanced routing |
| **Pro** | $25/mo | Analytics, alerts, team features, private mesh |

## Links

- **Website:** [relayplane.com](https://relayplane.com)
- **Docs:** [relayplane.com/docs](https://relayplane.com/docs)
- **ClawHub:** [clawhub.com/skills/relayplane](https://clawhub.com/skills/relayplane)

## License

MIT — free forever, self-host, fork, do whatever you want.
