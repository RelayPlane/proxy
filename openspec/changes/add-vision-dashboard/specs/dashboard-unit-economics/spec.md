## ADDED Requirements

### Requirement: Cost per session and per agent run

The dashboard SHALL present unit economics — cost per coding session and cost per
agent/subagent run — in addition to cumulative totals, using the session and agent
identifiers already present on telemetry events.

#### Scenario: Per-agent unit cost is visible

- **WHEN** the window contains requests attributable to named subagents (e.g.
  `minimax`, `glm`, `deepseek-pro`)
- **THEN** the dashboard shows each agent's request count and average cost per run

#### Scenario: Expensive worker is flagged

- **WHEN** a delegated worker's effective cost per successful run (including its
  failed retries) exceeds the orchestrator's cost per run for comparable work
- **THEN** the dashboard makes that inversion visible so the user can stop
  delegating that task class

### Requirement: Latency distribution instead of average only

The dashboard SHALL present latency percentiles (p50, p95, p99) for the window and
SHALL NOT rely solely on a mean that hides a bimodal distribution.

#### Scenario: Bimodal latency is not hidden

- **WHEN** the window mixes fast responses and a tail of long-running generations
- **THEN** the dashboard shows p50, p95, and p99 distinctly so the tail is visible

### Requirement: Failure taxonomy by cause

The dashboard SHALL bucket failed requests by cause — at minimum timeout, auth,
quota, upstream-5xx, and other — rather than reporting only an aggregate success
rate.

#### Scenario: Timeout-dominated failures are identifiable

- **WHEN** the window's failures are predominantly long-generation timeouts
- **THEN** the failure breakdown attributes them to the timeout bucket, so the
  remedy (raise the delegate timeout) is obvious

#### Scenario: Auth failures are distinguished from timeouts

- **WHEN** failures include both 401/403 auth rejections and timeouts
- **THEN** the breakdown separates the auth bucket from the timeout bucket
