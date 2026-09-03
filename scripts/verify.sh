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

npm ci
npm run format:check
npm run build
bash scripts/check-config-json.sh
bash scripts/check-oxlint-plugin-version.sh
npm run typecheck
npm run lint
npm run knip
if [ "$NO_E2E" = "1" ]; then
  npx vitest run
else
  npm run test
  npm run coverage-ratchet
fi
npm run eval -- --stub
bash scripts/auto-merge-sweep.test.sh
bash scripts/filter-green-prs.test.sh
bash scripts/repo-merge-settings.test.sh
bash scripts/ruleset-copilot-review.test.sh
