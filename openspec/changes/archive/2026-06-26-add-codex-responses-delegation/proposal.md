## Why

RelayPlane today fronts **Claude Code**: Claude drives, and `.claude/agents/*.md`
subagents route through the proxy's Anthropic-shaped `/v1/messages` to cheap
native-delegate vendors (`deepseek`, `byteplus`, `minimax`, `zai`). We want the
**same flow for Codex CLI** — the GPT Codex orchestrator stays on its own auth, and
its subagents route through RelayPlane to those same delegate models.

Two facts block this today:

- **Codex 0.135.0 removed `wire_api = "chat"`** (Feb 2026). Custom providers must
  speak the OpenAI **Responses API** (`POST /v1/responses`). RelayPlane exposes
  `/v1/chat/completions` and `/v1/messages` but **no `/v1/responses`** — so Codex
  cannot talk to it at all.
- The native-delegate path only knows how to build an **Anthropic** body. Every
  delegate vendor is natively OpenAI-compatible at `/chat/completions`, so detouring
  Codex's OpenAI request through Anthropic is a needless, lossy hop.

The only unavoidable translation is **Responses ⇄ Chat Completions** — an
intra-OpenAI-family reshape. Given that bridge, the middle hop stays pure OpenAI:
forward to each vendor's OpenAI `/chat/completions` with **no Anthropic body**.

## What Changes

- **New `/v1/responses` endpoint** translating OpenAI Responses ⇄ Chat Completions
  for native-delegate models, non-streaming and streaming, with tool round-trips.
- **OpenAI-native delegation**: when a provider declares an OpenAI-compatible base
  (`openaiBaseUrl`), OpenAI-surface delegate requests forward there in OpenAI chat
  format via the existing resilient `delegateFetch` — `buildAnthropicBody` is not
  used. Providers without `openaiBaseUrl` keep using the existing Anthropic path.
- The Anthropic `/v1/messages` delegate path that serves Claude Code is unchanged.

## Capabilities

### New Capabilities
- `responses-api`: a `POST /v1/responses` surface that serves native-delegate
  models by reshaping OpenAI Responses ⇄ Chat Completions (stateless,
  function-calling), non-streaming and streaming.
- `openai-native-delegation`: forwarding OpenAI-surface delegate requests directly
  to a vendor's OpenAI `/chat/completions` (no Anthropic body), with graceful
  fallback to the Anthropic path and connection-only retry.

### Modified Capabilities
<!-- No existing OpenSpec capabilities cover proxy routing; all behavior here is net-new. -->

## Impact

- **Code:** `src/standalone-proxy.ts` — new `/v1/responses` route; new
  `responsesToChatRequest` / `chatResponseToResponses` converters and a chat-SSE →
  Responses-event stream mapper; new `forwardDelegateOpenAIChat` helper (reuses
  `delegateFetch`); `NativeDelegateProvider.openaiBaseUrl` field and an extended
  `resolveNativeDelegate` return (`openaiUrl`).
- **Config:** `~/.relayplane/config.json` gains a per-provider `openaiBaseUrl`;
  `~/.codex/config.toml` gains a `relayplane` model provider; new committed
  `.codex/agents/*.toml` subagents.
- **No change** to auth, the Anthropic `/v1/messages` hot path, retry semantics
  (connection-only, no double-charge), or where provider keys live
  (`~/.relayplane/.env`).
