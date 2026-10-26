#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --no-coverage (alias --no-e2e, deprecated): run the same coverage-enforcing
# test command as the full path (`npm run test`, i.e. `vitest run --coverage`
# with the thresholds in vitest.config.ts) and skip only `coverage-ratchet`.
# The CHECK-phase tests checker still passes --no-e2e, so a PR under a coverage threshold fails CHECK instead of
# parking as ci-failed. CI (.github/workflows/ci.yml) runs `npm run test`
# sharded and enforces the thresholds on the merged report.
#
# The pipeline integration suites (real git worktrees, whole
# plan->build->check->ship cycles) are excluded from BOTH paths now: vitest's
# default include skips them, and they run on a schedule instead
# (.github/workflows/nightly-integration.yml). Run them on demand with
# `npm run test:integration`.
NO_COVERAGE=0
for arg in "$@"; do
  case "$arg" in
    --no-coverage) NO_COVERAGE=1 ;;
    --no-e2e)
      NO_COVERAGE=1
      echo "verify: --no-e2e is deprecated; use --no-coverage (same behavior)" >&2
      ;;
  esac
done

# Same default as npm test / CI: 4 workers (scripts/test-workers.ts). On a heavily loaded
# shared host, set FACTORY_TEST_MAX_WORKERS=1 to run serially, or any N to override.
export FACTORY_TEST_MAX_WORKERS="${FACTORY_TEST_MAX_WORKERS:-4}"
echo "verify: FACTORY_TEST_MAX_WORKERS=${FACTORY_TEST_MAX_WORKERS}"
echo "verify: CI=${CI:-} (test budget overrun fails verify when CI is set)"

# Loopback/TMPDIR pipe probe (#3332): a sandbox that denies binds is an environment error, not a test failure.
probe_status=0
node scripts/verify-env-probe.mjs || probe_status=$?
if [ "$probe_status" = "78" ]; then
  echo "verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)"
  exit 78
elif [ "$probe_status" != "0" ]; then
  exit "$probe_status"
fi

npm ci
npm run format:check
npm run build
npm run adr:index -- --check
bash scripts/check-config-json.sh
bash scripts/check-oxlint-plugin-version.sh
npm run typecheck
npm run lint || {
  echo "verify: lint failed. For max-lines errors see .claude/skills/verify/SKILL.md#max-lines-guard"
  exit 1
}
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
# scripts/test-budget.ts (TEST_BUDGET_SECONDS, override FACTORY_TEST_BUDGET_SECONDS). Over budget warns locally and fails verify in CI
# (CI env var set, e.g. CI=true on GitHub Actions; #2771).
rm -f "$VITEST_REPORT"
TEST_STEP_START=$SECONDS
npm run test -- --maxWorkers="$FACTORY_TEST_MAX_WORKERS" "${REPORTER_ARGS[@]}"
TEST_STEP_SECONDS=$((SECONDS - TEST_STEP_START))
npm run --silent slowest-tests -- "$VITEST_REPORT" || true
npm run --silent test-budget -- "$TEST_STEP_SECONDS" "$VITEST_REPORT"
# The ratchet (thresholds must not lag measured coverage) is full-path only; --no-coverage (and --no-e2e) skips it.
if [ "$NO_COVERAGE" != "1" ]; then
  npm run coverage-ratchet
fi
npm run eval -- --stub
npm run eval -- --stub --suite readiness
bash scripts/auto-merge-sweep.test.sh
bash scripts/filter-green-prs.test.sh
bash scripts/repo-merge-settings.test.sh
bash scripts/repo-about.test.sh
bash scripts/repo-issue-optics.test.sh
bash scripts/ruleset-copilot-review.test.sh
bash scripts/triage-factory-report.test.sh
bash scripts/nightly-failure-issue.test.sh
bash scripts/real-cli-smoke.test.sh
bash scripts/factory-run.test.sh
bash scripts/cli-help-baseline.test.sh
bash scripts/adapter-smoke.test.sh
bash scripts/publish-workspaces.test.sh
bash scripts/publish-release.test.sh
bash scripts/set-release-version.test.sh
bash scripts/verify-env-probe.test.sh
bash scripts/launchd/install-sweep-plist.test.sh
