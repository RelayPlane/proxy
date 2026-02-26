#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/proxy"
ARTIFACT_DIR="$ROOT_DIR/.forge/v1.7"
LOG_DIR="$ARTIFACT_DIR/logs"
mkdir -p "$LOG_DIR" "$PKG_DIR/.test-home-cli"

run_case() {
  local name="$1"
  shift
  local logfile="$LOG_DIR/${name}.log"
  echo "[$(date -u +%FT%TZ)] RUN $name :: $*" | tee -a "$ARTIFACT_DIR/commands.log"
  if "$@" >"$logfile" 2>&1; then
    echo "PASS" > "$LOG_DIR/${name}.status"
  else
    echo "FAIL" > "$LOG_DIR/${name}.status"
  fi
}

: > "$ARTIFACT_DIR/commands.log"

run_case build pnpm --filter @relayplane/proxy build
run_case test-cache pnpm --filter @relayplane/proxy test -- __tests__/response-cache.test.ts
run_case test-budget pnpm --filter @relayplane/proxy test -- __tests__/budget.test.ts __tests__/downgrade.test.ts
run_case test-anomaly pnpm --filter @relayplane/proxy test -- __tests__/anomaly.test.ts
run_case test-alerts pnpm --filter @relayplane/proxy test -- __tests__/alerts.test.ts
run_case test-cli pnpm --filter @relayplane/proxy test -- __tests__/cli-surface.test.ts

# Full proxy test suite
run_case test-full pnpm --filter @relayplane/proxy test

# Build machine-checkable matrix
cat > "$ARTIFACT_DIR/matrix.json" <<JSON
{
  "build": "$(cat "$LOG_DIR/build.status")",
  "cache_exact_and_aggressive": "$(cat "$LOG_DIR/test-cache.status")",
  "budget_threshold_enforcement_and_downgrade": "$(cat "$LOG_DIR/test-budget.status")",
  "anomaly_detection": "$(cat "$LOG_DIR/test-anomaly.status")",
  "alerts_pipeline_and_webhook": "$(cat "$LOG_DIR/test-alerts.status")",
  "cli_surface_and_fallthrough": "$(cat "$LOG_DIR/test-cli.status")",
  "full_proxy_suite": "$(cat "$LOG_DIR/test-full.status")"
}
JSON

cat "$ARTIFACT_DIR/matrix.json"

if grep -q '"FAIL"' "$ARTIFACT_DIR/matrix.json"; then
  exit 1
fi
