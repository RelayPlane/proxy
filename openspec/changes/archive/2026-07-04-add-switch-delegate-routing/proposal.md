## Why

RelayPlane routes a subagent's `vendor/model` slug to exactly one native-delegate
provider. In practice the delegate vendors have very different reliability: measured
over the current proxy lifetime, `byteplus/deepseek-pro` fails ~28% of requests and
`byteplus/deepseek-flash` ~42% (AP-Southeast connect flakiness), while the
equivalent `deepseek/deepseek-pro` on the DeepSeek platform fails only ~1.6%. A
subagent pinned to a single flaky slug simply eats those failures.

There is no way today to say "use this pool of interchangeable models, and route
around whichever one is down." The user wants a virtual `switch/<name>` slug that
fronts an ordered pool (e.g. `["deepseek/deepseek-pro", "byteplus/deepseek-pro"]`)
and fails over between members automatically, so a subagent config names one stable
slug and the proxy handles vendor reliability.

## What Changes

- **New reserved `switch` vendor prefix.** A model slug `switch/<name>` resolves to a
  named group in config instead of a single provider. `switch` joins `anthropic` as
  a reserved prefix that `resolveNativeDelegate` treats specially.
- **Failover routing over an ordered member list.** The group's `members` are tried
  in order. The proxy advances to the next member on a connection-level failure OR
  an HTTP 429/5xx, and stops on the first member that returns 2xx (or a
  non-retryable 4xx). Members are resolved through the existing
  `resolveNativeDelegate`, so `modelMap`/`stripVendor`/per-vendor keys keep working.
- **A pluggable `selectOrder` seam.** Failover is the first (and default) strategy;
  the selection function is factored so `round_robin`/`weighted`/`health` can be
  added later without touching the forward loop.
- **Streaming-safe, bounded, scoped.** Failover happens only before the first
  response byte reaches the client (no mid-stream switch); the member list is tried
  at most once (no infinite cycling); and the 429/5xx-advances-member behavior is
  scoped to `switch/*` only — plain `vendor/model` slugs keep strict
  connection-only retry with no double-charge.

## Capabilities

### New Capabilities
- `switch-delegate-routing`: a virtual `switch/<name>` model slug that resolves to an
  ordered pool of native-delegate members and fails over between them (connection
  errors and HTTP 429/5xx), streaming-safe and bounded, with a pluggable selection
  strategy (failover first).

### Modified Capabilities
<!-- No existing OpenSpec capability owns delegate resolution beyond the additive
     resolver return; switch routing is layered on top and is net-new. -->

## Impact

- **Code:** `src/standalone-proxy.ts` — reserved `switch` handling in
  `resolveNativeDelegate` (returns an ordered candidate list for a group); a
  `selectOrder(group)` strategy function (failover implemented; other strategies
  stubbed to the config order); a failover wrapper around the three forward paths
  (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) that advances members on
  connection error / 429 / 5xx before any bytes are streamed; a `SwitchGroup` config
  type.
- **Config:** `~/.relayplane/config.json` gains a `nativeDelegate.switch` map of
  named groups (`strategy`, `members`, optional `weights`). No new keys; groups
  reference existing providers.
- **No change** to auth, where provider keys live (`~/.relayplane/.env`), the
  single-slug retry semantics (connection-only, no double-charge), or the Claude
  Code `/v1/messages` behavior for non-switch slugs.
