---
name: relayplane-qa
description: QA RelayPlane's per-vendor native delegation — verify Claude Code subagents on minimax/glm slugs route to the right Anthropic-compatible provider with the right key, never leaking the Claude token. Use when validating nativeDelegate changes or the Claude Code + RelayPlane multi-provider subagent setup.
---

# RelayPlane QA — per-vendor native delegation

Validates that a Claude Code subagent set to a `vendor/model` slug (e.g.
`zai/glm-5.2`, `minimax/MiniMax-M1`) is served by that vendor's
Anthropic-compatible endpoint, with that vendor's own key, while `claude-*`
models stay native to Anthropic — and that the user's Claude OAuth/subscription
token is **never** forwarded to a delegate.

Implementation under test: `resolveNativeDelegate()` + `NativeDelegateConfig`
in `src/standalone-proxy.ts`. Connection model: Claude Code →
`ANTHROPIC_BASE_URL=http://localhost:4100` → proxy → vendor.

## Setup being validated

> ⚠️ **First-run gotcha:** on a fresh config with no `ANTHROPIC_API_KEY`, the
> proxy's auto-config (standalone-proxy.ts ~3829) rewrites `routing.mode` to
> `complexity` unless `first_run_complete: true` is present — and any non-
> `standard` mode silently bypasses native delegation. Ensure the live config
> keeps `routing.mode: "standard"` AND `first_run_complete: true`.

`~/.relayplane/config.json` (`routing.mode` MUST be `standard`/passthrough — not
`auto`/`complexity`/`cascade`, or delegation is bypassed at standalone-proxy.ts:5397):

```json
{
  "routing": { "mode": "standard" },
  "nativeDelegate": { "providers": {
    "zai":     { "baseUrl": "https://api.z.ai/api/anthropic/v1/messages", "apiKeyEnv": "ZAI_API_KEY", "stripVendor": true },
    "minimax": { "baseUrl": "<MiniMax anthropic endpoint>",              "apiKeyEnv": "MINIMAX_API_KEY" }
  } }
}
```

Subagents `.claude/agents/{glm,minimax}.md` carry `model: zai/glm-5.2` /
`model: minimax/MiniMax-M1`. Proxy process env: `ZAI_API_KEY`, `MINIMAX_API_KEY`.

## Layers

### Layer 0 — static (seconds, no network)
- config is valid JSON and `routing.mode == "standard"`.
- subagent `model:` slugs are exactly `zai/glm-5.2` / `minimax/MiniMax-M1`.
- `ZAI_API_KEY`, `MINIMAX_API_KEY`, `ANTHROPIC_BASE_URL` are set.

### Layer 1 + 3 — automated offline harness (no real keys) ← run this
Boots the real proxy against two mock upstreams in a sandboxed
(`RELAYPLANE_HOME_OVERRIDE`/`RELAYPLANE_CONFIG_PATH`) dir and asserts the matrix:

```
npm run build            # ensure dist reflects src
node .claude/skills/relayplane-qa/scripts/qa-native-delegate.mjs
```

Covers: T1 GLM→z.ai (vendor stripped to `glm-5.2`, ZAI key, no token leak),
T2 MiniMax→MiniMax (full slug, MiniMax key), T3 `claude-*` not delegated,
T4 streaming SSE delegated + piped, T5 fail-closed when key unset (no silent
OpenRouter fallback). Exit 0 = all passed.

### Layer 2 — live, real keys (manual)
Real config with real endpoints + `ZAI_API_KEY`/`MINIMAX_API_KEY`, `relayplane
start`, `export ANTHROPIC_BASE_URL=http://localhost:4100`. For each of
`zai/glm-5.2` and `minimax/<id>`, run a non-streaming and a `stream:true`
`/v1/messages` call (prompt "reply OK") and assert HTTP 200 + non-empty
completion + `usage`. Then drive each subagent from a Claude Code session and
confirm via the proxy routing log / provider dashboard that three distinct
providers answered in one session, with `claude-*` main turns still on Anthropic.

Needs from the operator: exact MiniMax Anthropic endpoint URL and each
provider's exact model id (z.ai may want `glm-4.6` vs `glm-5.2`); use
`stripVendor`/`modelMap` to match the required outgoing id.

## Known product gaps surfaced by QA (out of scope for delegation, document don't fix here)
- Response cache key (`src/response-cache.ts` `computeCacheKey`) omits `stream`,
  so a streaming request can be served a prior non-streaming cached body.
- `DEFAULTS.cacheDir` uses `os.homedir()` directly and ignores
  `RELAYPLANE_HOME_OVERRIDE`, unlike config/data dirs — tests must disable the
  cache (`cache.enabled:false`) or they read/write the operator's real cache.

## Signal
Strongest "which provider answered" signal = the `model` field echoed in the
response (z.ai → `glm-…`, MiniMax → its id, Anthropic → `claude-…`), plus the
proxy routing log and each provider's usage dashboard.
