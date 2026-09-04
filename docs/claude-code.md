# Claude Code integration

## Auto-start with Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "relayplane ensure-running"
          }
        ]
      }
    ]
  }
}
```

RelayPlane will start automatically when Claude Code opens. If it's already running (multiple sessions), the hook exits immediately. No duplicate processes.

## How it works

RelayPlane is a local HTTP proxy. You point Claude Code at `localhost:4100` by setting `ANTHROPIC_BASE_URL`. The proxy:

1. **Intercepts** your LLM API requests
2. **Classifies** the task using heuristics (token count, prompt patterns, keyword matching, no LLM calls)
3. **Routes** to the configured model based on classification and your routing rules (or passes through to the original model by default)
4. **Forwards** the request directly to the LLM provider (your prompts go straight to the provider, not through RelayPlane servers)
5. **Records** token counts, latency, and cost locally for your dashboard

**Default behavior is passthrough**, requests go to whatever model your agent requested. Routing (cascade, complexity-based) is configurable and must be explicitly enabled.

## Auth passthrough (Claude Max users)

If you use a Claude Max subscription (tokens starting with `sk-ant-oat*`), the proxy handles them correctly via the `x-api-key` header. No special configuration needed. The proxy also forwards `user-agent` and `x-app` headers required by Anthropic for subscription validation.

**Important:** All Anthropic token types (`sk-ant-api*` and `sk-ant-oat*`) are sent via `x-api-key`. The proxy does not use `Authorization: Bearer` for Anthropic requests.

For hybrid auth (MAX token for expensive models, standard key for cheap ones), see [Configuration reference](configuration.md#hybrid-auth).
