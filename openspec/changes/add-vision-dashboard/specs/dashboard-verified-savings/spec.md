## ADDED Requirements

### Requirement: Opus-baseline counterfactual cost

The dashboard SHALL display, for the active window, the actual spend alongside the
counterfactual cost of having run every request on the Opus orchestrator model,
computed from the per-event Opus baseline already recorded by the telemetry
recorder.

#### Scenario: Delegated work shows its counterfactual

- **WHEN** the window contains delegated worker requests (e.g. `minimax/MiniMax-M3`)
  whose per-event Opus baseline cost exceeds their actual cost
- **THEN** the dashboard shows both the actual total and the all-Opus total, and
  the difference is presented as money saved (never as `$0` when a positive
  baseline delta exists)

#### Scenario: Passthrough-only window

- **WHEN** the window contains only orchestrator (`claude-*`) requests with no
  delegation
- **THEN** actual and baseline totals are equal and the saved amount is `$0`,
  clearly labelled as "no delegation in window" rather than implied breakage

### Requirement: Verified Savings Rate headline

The dashboard SHALL present a headline **Verified Savings Rate** equal to the sum
of per-event saved cost divided by the sum of per-event Opus-baseline cost over the
window, discounted so that delegated work which failed and was retried on a Claude
model does not count as saved.

#### Scenario: Bounced task does not inflate savings

- **WHEN** a delegated worker request fails and the same logical task is
  subsequently completed on a Claude model
- **THEN** the failed worker cost is counted as wasted and the task contributes
  approximately zero (or negative) to the Verified Savings Rate

#### Scenario: Correlation unavailable is reported as gross

- **WHEN** the telemetry events cannot be correlated into logical tasks (no
  agent/session identifier present)
- **THEN** the metric is computed without the retry discount and is explicitly
  labelled "gross" so the figure is never silently overstated

### Requirement: Daily verified-savings trend

The dashboard SHALL show a trend of verified savings over the retention window so
the user can see whether delegation value is growing or regressing day over day.

#### Scenario: Regression is visible

- **WHEN** delegation silently falls back toward the orchestrator across days
  (rising actual cost relative to baseline)
- **THEN** the daily trend shows the verified-savings rate declining
