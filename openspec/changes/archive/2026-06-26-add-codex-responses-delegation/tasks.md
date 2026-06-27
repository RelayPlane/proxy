## 1. Config schema + resolver (capability: openai-native-delegation)

- [x] 1.1 Add an optional `openaiBaseUrl?: string` field to the
      `NativeDelegateProvider` interface in `src/standalone-proxy.ts` (OpenAI-compatible
      base, no trailing `/chat/completions`)
- [x] 1.2 Extend `resolveNativeDelegate()` to surface it: return
      `{ url, openaiUrl, token, model }` (Anthropic `url` unchanged; `openaiUrl` new and
      optional so existing `/v1/messages` callers are unaffected)
- [x] 1.3 Add per-provider `openaiBaseUrl` to `~/.relayplane/config.json` for
      `deepseek`, `byteplus`, `zai`; leave `minimax` without one (Anthropic fallback)

## 2. OpenAI delegate forwarder (capability: openai-native-delegation)

- [x] 2.1 Add `forwardDelegateOpenAIChat(request, delegate, stream)` near
      `forwardToOpenAICompatible`, POSTing to `${delegate.openaiUrl}/chat/completions`
      with `Authorization: Bearer <delegate.token>` via the resilient `delegateFetch`
      (NOT plain `fetch`); body stays OpenAI chat with `model: delegate.model`
- [x] 2.2 Confirm retry stays connection-only: a returned HTTP 4xx/5xx is surfaced to
      the caller, never retried (reuse `isDelegateConnError` semantics in `delegateFetch`)

## 3. Responses surface + converters (capability: responses-api)

- [x] 3.1 Add `responsesToChatRequest(body)`: `instructions` → leading system message;
      `input` string → user message; `input` array items → chat messages
      (`message`/`input_text`/`output_text` → text, `function_call` → assistant
      `tool_calls`, `function_call_output` → `tool` message keyed by `call_id`);
      `max_output_tokens` → `max_tokens`; map `tools`/`tool_choice`
- [x] 3.2 Add `chatResponseToResponses(chat)`: build `output[]` with a `message` item
      (`content[].type = output_text`) plus one `function_call` item per `tool_calls`
      entry; `usage.input_tokens/output_tokens` from `prompt_tokens/completion_tokens`;
      `status:"completed"`; include convenience `output_text`
- [x] 3.3 Add a chat-SSE → Responses-event stream mapper: `response.created` →
      `response.output_item.added` → `response.content_part.added` →
      `response.output_text.delta` (per chunk) → `…done` → `response.completed`;
      `tool_calls` deltas → `function_call` item + `response.function_call_arguments.delta`/`.done`
- [x] 3.4 Register `POST /v1/responses` route: parse body → `responsesToChatRequest`
      → `resolveNativeDelegate` guard (no delegate or no `openaiUrl` → `400`) →
      `forwardDelegateOpenAIChat` → non-stream `chatResponseToResponses` / stream mapper;
      malformed JSON → `400`
- [x] 3.5 Log the new path through the existing `logRequest` (reuse the `openrouter`
      reliability identity for accounting parity)

## 4. Optional parity (capability: openai-native-delegation)

- [x] 4.1 In `/v1/chat/completions`, if `resolveNativeDelegate(model)?.openaiUrl`,
      branch to `forwardDelegateOpenAIChat` (non-stream + stream) and return its body
      directly, bypassing the Anthropic provider switch

## 5. Build, run on test port, and wire Codex

- [x] 5.1 `npm run build`; start a SECOND proxy process on port 4101 from `dist/`
      with `~/.relayplane/.env` sourced; leave the 4100 process untouched
- [x] 5.2 Add `[model_providers.relayplane]` (`base_url = http://127.0.0.1:4101/v1`,
      `wire_api = "responses"`, `requires_openai_auth = false`) to `~/.codex/config.toml`
      + trust the repo; export a dummy `RELAYPLANE_KEY`
- [x] 5.3 Create the six `.codex/agents/*.toml` subagents mirroring `.claude/agents/*.md`,
      each with explicit `model` + `model_provider = "relayplane"`

## 6. Verification

- [x] 6.1 `openspec validate add-codex-responses-delegation --strict` passes
- [x] 6.2 Non-stream probe to `127.0.0.1:4101/v1/responses` for `deepseek/deepseek-pro`,
      `zai/glm-5.2` returns a Responses object with `output[].content[].text`
- [x] 6.3 Streaming probe (`stream:true`) emits ordered
      `response.created … output_text.delta … response.completed`
- [x] 6.4 MiniMax probed; left on Anthropic fallback if its OpenAI path differs
- [x] 6.5 End-to-end: `codex` orchestrator delegates to a `deepseek-pro` subagent;
      `~/.relayplane/proxy-4101.log` records the delegate request
- [x] 6.6 Regression: a `.claude/agents` subagent over the untouched 4100 process still
      works; `127.0.0.1:4100/health` steady
- [x] 6.7 `openspec archive add-codex-responses-delegation` once all above pass
