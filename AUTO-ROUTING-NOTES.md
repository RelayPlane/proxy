# Auto-Routing Implementation Notes

*Created: 2026-02-23 21:39 UTC*
*Status: In progress — passthrough mode while fixing*

## Goal
When `routing.mode: "auto"` in `~/.relayplane/config.json`, the proxy classifies every request by complexity and routes to the cheapest model that can handle it. The user never changes their model config — they just flip the mode.

## Architecture

```
User's tool → sends "claude-opus-4-6" → RelayPlane proxy (localhost:4100)
  → Classifier analyzes last user message
  → simple → haiku | moderate → sonnet | complex → opus
  → Forward to Anthropic with correct auth
```

## What Works (Committed)
- `3f4804b` — Classifier only looks at last user message, not system prompts
- `85cc517` — When `routing.mode === "auto"`, classify ALL requests (not just `relayplane:auto`)
- Config dashboard page at `/dashboard/config`
- All dated model IDs removed (use `claude-haiku-4-5`, not `claude-haiku-4-5-20250514`)

## The Auth Problem

### Background
Anthropic has two auth methods:
1. **API keys** (`sk-ant-api03-*`) — sent via `x-api-key` header. Works for ALL models.
2. **OAuth/Max tokens** (`sk-ant-oat*`) — sent via `Authorization: Bearer` header. Works for Opus and Sonnet. **Does NOT work for Haiku.**

### The Scenario
OpenClaw Max plan users send OAuth tokens. When the proxy reroutes from Opus to Haiku:
- Incoming: OAuth token (`sk-ant-oat*`) via `x-api-key` header
- Haiku rejects OAuth: `"OAuth authentication is currently not supported."`
- Need: regular API key (`sk-ant-api03-*`) from `ANTHROPIC_API_KEY` env var

### What We Tried (and broke)
1. **Always use env key when OAuth detected** — Too broad. Routed Opus/Sonnet through API key too, burning pay-as-you-go credits instead of using Max plan.
2. **Convert OAuth in x-api-key to Authorization: Bearer** — Didn't help, Haiku rejects OAuth regardless of header.

### The Correct Fix (TODO)
Model-aware auth selection in `buildAnthropicHeadersWithAuth()`:

```
IF incoming auth is OAuth (sk-ant-oat*):
  IF target model supports OAuth (opus, sonnet):
    → Use OAuth (passthrough incoming auth)
  ELSE (haiku, older models):
    → Use ANTHROPIC_API_KEY env var
    → If no env key available, return error explaining OAuth limitation
ELSE (regular API key):
  → Use as-is for all models
```

### Models That Support OAuth
As of Feb 2026 (verify periodically):
- ✅ claude-opus-4-6
- ✅ claude-sonnet-4-6
- ❌ claude-haiku-4-5
- ❓ claude-3-5-sonnet-latest (untested)
- ❓ claude-3-5-haiku (untested)

### Key Code Locations
- `buildAnthropicHeadersWithAuth()` — Where auth headers are constructed (~line 910)
- `getAuthForModel()` — Determines which key to use (~line 880)
- `useAnthropicEnvKey` — Set at ~line 2904, controls whether env key is available
- `forwardNativeAnthropicRequest()` — Final HTTP call to Anthropic (~line 841)

## Config File Locations
- `~/.relayplane/config.json` — Proxy routing config
- `~/.openclaw/openclaw.json` — OpenClaw global config (anthropic provider → proxy baseUrl)
- `~/.openclaw/agents/main/config.json` — Agent-level model override (**overrides global!**)

## Gotchas Discovered

### 1. Agent config overrides global
`~/.openclaw/agents/{id}/config.json` has a `model` field that takes priority over `openclaw.json` defaults. Must update both when changing default model.

### 2. Global npm install doesn't auto-rebuild
`npm install -g` from a tarball uses whatever's in `dist/`. Must `rm -rf dist && npm run build` before `npm pack`.

### 3. Proxy restart race condition
Killing the proxy on port 4100 while the agent is using it can kill the agent's own connection. Use `fuser -k 4100/tcp` and restart in background.

### 4. Classifier sees system prompts
The complexity classifier was analyzing the full message payload including system prompts (AGENTS.md, SOUL.md, MEMORY.md). For agent workloads these are always huge, making everything "complex." Fixed: only classify the last user message.

### 5. Dated model IDs
Anthropic API accepts `claude-haiku-4-5` but NOT `claude-haiku-4-5-20250514`. The dated format is for Bedrock/Vertex. All aliases in the proxy were using dated IDs — caused 404s.

### 6. OAuth ≠ API key for model coverage
Max plan OAuth tokens don't work for all models. This isn't documented prominently by Anthropic. The error is: `"OAuth authentication is currently not supported."` — unhelpful because it doesn't say WHICH models are unsupported.

## Testing Plan (Before Deploying Again)

### Unit Tests Needed
1. `buildAnthropicHeadersWithAuth` with OAuth + haiku → should use env API key
2. `buildAnthropicHeadersWithAuth` with OAuth + opus → should use OAuth passthrough
3. `buildAnthropicHeadersWithAuth` with API key + any model → should use API key
4. `buildAnthropicHeadersWithAuth` with OAuth + haiku + NO env key → should return clear error
5. Auto-routing mode: request for opus, classified as simple → routes to haiku with correct auth

### Integration Test
```bash
# Start proxy with both keys
ANTHROPIC_API_KEY="sk-ant-api03-..." relayplane proxy start

# Send request with OAuth token, should route simple to haiku using API key
curl http://localhost:4100/v1/messages \
  -H "x-api-key: sk-ant-oat-..." \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"say hi"}]}'

# Verify: response model should be claude-haiku-4-5
# Verify: x-relayplane-routed-model header shows haiku
# Verify: Anthropic console shows haiku, NOT opus
```

## User-Facing Documentation (for README)

### Quick Start (Auto-Routing)
```bash
# 1. Install
npm install -g @relayplane/proxy

# 2. Set your API key (needed for Haiku routing with Max plan)
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# 3. Start the proxy
relayplane proxy start

# 4. Point your tool at the proxy
export ANTHROPIC_BASE_URL=http://localhost:4100

# 5. Enable auto-routing
# Edit ~/.relayplane/config.json:
# "routing": { "mode": "auto" }
```

### Auth Requirements by Setup
| Your Auth | Simple (Haiku) | Moderate (Sonnet) | Complex (Opus) |
|-----------|---------------|-------------------|----------------|
| API key only | ✅ API key | ✅ API key | ✅ API key |
| Max/OAuth only | ❌ Not supported | ✅ OAuth | ✅ OAuth |
| Max/OAuth + API key | ✅ API key | ✅ OAuth | ✅ OAuth |

**Max plan users:** Set `ANTHROPIC_API_KEY` for Haiku routing. Without it, simple tasks will fall back to Sonnet.
