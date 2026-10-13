#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --no-e2e: skip the full-suite coverage run. Used by the CHECK-phase checker
# for a fast agent-facing pass; real CI (.github/workflows/ci.yml) runs
# `npm run test` directly, unaffected by this flag, so full coverage still
# runs on every PR.
#
# The pipeline integration suites (real git worktrees, whole
# plan->build->check->ship cycles) are excluded from BOTH paths now: vitest's
# default include skips them, and they run on a schedule instead
# (.github/workflows/nightly-integration.yml). Run them on demand with
# `npm run test:integration`.
NO_E2E=0
for arg in "$@"; do
  if [ "$arg" = "--no-e2e" ]; then
    NO_E2E=1
  fi
done

# The repo default (npm test / CI) is 4 workers. verify.sh opts out to 1 (serial)
# by default because the shared factory host runs at very high load. Set
# FACTORY_TEST_MAX_WORKERS=N to override.
export FACTORY_TEST_MAX_WORKERS="${FACTORY_TEST_MAX_WORKERS:-1}"
echo "verify: FACTORY_TEST_MAX_WORKERS=${FACTORY_TEST_MAX_WORKERS}"

npm ci
npm run format:check
npm run build
npm run adr:index -- --check
bash scripts/check-config-json.sh
bash scripts/check-oxlint-plugin-version.sh
npm run typecheck
npm run lint
npm run knip
# Per-file durations for the slowest-files report (#2769). Keep the default
# console reporter, and keep github-actions annotations in CI (vitest only
# auto-adds that reporter when none are passed).
VITEST_REPORT=.tmp/vitest-report.json
REPORTER_ARGS=(--reporter=default --reporter=json "--outputFile.json=${VITEST_REPORT}")
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  REPORTER_ARGS+=(--reporter=github-actions)
fi
# The test step is timed and compared against the stored budget (#2770); the budget lives in
# scripts/test-budget.ts (TEST_BUDGET_SECONDS, override FACTORY_TEST_BUDGET_SECONDS). Over budget only warns.
rm -f "$VITEST_REPORT"
TEST_STEP_START=$SECONDS
if [ "$NO_E2E" = "1" ]; then
  npx vitest run --maxWorkers="$FACTORY_TEST_MAX_WORKERS" "${REPORTER_ARGS[@]}"
  TEST_STEP_SECONDS=$((SECONDS - TEST_STEP_START))
  npm run --silent slowest-tests -- "$VITEST_REPORT" || true
  npm run --silent test-budget -- "$TEST_STEP_SECONDS" "$VITEST_REPORT"
else
  npm run test -- --maxWorkers="$FACTORY_TEST_MAX_WORKERS" "${REPORTER_ARGS[@]}"
  TEST_STEP_SECONDS=$((SECONDS - TEST_STEP_START))
  npm run --silent slowest-tests -- "$VITEST_REPORT" || true
  npm run --silent test-budget -- "$TEST_STEP_SECONDS" "$VITEST_REPORT"
  npm run coverage-ratchet
fi
npm run eval -- --stub
bash scripts/auto-merge-sweep.test.sh
bash scripts/filter-green-prs.test.sh
bash scripts/repo-merge-settings.test.sh
bash scripts/repo-about.test.sh
bash scripts/repo-issue-optics.test.sh
bash scripts/ruleset-copilot-review.test.sh
bash scripts/triage-factory-report.test.sh
bash scripts/nightly-failure-issue.test.sh
bash scripts/real-cli-smoke.test.sh
bash scripts/adapter-smoke.test.sh
bash scripts/publish-workspaces.test.sh
bash scripts/publish-release.test.sh
bash scripts/set-release-version.test.sh
bash scripts/launchd/install-sweep-plist.test.sh
