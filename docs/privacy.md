# Privacy

## Passthrough by default

RelayPlane forwards your own credentials and does not modify your traffic unless you turn routing on. Your prompts go directly to LLM providers, never through RelayPlane servers. All proxy execution is local.

## Per-request telemetry

Per-request telemetry (task type, model, token counts, latency, cost) is **off by default** as of v1.9.2. Only anonymous metadata is sent, never prompts or responses, and it stays off until you opt in:

```bash
relayplane telemetry on
relayplane telemetry off
relayplane telemetry status
```

When enabled, the proxy sends anonymized metadata to `api.relayplane.com`:

- **device_id** - Random anonymous hash (no PII)
- **task_type** - Heuristic classification label (e.g., "code_generation", "summarization")
- **model** - Which model was used
- **tokens_in/out** - Token counts
- **latency_ms** - Response time
- **cost_usd** - Estimated cost

**Never collected:** prompts, responses, file paths, or anything that could identify you or your project.

## Lifecycle pings

Separately from per-request telemetry, a minimal lifecycle ping (startup, dashboard-open) fires on new installs so we can see install and retention counts. It carries a device ID and an event label, never per-request data. Disable it independently:

```bash
relayplane lifecycle on
relayplane lifecycle off
```

CI and test runs never send lifecycle pings or telemetry; they are not installs.

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

## Osmosis mesh

Mesh (on by default) shares anonymized routing signals: model, tokens, cost, latency, success/fail, never prompts. Opt out: `relayplane mesh off`.

## Your keys stay yours

RelayPlane requires your own provider API keys. Your prompts go directly to LLM providers and are never proxied through RelayPlane servers. All proxy execution is local.
