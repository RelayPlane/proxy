# CLI Reference

```
relayplane [command] [options]
```

| Command | Description |
|---------|-------------|
| `(default)` / `start` | Start the proxy server |
| `init` | Initialize config and show setup instructions |
| `status` | Show proxy status and cloud sync info |
| `login` | Log in to RelayPlane (device OAuth flow) |
| `logout` | Clear stored credentials |
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
| `watch` | Live terminal cost ticker |

**Server options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4100` | Port to listen on |
| `--host <s>` | `127.0.0.1` | Host to bind to |
| `--offline` | - | No network calls except LLM endpoints |
| `--audit` | - | Show telemetry payloads before sending |
| `-v, --verbose` | - | Verbose logging |

## Live cost ticker

For a terminal-based view of today's spend in real time, use the `watch` subcommand:

```bash
relayplane watch
# or against a non-default proxy:
relayplane watch --proxy http://localhost:4101 --interval 1000
```

It polls the proxy's `/v1/stats/live` endpoint and renders today's spend, the current session, model distribution, and the last 5 requests, redrawing in place. Works without cloud login.

## API Endpoints

The dashboard is powered by JSON endpoints you can use directly:

| Endpoint | Description |
|----------|-------------|
| `GET /v1/telemetry/stats` | Aggregate statistics; includes `today.{totalCost,totalRequests,avgLatencyMs,latencyP95,errorRate,cacheHitRate}` plus top-level `latencyP95` and `cacheHitRate` over the days window |
| `GET /v1/telemetry/runs?limit=N` | Recent request history; each record includes `routing_rule` and `routing_reason` (nullable when unset) |
| `GET /v1/telemetry/spend-by-hour?day=YYYY-MM-DD` | Hourly USD spend buckets for a UTC day (24 entries, `{hour, usd}`) |
| `GET /v1/telemetry/providers?days=N` | Per-provider rollup over the days window: `{provider, share, p95Ms, rpm, health, primary, note}` |
| `GET /v1/telemetry/savings` | Cost savings from smart routing |
| `GET /v1/telemetry/health` | Provider health and cooldown status |
| `GET /v1/sessions` | Recent sessions; each record includes `total_savings_usd` |
| `GET /v1/telemetry/breakdown?dimension=model\|agent&window=1h\|24h\|7d\|30d` | Cost breakdown rows by model or agent for the given window. Unknown windows fall back to 24h. |
