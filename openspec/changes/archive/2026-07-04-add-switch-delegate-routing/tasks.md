## 1. Config schema + candidate resolver (capability: switch-delegate-routing)

- [x] 1.1 Add a `SwitchGroup` type (`strategy?: 'failover' | 'round_robin' | 'weighted' | 'health'`,
      `members: string[]`, `weights?: number[]`) and a `switch?: Record<string, SwitchGroup>`
      field on the native-delegate config type in `src/standalone-proxy.ts`
- [x] 1.2 Add `resolveDelegateCandidates(model): Delegate[]` — for a `switch/<name>`
      slug, look up `cfg.switch?.[name]`, run `selectOrder(group)`, resolve each member
      through the existing per-vendor logic, drop unresolvable members; for a normal
      `vendor/model` slug return the single resolved delegate (or `[]`)
- [x] 1.3 Reduce `resolveNativeDelegate(model)` to
      `resolveDelegateCandidates(model)[0] ?? null` so the four existing callers are
      byte-for-byte unaffected for non-switch slugs
- [x] 1.4 Add `selectOrder(group, state)`: return `group.members` for `failover`
      (and when `strategy` is unset); `round_robin`/`weighted`/`health` return config
      order for now with a `// TODO(strategy)` note

## 2. Failover forward wrapper (capability: switch-delegate-routing)

- [x] 2.1 Add `forwardWithFailover(candidates, attempt)` that tries candidates in
      order, where `attempt(delegate) => Promise<Response>` is supplied per call site;
      advance to the next candidate on a connection-level throw OR a returned status
      of 429 / ≥500; return the first 2xx or non-retryable 4xx `Response`; surface the
      last failure when candidates are exhausted
- [x] 2.2 Ensure the advance decision reads only `response.status` BEFORE the body is
      streamed (connect-time only), so a `stream:true` request never fails over
      mid-stream once bytes have been flushed
- [x] 2.3 Confirm a single-member candidate list (every non-switch slug) collapses to
      exactly one `attempt` with the existing `delegateFetch` semantics — no behavior
      change, no double-charge

## 3. Wire the three forward paths (capability: switch-delegate-routing)

- [x] 3.1 `/v1/messages` (`forwardNativeAnthropicRequest`): resolve candidates and
      forward through `forwardWithFailover`, each `attempt` posting the Anthropic body
      to `delegate.url` via `delegateFetch`
- [x] 3.2 `/v1/responses`: resolve candidates from `chatReq.model`; each `attempt`
      calls `forwardDelegateOpenAIChat(chatReq, delegate, stream)`; keep the existing
      `openaiUrl` guard per candidate (members without an OpenAI endpoint are skipped
      on this surface)
- [x] 3.3 `/v1/chat/completions`: same candidate resolution + `forwardWithFailover`
      when the requested model is a switch slug or a delegate with `openaiUrl`
- [x] 3.4 Log only the winning member through the existing `logRequest`; a failed
      member that was skipped is noted at `console.warn` level (like the existing
      connect-retry log) but not double-counted as a request

## 4. Delegate config

- [x] 4.1 Add a `nativeDelegate.switch` map to `~/.relayplane/config.json` with a
      `combine_1` group: `strategy: "failover"`,
      `members: ["deepseek/deepseek-pro", "byteplus/deepseek-pro"]`
- [x] 4.2 Restart the 4101 test process (sourcing `~/.relayplane/.env`) so the new
      config is loaded cleanly (watcher-inode caveat); leave 4100 untouched

## 5. Verification

- [x] 5.1 `openspec validate add-switch-delegate-routing --strict` passes
- [x] 5.2 Happy path: `POST 127.0.0.1:4101/v1/responses` `{model:"switch/combine_1"}`
      returns a Responses object served by the first member (`deepseek/deepseek-pro`);
      `proxy-4101.log` shows the winning member
- [x] 5.3 Failover: force the first member to fail (temporarily point it at a dead
      endpoint or a member known to 429) and confirm the request is served by the
      second member, with a single warn line for the skipped member
- [x] 5.4 Streaming: `{model:"switch/combine_1", stream:true}` emits an unbroken
      Responses event stream from one member; confirm no mid-stream switch occurs
- [x] 5.5 Regression: a plain `deepseek/deepseek-pro` (non-switch) request behaves
      exactly as before — connection-only retry, HTTP 4xx/5xx surfaced once, no
      double-charge; `127.0.0.1:4100/health` steady
- [x] 5.6 Unknown switch: `{model:"switch/nope"}` returns the same clear client error
      as any unresolvable delegate slug (no crash)
- [x] 5.7 `openspec archive add-switch-delegate-routing` once all above pass
