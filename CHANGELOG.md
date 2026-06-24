# Changelog

## Fork: `relayplane cc` Claude Code setup command (phucpnt)

**One-command setup + lifecycle for Claude Code + GLM/MiniMax subagents.**

```
relayplane cc up      [--global | --project [path]] [--foreground]
relayplane cc down    [--global | --project [path]]
relayplane cc status
```

`up` wires three things and starts the proxy as a background daemon:
- `~/.relayplane/config.json` — nativeDelegate providers (zai + minimax),
  `routing.mode=standard`, `first_run_complete=true`, cache off.
- `<scope>/.claude/settings.json` — `env.ANTHROPIC_BASE_URL` → the proxy.
- `<scope>/.claude/agents/{glm,minimax}.md` — the delegating subagents.

`--global` wires `~/.claude` for all projects; `--project` scopes the wiring
and agents to one repo (the proxy/config stay global — one process, one port).

Auth: the main agent uses Claude Code's normal OAuth session (passthrough). The
command never sets `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so OAuth is left
intact; if a turn fails auth the user simply re-logs-in Claude Code. Provider
keys are prompted (hidden) and stored only in `~/.relayplane/.env` (chmod 600),
injected into the proxy process on start. `down` un-wires and stops the daemon;
`status` reports proxy health and what is wired where.

Implementation: `src/cc-setup.ts` + a `cc` branch in `src/cli.ts`.

---

## Fork: per-vendor native delegation (phucpnt)

**Per-vendor routing for native delegation.** The `nativeDelegate` section now
accepts a `providers` map keyed by the slug's vendor prefix, so distinct
`vendor/model` slugs route to distinct Anthropic-compatible endpoints in the
same proxy — e.g. GLM direct to z.ai **and** MiniMax direct, simultaneously.

- A matching `providers[vendor]` entry takes precedence; vendors with no entry
  fall back to the single-delegate (OpenRouter) default — fully backward
  compatible with existing config.
- `stripVendor: true` drops the `vendor/` prefix so a provider receives a bare
  model name (e.g. `zai/glm-4.6` → `glm-4.6` for z.ai).
- `modelMap` allows explicit incoming-slug → outgoing-model rewrites.
- Fail-closed: if a provider entry's key env var is unset, the request is not
  silently leaked to the OpenRouter fallback.

```json
{
  "nativeDelegate": {
    "providers": {
      "zai":     { "baseUrl": "https://api.z.ai/api/anthropic/v1/messages",   "apiKeyEnv": "ZAI_API_KEY", "stripVendor": true },
      "minimax": { "baseUrl": "https://api.minimax.io/anthropic/v1/messages", "apiKeyEnv": "MINIMAX_API_KEY" }
    }
  }
}
```

Implementation: extended `resolveNativeDelegate()` + `NativeDelegateConfig`
(new `NativeDelegateProvider` type) in `src/standalone-proxy.ts`. Call sites
unchanged.

---

## Fork: native-protocol delegation (phucpnt)

**Native /v1/messages delegation to Anthropic-compatible providers.** Forward
native Claude Code requests for non-Anthropic `vendor/model` slugs (e.g.
`minimax/minimax-m3`) to a third-party endpoint that speaks the Anthropic
Messages API (OpenRouter by default). The request body is forwarded verbatim —
no Anthropic↔OpenAI translation — so a Claude Code subagent configured with
`model: minimax/minimax-m3` is served natively by MiniMax while `claude-*`
models continue to Anthropic.

- Works with no config: any `vendor/model` (vendor ≠ `anthropic`) or
  `openrouter/...` slug routes to OpenRouter using `OPENROUTER_API_KEY`.
- The Claude subscription/OAuth token is **never** forwarded to the delegate;
  the delegate is authenticated only with its own provider key.
- Streaming (SSE) and non-streaming both supported.
- Configurable via the optional `nativeDelegate` section (see below) to target
  MiniMax-direct, DeepSeek, or any other Anthropic-compatible endpoint.

```json
{
  "nativeDelegate": {
    "enabled": true,
    "baseUrl": "https://openrouter.ai/api/v1/messages",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "stripPrefix": "openrouter/"
  }
}
```

Implementation: `resolveNativeDelegate()` + a 3-line branch in
`forwardNativeAnthropicRequest()` and the passthrough gate in
`src/standalone-proxy.ts`.

---

## v1.9.0 (2026-04-02)

### Features

**Multi-account token pooling** (`packages/proxy`) — transparently pool multiple Anthropic API keys / Claude Max OAT tokens and select the best available one per request.

- **Auto-detect incoming tokens**: tokens sent by Claude Code, Cursor, or any client via `Authorization: Bearer` are registered in the pool automatically (priority 10). Zero config change required for single-account users.
- **Explicit config accounts**: add additional tokens under `providers.anthropic.accounts[]` in `~/.relayplane/config.json` (priority 0 by default = tried first). Perfect for users with 2+ Claude Max subscriptions.
- **Smart selection**: pool skips rate-limited tokens and proactively throttles at 90% of the known upstream RPM limit. Ties broken by fewest requests this minute.
- **Transparent 429 retry**: if the selected token receives a 429, the proxy immediately retries with the next available token. Accurate `retry-after` is returned to the client only when all tokens are exhausted.
- **Learn from headers**: `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, and `retry-after` headers are observed on every response to keep per-token rate-limit state fresh.
- **Status endpoint**: `GET /v1/token-pool/status` returns per-account label, priority, requests-this-minute, known RPM limit, and rate-limit expiry.
- **Dashboard widget**: new "Token Pool" collapsible section in the embedded dashboard shows live per-token status and a utilisation bar.

### Config example

```json
{
  "providers": {
    "anthropic": {
      "accounts": [
        { "label": "newmax", "apiKey": "sk-ant-oat01-...", "priority": 0 },
        { "label": "default", "apiKey": "sk-ant-oat01-...", "priority": 1 }
      ]
    }
  }
}
```

Backward compatible: single-token users (env var `ANTHROPIC_API_KEY` or incoming auth passthrough) see no behaviour change.

---

## v1.8.40 and earlier

See git log for prior release notes.
