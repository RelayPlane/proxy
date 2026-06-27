## ADDED Requirements

### Requirement: Quota-consumed gauge from upstream headers

The dashboard SHALL display, per orchestrator/provider that returns rate-limit
headers, the share of quota consumed, derived from the latest observed
`anthropic-ratelimit-requests-limit` and `anthropic-ratelimit-requests-remaining`
(or equivalent) values.

#### Scenario: Quota consumption is shown

- **WHEN** the latest response from a provider includes limit and remaining
  rate-limit headers
- **THEN** the dashboard shows consumed percentage as `1 - remaining/limit`

#### Scenario: Missing headers degrade gracefully

- **WHEN** a provider returns no rate-limit headers
- **THEN** the gauge shows "unknown" rather than a full or empty bar that could
  mislead

### Requirement: Burn rate and time-to-limit leading indicators

The dashboard SHALL display current burn rate (requests or tokens per minute over a
trailing window) and an estimated time-to-limit so the user can reroute before
exhausting quota.

#### Scenario: Approaching limit is visible ahead of failure

- **WHEN** burn rate and remaining quota imply the limit will be reached within the
  trailing window horizon
- **THEN** the dashboard surfaces a time-to-limit estimate and a warning state
  before requests begin failing

#### Scenario: Idle gateway shows stable headroom

- **WHEN** there is little or no recent traffic
- **THEN** burn rate reads near zero and time-to-limit is shown as effectively
  unbounded/stable
