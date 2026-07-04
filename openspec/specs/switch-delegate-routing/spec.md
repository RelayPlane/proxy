# switch-delegate-routing Specification

## Purpose
TBD - created by archiving change add-switch-delegate-routing. Update Purpose after archive.
## Requirements
### Requirement: Resolve a switch slug to an ordered pool of delegate members

A model slug of the form `switch/<name>` SHALL resolve to the named group in
`nativeDelegate.switch` rather than to a single provider. The group's `members` (a
list of ordinary `vendor/model` delegate slugs) SHALL each be resolved through the
existing native-delegate resolution (per-vendor `apiKeyEnv`, `modelMap`,
`stripVendor`), producing an ordered list of candidate delegates. Members that do
not resolve (missing provider or key) SHALL be dropped, not fatal. `switch` SHALL be
a reserved prefix that never itself denotes a vendor.

#### Scenario: A switch slug expands to its configured members in order

- **WHEN** a request names `switch/combine_1` and the config has
  `switch.combine_1 = { strategy: "failover", members: ["deepseek/deepseek-pro",
  "byteplus/deepseek-pro"] }`
- **THEN** the proxy produces the ordered candidate list
  `[deepseek/deepseek-pro, byteplus/deepseek-pro]`, each resolved with its own
  provider endpoint, key, and mapped model, and attempts them in that order

#### Scenario: An unknown or empty switch group is rejected cleanly

- **WHEN** a request names `switch/<name>` for a `<name>` that is not configured, or
  whose `members` all fail to resolve
- **THEN** the proxy returns the same clear client error it returns for any
  unresolvable delegate slug, and does not crash

#### Scenario: Existing single-slug resolution is unchanged

- **WHEN** a request names a plain `vendor/model` slug (no `switch/` prefix)
- **THEN** it resolves to exactly one delegate as before, and every existing caller
  of the single-delegate resolver observes identical behavior

### Requirement: Fail over between members on connection errors and HTTP 429/5xx

For a `switch/<name>` slug, the proxy SHALL attempt the ordered candidates until one
yields a usable response. It SHALL advance to the next candidate when an attempt
fails with a connection-level error OR returns an HTTP status of 429 or ≥500, and
SHALL stop and surface the first response that is 2xx or a non-retryable 4xx. Each
candidate SHALL be attempted at most once per request (no cycling); when all
candidates are exhausted the last error or response SHALL be surfaced.

#### Scenario: A flaky first member is skipped for a healthy second

- **WHEN** the first member returns a connection error or an HTTP 429/5xx and the
  second member returns 2xx
- **THEN** the request is served by the second member, and the skipped member is
  logged at warning level without being counted as a completed request

#### Scenario: A real client error is surfaced, not masked

- **WHEN** a member returns a non-retryable 4xx (e.g. 400 invalid request)
- **THEN** the proxy surfaces that response immediately and does NOT advance to the
  next member (the pool is not burned on a malformed request)

#### Scenario: A fully-down pool fails fast

- **WHEN** every member fails to connect or returns 429/5xx
- **THEN** the proxy surfaces the last failure after trying each member exactly once,
  without looping

### Requirement: Switch failover is streaming-safe and does not double-charge

Failover between members SHALL be decided from the upstream response status before
any response body is streamed to the client; once streaming has begun the member
SHALL be committed and no mid-stream switch SHALL occur. The 429/5xx-advances-member
behavior SHALL apply only to `switch/<name>` slugs; a plain `vendor/model` slug (a
one-member candidate list) SHALL keep strict connection-only retry with HTTP
responses surfaced once, so the token plan is never double-charged.

#### Scenario: Streaming request commits to one member

- **WHEN** a `switch/<name>` request with `stream: true` begins streaming from a
  member
- **THEN** the proxy emits an unbroken event stream from that single member and does
  not fail over after the first byte, even if later chunks error

#### Scenario: Non-switch slug keeps connection-only retry

- **WHEN** a plain `vendor/model` request receives an HTTP 429 or 5xx
- **THEN** the proxy surfaces that status once and does not retry or advance (there
  is no next member), preserving the existing no-double-charge guarantee

