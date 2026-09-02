# Credential pool: 4101 verification + deliberate flip runbook

STAGED. Nothing here is active. The `credentialPool` config key is absent from
the live 4100 config, so the request path is unchanged until you deliberately
flip. Do NOT flip 4100 until step 3 passes on a confirmed account B.

The pool, refresh loop, oauth-file resolution, headroom failover, and
reserve-Fable are wired and unit + e2e tested (see
`__tests__/credential-pool*.test.ts`). What remains is: (a) confirm account B,
(b) verify live on 4101 including a deliberately-staled B token, (c) flip 4100
and point interactive sessions at the proxy.

## 0. Prerequisites

- Account A: this box's live Claude Code login at `~/.claude/.credentials.json`
  (priority 1, `refresh:false`, never written by us).
- Account B: a SECOND Max account's creds in a dedicated file at
  `~/.relayplane/account-b.credentials.json` (priority 2, `refresh:true`).
  Populate it with one of:
  - a dedicated `claude login` writing to that path, or
  - a confirmed copy of the second account's `~/.claude/.credentials.json`.
  Matt to confirm which account is B before this file is populated.

## 1. Stage the config for 4101 (dev instance only)

Merge the `credentialPool` block from `credential-pool.config.example.json` into
the 4101 config, replacing `REPLACE_WITH_HOME` with `$HOME`. Use a 4101-scoped
config via `RELAYPLANE_CONFIG_PATH` so 4100 stays untouched:

```bash
export RELAYPLANE_CONFIG_PATH="$HOME/.relayplane/config.4101.json"
# start from a copy of the live config, then add the credentialPool block:
cp "$HOME/.relayplane/config.json" "$RELAYPLANE_CONFIG_PATH"
# (merge the credentialPool array into $RELAYPLANE_CONFIG_PATH, paths = real $HOME)
RELAYPLANE_PORT=4101 node dist/cli.js start
```

On boot you should see:
`[RelayPlane] Credential pool: 2 account(s) active (tenant=local), 1 managed w/ OAuth refresh`

Check health:
```bash
curl -s localhost:4101/v1/credential-pool/status | jq
```

## 2. Verify selection + failover on 4101

- Normal request routes through account A (priority 1). Confirm via the health
  endpoint `request_count` incrementing on `newmax`.
- Reserve-Fable: a request that routes to `claude-fable-5-1` should select B when A
  is low on Fable weekly (drive with a `~/.relayplane/headroom.json` fixture:
  `{"newmax":{"fableUsed":0.9},"default":{"fableUsed":0.1}}`).

## 3. Verify with a DELIBERATELY STALE account-B token (the key test)

This is the failover-killing case. Hand the pool a B token that is already
expired and confirm the refresh loop rotates it fresh before any failover uses
it, and that a forced 401 on A fails over to B successfully.

```bash
# 3a. Corrupt B's access token / set expiresAt in the past:
#     edit ~/.relayplane/account-b.credentials.json ->
#       claudeAiOauth.accessToken = "sk-ant-oat01-DELIBERATELY-STALE"
#       claudeAiOauth.expiresAt   = <now - 1h in ms>
# 3b. Within ~10 min the refresh manager rotates it; or restart 4101 to force an
#     immediate pass. Confirm the on-disk accessToken changed to a fresh value.
# 3c. Force a 401 on A (temporarily point A's path at a bad-token file) and send
#     a request. Expect log:
#       [CredentialPool] 401 on "newmax" - failing over to "default"
#     and a 200 from B using its FRESHLY REFRESHED token.
```

Only proceed to step 4 after 3c returns a 200 from B with the refreshed token.

## 4. Flip 4100 + route interactive sessions through the proxy

```bash
# 4a. Merge the credentialPool block into the LIVE config:
#     $HOME/.relayplane/config.json  (paths = real $HOME, B confirmed)
# 4b. Restart the live service:
sudo systemctl restart relayplane-proxy
curl -s localhost:4100/v1/credential-pool/status | jq   # enabled:true, 2 accounts

# 4c. Point interactive Claude Code sessions at the proxy so they pool + fail over
#     too. Add to the session env (shell profile / tmux env):
export ANTHROPIC_BASE_URL=http://localhost:4100
```

Interactive sessions now route through RP: the pool selects account A by default,
fails over to B on 429/401 or when A crosses 80% session/weekly, and reserves
Fable weekly for elite tasks. Roll back by removing the `credentialPool` key and
restarting; the proxy returns to single-token behavior with zero other changes.
