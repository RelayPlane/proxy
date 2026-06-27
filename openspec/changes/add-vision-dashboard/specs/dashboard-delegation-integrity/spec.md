## ADDED Requirements

### Requirement: Real resolved provider and endpoint per request

The telemetry record and dashboard SHALL report the actual resolved provider
vendor and endpoint host for each request, not a hard-coded default label.

#### Scenario: Direct vendor route is labelled truthfully

- **WHEN** a `minimax/MiniMax-M3` request is forwarded to `api.minimax.io`
- **THEN** the dashboard Model/Provider columns and the request log line show the
  resolved vendor `minimax` and endpoint host `api.minimax.io`, not `openrouter`

#### Scenario: Anthropic orchestrator route is labelled truthfully

- **WHEN** a `claude-opus-4-8` request is forwarded to the Anthropic endpoint
- **THEN** the record shows provider `anthropic` and the Anthropic endpoint host

### Requirement: Direct-vs-leaked routing breakdown

The dashboard SHALL surface, in aggregate, the share of delegated tokens that went
direct to their intended vendor versus those that leaked to the orchestrator
(Anthropic) despite a non-Anthropic slug.

#### Scenario: Silent fallback is caught

- **WHEN** a `vendor/model` request with `vendor != anthropic` is forwarded to the
  Anthropic endpoint because the provider key env var is unset
- **THEN** the request is counted as "leaked-to-orchestrator" and the integrity
  panel reflects a non-zero leak share with the offending vendor identified

#### Scenario: Healthy delegation reads near 100% direct

- **WHEN** all delegated requests in the window reached their intended vendor
  endpoints
- **THEN** the integrity panel shows ~100% direct-to-vendor and 0% leaked

### Requirement: Provider health reflects observed success

The dashboard provider-health indicator SHALL be derived from observed trailing
success rate (or marked unknown when there is no traffic), and SHALL NOT display a
"down" state that contradicts a healthy observed success rate.

#### Scenario: Healthy provider is not shown as down

- **WHEN** a provider has a trailing observed success rate at or above the healthy
  threshold
- **THEN** its health indicator shows healthy, never "down"

#### Scenario: No traffic is shown as unknown

- **WHEN** a provider has had no requests in the window
- **THEN** its health indicator shows "unknown"/neutral rather than "down"
