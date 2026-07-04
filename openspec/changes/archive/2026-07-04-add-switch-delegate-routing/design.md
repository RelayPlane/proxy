## Context

`resolveNativeDelegate(model)` (`src/standalone-proxy.ts:1809`) is a pure function:
it splits a `vendor/model` slug, looks the vendor up in `cfg.providers`, applies
`modelMap`/`stripVendor`, and returns `{ url, openaiUrl?, token, model }` — or
`null`. It already reserves `anthropic` (line 1816) as a prefix that never
delegates. It is called at four sites: the Anthropic `/v1/messages` path (1963),
estimate (6126), `/v1/responses` (7028), and `/v1/chat/completions` (7157).

Forwarding is done by `delegateFetch(url, init)` (1923), a bounded retry that
retries ONLY connection-level failures (`isDelegateConnError`, 1903) and never
retries a returned HTTP response — this is what protects the token plan from a
double-charge. There is no concept of a pool or of trying a second endpoint after a
non-2xx.

## Goals / Non-Goals

**Goals:**
- A `switch/<name>` slug that fronts an ordered pool of existing delegate members.
- Automatic failover: skip a member that fails to connect or returns 429/5xx, land
  on the first healthy member.
- Reuse `resolveNativeDelegate` per member so all existing mapping/keys apply.
- A selection seam so round_robin/weighted/health can be added later without
  reworking the forward loop.
- Leave single-slug (`vendor/model`) behavior and the Claude Code path unchanged.

**Non-Goals:**
- No round_robin/weighted/health *implementation* in this change — only the
  `selectOrder` seam and the failover strategy. Other strategies fall back to config
  order for now.
- No mid-stream failover. Once the first SSE byte is flushed, the member is
  committed.
- No cross-request health memory or circuit-breaking (that is the future `health`
  strategy).
- No new telemetry schema; the winning member logs through the existing `logRequest`
  exactly as a direct slug would.

## Decisions

1. **`switch` is a reserved vendor prefix, resolved to a list.** In
   `resolveNativeDelegate`, when `vendor === 'switch'`, look up
   `cfg.switch?.[name]`; if absent or empty → `null` (unknown switch behaves like an
   unresolvable slug). To avoid changing the pure return type of the existing
   function (four callers), add a sibling `resolveDelegateCandidates(model):
   Delegate[]` that returns `[single]` for a normal slug and the ordered, resolved,
   non-null member list for a `switch/*` slug. `resolveNativeDelegate` stays as the
   "first candidate" convenience (`resolveDelegateCandidates(model)[0] ?? null`) so
   existing callers that only need one delegate are untouched.

2. **`selectOrder(group, state)` returns the ordered member slugs to try.** For
   `strategy: 'failover'` (and the default when unset) it returns `group.members`
   verbatim — priority *is* array order. `round_robin` would rotate a per-group
   counter, `weighted` would bias by `group.weights`, `health` would sort by a
   rolling success window; those return the config order for now (documented stub).
   Each returned slug is passed through `resolveNativeDelegate`; unresolvable members
   (missing key/provider) are dropped, not fatal.

3. **A single failover wrapper guards all three forward paths.** Factor the
   "try candidates in order until one yields a usable response" loop into one helper
   used by `/v1/messages`, `/v1/responses`, and `/v1/chat/completions`. The helper
   takes the candidate list and a per-candidate `attempt(delegate) => Promise<Response>`
   thunk (each path supplies its own forward: `delegateFetch` to the Anthropic `url`,
   or `forwardDelegateOpenAIChat` to `openaiUrl`). It advances to the next candidate
   when `attempt` throws a connection error OR resolves to a `Response` whose status
   is 429 or ≥500; it returns the first `Response` that is 2xx or a non-retryable 4xx
   (a real client error should surface, not mask, so we do not burn the pool on a
   bad request). If every candidate is exhausted, the last error/Response is
   surfaced.

4. **Streaming failover is connect-time only.** For `stream: true`, a candidate's
   failure is only actionable before its body is piped to the client. The wrapper
   inspects the upstream `Response` status *before* the handler starts streaming the
   body; once streaming begins the member is committed. This matches how
   `delegateFetch` already works (it returns the `Response` before the body is read),
   so the wrapper decides failover on `response.status` alone and never mid-stream.

5. **429/5xx-advances-member is scoped to `switch/*` only.** For a single
   `vendor/model` slug, the candidate list has length 1, the failover wrapper has
   nothing to advance to, and behavior is byte-for-byte the existing single
   `delegateFetch` call — strict connection-only retry, HTTP surfaced once, no
   double-charge. The relaxation (advancing on 429/5xx) only ever engages when a
   switch group has a *next* member, and each next member is a different vendor with
   a different key, so it is not a re-charge of the same plan.

6. **Bounded, no cycling.** The wrapper tries each candidate at most once per
   request. A group whose members all fail returns the last failure promptly rather
   than looping — no exponential blow-up on a fully-down pool.

7. **Config shape mirrors `providers`.** `nativeDelegate.switch` is a map of
   `name → { strategy?, members: string[], weights?: number[] }`. `members` are
   ordinary delegate slugs (`deepseek/deepseek-pro`, `byteplus/deepseek-pro`, …).
   `strategy` defaults to `failover`. The config watcher already re-reads
   `nativeDelegateConfig`, so groups reload on the same path as providers.
