## Context

The proxy (`src/standalone-proxy.ts`) already has: the native-delegate resolver
`resolveNativeDelegate(model)` → `{url, token, model}` (per-vendor `baseUrl` +
`apiKeyEnv` + `modelMap`/`stripVendor`); the resilient `delegateFetch` (a dedicated
undici `Agent` with a 60s connect timeout + connection-only bounded retry); an
OpenAI-compatible forwarder pattern (`forwardToOpenAICompatible`); and a generic
upstream SSE reader (`pipeOpenAIStream`). It does **not** have any `/v1/responses`
surface or any Responses↔Chat conversion.

Codex CLI 0.135.0 custom providers must use `wire_api = "responses"`; no
third-party vendor implements the Responses API, but all of them implement OpenAI
`/chat/completions`. So the proxy must own the Responses⇄Chat bridge and forward the
middle hop in OpenAI format.

## Goals / Non-Goals

**Goals:**
- Add `/v1/responses` so Codex subagents can route to the existing delegate vendors.
- Forward in OpenAI format end-to-end on this path — no Anthropic body.
- Reuse the existing reliability layer (`delegateFetch`) and per-vendor keys.
- Leave the Claude Code `/v1/messages` delegate path byte-for-byte unchanged.

**Non-Goals:**
- No `responses.store` / server-side conversation state, reasoning items, or
  built-in tools — stateless function-calling Responses only (sufficient for
  subagent turns).
- No change to routing decisions, auth, or telemetry semantics beyond logging the
  new path through the existing `logRequest`.
- MiniMax's OpenAI endpoint is left unconfigured until verified; it falls back to
  Anthropic. Not a blocker for this change.

## Decisions

1. **Add `openaiBaseUrl` to `NativeDelegateProvider`; extend the resolver return
   with `openaiUrl`.** This keeps the Anthropic `url` (used by `/v1/messages`)
   untouched and additive — existing callers ignore the new optional field. A
   provider without `openaiBaseUrl` simply has `openaiUrl === undefined`, which the
   `/v1/responses` guard treats as "not supported here" (Anthropic fallback).

2. **One thin OpenAI forwarder, `forwardDelegateOpenAIChat(request, delegate,
   stream)`.** Models on `forwardToOpenAICompatible` but posts to
   `${delegate.openaiUrl}/chat/completions` with the per-vendor token via
   `delegateFetch` (not plain `fetch`) — BytePlus/MiniMax connects are slow and need
   the extended dispatcher. Returns the vendor Response verbatim.

3. **`/v1/responses` is a self-contained route**, registered just before the
   `/v1/chat/completions` guard. It does not reuse the full chat routing machinery
   (model-override/alias/cost-routing) because Codex always sends an explicit
   delegate slug; keeping it isolated bounds risk and keeps the Claude Code path
   untouched. It: parses the body → `responsesToChatRequest` → `resolveNativeDelegate`
   guard → `forwardDelegateOpenAIChat` → `chatResponseToResponses` (non-stream) or
   the SSE event mapper (stream).

4. **Responses⇄Chat mapping is intra-OpenAI-family and lossless for tools.**
   `function_call`/`function_call_output` ↔ `tool_calls`/`tool` messages keyed by
   `call_id`; `input_text`/`output_text` parts ↔ chat text; `max_output_tokens` ↔
   `max_tokens`. Streaming maps chat `delta.content` → `response.output_text.delta`
   and chat `delta.tool_calls` → `response.function_call_arguments.delta`, bracketed
   by `response.created` … `response.completed`.

5. **Optionally wire delegates into `/v1/chat/completions` too** (same
   `forwardDelegateOpenAIChat`), giving any OpenAI client direct delegate access and
   sharing the forwarder. Lower priority than the Responses route.

6. **Test on a separate port (4101).** Rebuilt `dist/` does not hot-reload, so the
   existing 4100 process keeps serving Claude Code on the old code while a second
   process on 4101 runs the new build for Codex testing. Config additions
   (`openaiBaseUrl`) are ignored by the old process.
