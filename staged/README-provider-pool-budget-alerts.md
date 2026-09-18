# Phase 1: provider pools, budgets and notifications

Read-only live audit: 2026-09-18. Nothing here has been applied to the live
configuration, deployed, or sent over the network. This is Layer 2, covering
only requests explicitly routed through RelayPlane. It is not the primary
runaway defense and cannot prevent account burn by itself.

## Actual schemas and live findings

- `providers` is a map of provider names to `{rateLimit?: {rpm: number},
  accounts?: [{label: string, apiKey: string, priority?: number}]}` in
  `src/config.ts`. `apiKey` is a literal API key or Anthropic OAuth access token,
  not a reference expression. Priority defaults to 0. Only
  `providers.anthropic.accounts` is registered at startup. Incoming tokens are
  also auto-detected at priority 10. Selection honors an available caller token,
  otherwise priority and requests/minute. The pool skips 429 cooldowns, repeated
  401 quarantine, and usage at 90% of known RPM. There is no dollar cap here.
- `credentialPool` is a top-level ordered array of `{id, tenantId, source,
  path?, envVar?, weight?, maxConcurrent?, refresh?}`. Sources are `oauth-file`,
  `api-key`, `request-header`. Runtime defaults: weight 1, maxConcurrent 5.
  Weight and concurrency are reserved fields, not enforced scheduling limits.
  `oauth-file` reads `claudeAiOauth.accessToken` or root `accessToken` from the
  literal path; `api-key` reads `process.env[envVar]`; `request-header` resolves
  no token, leaving caller authentication. This is an Anthropic pool with no
  provider discriminator. Only the first entry's tenant is selected by the
  standalone proxy. `refresh:false` leaves refresh ownership outside the proxy.
  `refresh:true` enables the separate Claude OAuth refresh manager.
- Headroom is read from `~/.relayplane/headroom.json`, keyed by credential ID,
  with `sessionUsed`, `weeklyUsed`, `fableUsed` fractions. At 0.8 it prefers
  another account, but falls back ignoring that threshold. This is NOT a hard
  stop. The live file has both IDs plus `_updated` metadata, and `_authFailed`
  on acctC; those metadata fields are not enforced by this selector. Freshness
  is not validated. Missing credentials/all cooldowns can fall back to ordinary
  auth resolution. This cannot enforce a strict account boundary.
- `provider-limits.ts` has code constants keyed `provider:tier`, values
  `{rpm,tpm}`: anthropic:default 50/40000, anthropic:max 60/80000,
  openai:default 60/90000, openrouter:default 60/100000, google:default
  60/100000, xai:default 60/100000, groq:default 30/100000. These are repository
  defaults, not verified subscription quotas. The token pool uses RPM only.
- `budget` fields: `enabled`, `dailyUsd`, `hourlyUsd`, `perRequestUsd`,
  `onBreach` (`block|warn|downgrade|alert`), `downgradeTo`, `alertWebhook?`,
  `alertThresholds` (percentages), `sessionCapUsd`, `modelLadder`.
  Defaults: false, 50, 10, 2, downgrade, claude-sonnet-4-6, no webhook,
  [50,80,95], 1, [claude-opus-4-5,claude-sonnet-4-5,claude-haiku-4-5].
  Separate `BudgetTracker` fields are `dailyCapUSD?`, `warningThreshold?`
  (fraction, default .8). Undefined cap means unlimited for that tracker.
  UI fields `perSessionCapUsd`, `perDayCapUsd`, `perKeyCapUsd`, `ladder`,
  `runawayRetries`, `runawayWindowSec`, `alerting` are also accepted.
  `alerting` can contain telegram/email/slack/webhook booleans and
  telegramChatId/emailAddress/slackWebhookUrl/webhookUrl. These declarations
  do not wire delivery or per-account budget enforcement. `perKeyCapUsd` is
  validated/displayed, not consulted in the request checks. Use `sessionCapUsd`
  for the actual session check, not just `perSessionCapUsd`.
- `budget.db` exists. Read-only Python SQLite inspection found `spend_log`
  (`id` integer PK, `amount` real, `model` text, `daily_window` text,
  `hourly_window` text, `timestamp` integer), `session_budgets` (`session_id`
  text PK, `cap_usd`, `spent_usd` real, `model_used` text, `created_at`,
  `updated_at` integer), and internal `sqlite_sequence`. There is no credential,
  provider, pool or tenant column. Global spend is summed by UTC calendar day
  and UTC clock hour, not trailing 24-hour/60-minute windows. Session caps are
  keyed by caller session ID. Enabling `dailyCapUSD` creates a separate
  `daily_cap_log` (`id,amount,model,daily_window,timestamp`), absent live today.
  It does not inherit existing `spend_log` history.
- `agents.json` is a map keyed by fingerprint, values `{name, fingerprint,
  firstSeen, lastSeen, systemPromptPreview, totalRequests, totalCost}`. It is
  an agent registry, not an account/credential/budget registration mechanism.
- Live config and backup both have empty `providers.anthropic.accounts`, the
  two file-backed credentials in the proposed JSON, budget enabled with
  dailyUsd 500, sessionCapUsd/perSessionCapUsd 200, and onBreach `warn`.
  Hourly and per-request fields are absent, so defaults are 10 and 2.
  `alerts` is absent, so alerts are disabled. Anomaly is enabled, velocity 200,
  token explosion 20. Since its buffer holds 100 requests, velocity 200 cannot
  trigger. The proposal lowers it to 80. Backup has the same relevant settings;
  timestamps differ. Neither config has Codex registration.

## Account registration proposal

The exact merge block is `provider-pool-budget-alerts.proposed.json` beside this
file. Its two Claude paths already exist and contain `claudeAiOauth.accessToken`,
`refreshToken`, `expiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`.
Preserve the live IDs to match headroom data. Matt must confirm which real Max
account corresponds to each path; filenames alone do not prove identity or
current token validity. No token values were copied into this repository.

For the older static token pool, the valid equivalent is:

```json
{"providers":{"anthropic":{"accounts":[
  {"label":"Claude Max account 1","apiKey":"<from /home/coder/.claude-max3/.claude/.credentials.json: claudeAiOauth.accessToken>","priority":0},
  {"label":"Claude Max account 2","apiKey":"<from /home/coder/.claude-default/.claude/.credentials.json: claudeAiOauth.accessToken>","priority":1}
]}}}
```

Do not apply that alternative alongside the file pool; placeholders are not
resolved by the application, and copied access tokens become stale.

The third account is an explicit registration gap, not an omitted secret:
`/home/coder/.codex/auth.json` exists with `auth_mode`, `OPENAI_API_KEY`, `tokens`,
`last_refresh`; `tokens` contains `id_token`, `access_token`, `refresh_token`,
`account_id`. Its credential reference is
`<from /home/coder/.codex/auth.json: tokens.access_token>`.
There is NO functional existing-schema JSON block that registers this OAuth
account in the Anthropic pool. `providers.openai.accounts` would be structurally
accepted but ignored by startup pool registration. Do not put Codex tokens in
`credentialPool` or substitute them for an OpenAI API key. Codex OAuth traffic
currently bypasses RelayPlane entirely. Supporting it requires a separate
OAuth-capable upstream integration, refresh ownership, routing and attribution.
No such integration is built in Phase 1.

After deploying the notification change and confirming the two account paths,
Matt can run this exact merge, with backup and atomic replacement:

```bash
cd /home/coder/relayplane-workflows/.phase1-local
bash <<'APPLY'
set -euo pipefail
cfg=/home/coder/.relayplane/config.json
proposal=packages/proxy/staged/provider-pool-budget-alerts.proposed.json
backup="$cfg.phase1-backup.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p -- "$cfg" "$backup"
merged=$(mktemp /home/coder/.relayplane/config.json.merge.XXXXXX)
trap 'rm -f -- "$merged"' EXIT
jq -s '.[0] * .[1]' "$cfg" "$proposal" > "$merged"
jq -e '.budget.enabled == true and .budget.onBreach == "block" and (.credentialPool | length) == 2' "$merged" >/dev/null
chmod 600 "$merged"
mv -- "$merged" "$cfg"
trap - EXIT
APPLY
```

This replaces the credential array with exactly those two entries and preserves
other config sections via recursive merge. It is a proposal, not executed.
Credential pool registration runs at startup, so restart the deployed proxy via
its actual service manager after reviewing build/deployment. A service unit name
was not established here; do not start a second proxy against the same ledger.
Also check the service's `RELAYPLANE_DAILY_CAP_USD`: it overrides the file's daily
amount at initial load and enables the separate tracker. Do not assume changing
only the file defeats an existing environment override.

## Hard stop: existing code, proposed configuration

Use dailyUsd 500, hourlyUsd 100, onBreach block, sessionCapUsd 200,
alertThresholds [80,95]. Daily warnings at $400 and $475; hard stop at $500.
Hourly stop at $100. Session stop at $200 when the request has a session ID;
its existing model ladder may downgrade at 80%. No new budget blocking code
is needed. We intentionally reuse the existing persisted spend ledger instead
of starting an empty dailyCapUSD ledger.

This is a high operational notional ceiling for the two proxied Claude accounts,
not $500 of subscription capacity. Recent recorded totals: Sep 11 $370.93,
Sep 12 $589.30, Sep 13 $487.74, Sep 14 $144.90, Sep 15 $51.14, Sep 16 $250.01,
Sep 17 $31.02; Sep 18 $19.62 at inspection. Keeping the live $500 ceiling allows
substantial work but would have stopped further requests on the $589 day. $100
per clock hour catches concentrated consumption sooner. These are provisional
operating choices, not provider-derived safe limits. Max weekly/session caps
are independent; no fixed notional dollar figure guarantees remaining quota.

Per-account target allocations could be $250/day per Claude seat, but they
CANNOT be enforced with this schema. The only enforced pool-like dollar cap is
the aggregate $500 for checked proxy traffic. Codex has no applicable cap here.
Do not enter invented `perAccount` or `perPool` config. True account hard caps
need ledger credential IDs on every attempt/failover, reservations before
forwarding, and a fail-closed account selector. Not implemented in this phase.

`BudgetManager.checkBudget()` returns `allowed:false`, `action:block` when
recorded spend is at/above the daily/hourly limit, or recorded spend plus prompt
cost estimate exceeds it. `preRequestBudgetCheck()` turns that into `blocked`.
Both native `/v1/messages` and chat completions handlers return HTTP 429 with
`type:budget_exceeded`, `x-relayplane-budget-exceeded:daily-cap`, and return
before the upstream call. That header says daily-cap even for hourly breaches.
The current handlers pass `undefined` for per-request estimatedCost, so the
`perRequestUsd` field is not an effective request cap there.

Limits of this existing stop: projected cost covers prompt text only, not
reserved output; concurrent in-flight requests can overshoot; failed persistence
falls back to process memory; pending SQLite writes flush about once per second;
multiple proxy processes do not coordinate reservations. Unknown pricing can
produce zero estimates. This is a real refusal of subsequent checked requests,
not a strict mathematical ceiling or a guarantee of stopping before provider
throttling. Bypass/passthrough paths and traffic outside the proxy need separate
controls. Post-response anomaly detection does not block anything.

## Notifications

Before this change, `AlertManager.createAlert()` stores enabled alerts in
`~/.relayplane/alerts.db` (or memory if SQLite unavailable), then
`deliverWebhook()` POSTs `{source:"relayplane",alert:{id,type,message,severity,
timestamp,data}}` to `alerts.webhookUrl`. There is no alert destination env var.
No ordinary alert is printed to stdout by this class. Its storage failures log
warnings to stderr. `budget.alertWebhook` and `budget.alerting.telegram` are
not consumed by this delivery path. `anomaly.ts` only returns anomaly objects;
`postRequestRecord()` calls `fireAnomaly`. Attribution also has a separate
`attribution.alerts.webhookUrl`, null live, and run-alert rows in runs.db.

Live `alerts` is absent, so threshold/breach/anomaly alert creation returns null:
no AlertManager storage, webhook or Telegram delivery. Telegram is NOT confirmed
wired live. Existing notification infrastructure is confirmed by source reading:
`/home/coder/clawd/scripts/v2/bin/notify-cli.py` publishes through `notify_bus.py`,
which invokes `scripts/deliver.py --target telegram:dm`. Other JS callers use
`scripts/lib/notify-via-bus.js`. `scripts/telegram-notify.js` also exists but its
raw direct mode is reserved for the daily verdict/tests; use the canonical bus.

New optional `alerts.notifyCliPath` connects AlertManager to that CLI with async
`execFile('python3', args)`, no shell, 30-second timeout. Critical alerts use
`INFRA-CRITICAL` (immediate silent Telegram, subject to bus dedup/storm policy);
info/warning use `BRIEF` (digest, not immediate Telegram). Success is marked
only when the CLI reports `delivered=True`. Suppressed, queued and unsuccessful
sends remain undelivered; there is no automatic retry in AlertManager. Existing
webhook delivery now marks delivered only on successful HTTP status.

The bus sender resolves its configured Telegram token, optionally
`TELEGRAM_BOT_TOKEN` when token_source is env, otherwise the token chain in
`/home/coder/clawd/state/telegram-config.json`,
`/home/coder/.openclaw/openclaw.json`, then `/root/.openclaw/openclaw.json`.
The sender's configured chat_id defaults to Matt's DM. No new live secrets are
needed in RelayPlane. Source inspection is not an end-to-end delivery test.

After building the changed alerts.ts into dist, this exact Phase 2 command fires
ONE synthetic critical breach through AlertManager and the bus. It does not call
an LLM, initialize alerts.db, or modify budgets. It DOES publish to the live bus
and may send Telegram, so it was not run in Phase 1:

```bash
cd /home/coder/relayplane-workflows/.phase1-local/packages/proxy
node <<'TEST_ALERT'
const { AlertManager } = require('./dist/alerts.js');
const alerts = new AlertManager({
  enabled: true,
  notifyCliPath: '/home/coder/clawd/scripts/v2/bin/notify-cli.py'
});
const alert = alerts.fireBreach('phase2-smoke-' + Date.now(), 500, 500);
setTimeout(() => {
  console.log(JSON.stringify({id: alert.id, telegramDelivered: alert.delivered}));
  process.exitCode = alert.delivered ? 0 : 1;
  alerts.close();
}, 31000);
TEST_ALERT
```

## Layer 3 scope, not built

Set and preserve `ANTHROPIC_BASE_URL=http://127.0.0.1:4100` in the common agent
spawn environment, including `/home/coder/.pipeline-env`, the service/cron
launchers that source it, and every independent spawn wrapper; verify inheritance
and remove direct-provider fallback if mandatory routing is the goal. The shim
at `scripts/v2/lib/llm_provider.py:170` preserves this variable but only routes
through RelayPlane when pipeline-env actually sets it. Codex/OpenAI OAuth is a
separate path that does not honor ANTHROPIC_BASE_URL and needs its own supported
routing, quota controls and accounting. Registration alone cannot force routing.

## Local delivery and verification

The original checkout's `.git` is read-only. A local shared clone was created
inside this repo at `.phase1-local`; its feature branch is
`feat/relayplane-provider-pool-budget-alerts`, based on the local default main
commit `3fb063e88f1fe5abb5f2a9bff0a4e6ca6c0ca5f7`. Identity is Matt Turley,
mt@turleydesigns.com. Original tracked/untracked work was preserved. No fetch,
push, PR, external write or network test was performed.

Tests: 80 tests pass across alerts-notify-bus, budget, budget-tracker, anomaly,
and credential-pool suites. The new tests mock all subprocess/HTTP calls; budget
unit tests use memory and do not open live databases. The full proxy TypeScript check (`tsc --noEmit -p
packages/proxy/tsconfig.json`) passes with the existing local core build linked
into the clone; the targeted strict alerts/budget/anomaly check also passes. Dependencies are reused from the original checkout without
installing packages. Proposals and this audit are committed with the code.

To import the finished branch into the original checkout in Phase 2, once Git
metadata is writable (local file transport only):

```bash
cd /home/coder/relayplane-workflows
git fetch .phase1-local feat/relayplane-provider-pool-budget-alerts:feat/relayplane-provider-pool-budget-alerts
git switch feat/relayplane-provider-pool-budget-alerts
```

Review existing local work before switching. The clone's origin was reset to match the original checkout's remote URL,
so the clone branch is also ready for a later explicit push. Importing the branch
preserves the original checkout's remote setup. No push or PR command was executed.


## Classifier hook point

Path taken: documentation only. No classifier or HTTP complexity override was
built. `X-RelayPlane-Complexity` is a proposed header, not currently consumed.
The proposed accepted values are exactly `simple|moderate|complex`; absent or
invalid values should preserve the existing classifier behavior.

The existing pure seam is the fifth argument, `complexity`, of
`resolvePolicy(policy, agentFingerprint, agentName, taskType, complexity,
candidateModel)` in `src/agent-policy.ts`. It accepts
`'simple' | 'moderate' | 'complex'`. An external Jev classifier can supply that
argument directly. `simple` selects the matched rule's `downgradeTo`, unless
`neverDowngrade` is true; `moderate` uses `preferred`; `complex` uses `escalateTo`
only when `escalateOn` includes `complexity_high`. Missing downgrade targets
retain `preferred`. Unmatched policies pass through `candidateModel`.

Current source of complexity: `classifyComplexity(messages)` in
`src/standalone-proxy.ts` scores the last user message's text and a capped
conversation-size signal. Both the native `/v1/messages` handler and the chat
completions handler assign its result to their local `complexity` variable
before selecting `proxyConfig.routing.complexity[complexity]`. With no messages,
that variable remains `simple`. The built-in classifier also returns `elite`,
which is outside the three-value policy resolver input and needs an explicit
mapping decision before integration. The CLI policy replay in `src/cli.ts`
currently passes the recorded `entry.complexity` to `resolvePolicy`; its type
assertion is not runtime validation.

The HTTP handlers import `resolvePolicy` but do not currently call it. Thus
policy suggestions and this new downgrade target affect generated policy and
policy resolution/replay, not live HTTP policy enforcement. CLI and dashboard
policy generators now preserve `downgradeTo`. Connecting policy resolution to
live routing requires a separate integration across both handlers, including
agent identity, task precedence, cascade and budget interactions.

For a future header integration, read `req.headers['x-relayplane-complexity']`
in both handlers, validate a single accepted value, and feed it into the local
`complexity` before tier selection and into `resolvePolicy` when wired. Response
cache lookups currently precede classification and hash the request body, not
this proposed header. The effective override must be part of the response cache
identity (or bypass that cache) so a complex request cannot reuse a simple-tier
answer. Merely replacing the local classifier result would leave that bug.
These combined changes exceed a small isolated classifier hook, so they are
explicitly deferred.

Suggested policies now offer a simple-request `downgradeTo` when an available
candidate has strictly lower known input and output prices than the preferred
model. Candidates are Anthropic Haiku 4.5, OpenAI GPT-4o mini, Google Gemini 2.0
Flash, then Groq Llama 3.1 8B. Existing routine-task base recommendations remain.
Review plus security share of at least 80% retains `neverDowngrade`, including
long-context profiles. Other long-context profiles retain the full-context base
without an accuracy lock or a generated downgrade target until context-fit can
be checked per request. Unknown prices do not count as free models.

Prompt-cache awareness is deferred: the pure resolver has no cache residency or
cached-token pricing input. Model escalation breaks provider prompt-cache reuse
and can cost roughly 7x for cache-heavy prompts. This limitation is also recorded
at the escalation branch in code; accuracy-critical escalation is preserved.
