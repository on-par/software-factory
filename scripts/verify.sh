#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --no-e2e: skip the full-suite coverage run and the pipeline
# integration/simulation tests (each spins up real git worktrees and runs
# whole plan->build->check->ship cycles). Used by the CHECK-phase checker
# for a fast agent-facing pass; real CI (.github/workflows/ci.yml) runs
# `npm run test` directly, unaffected by this flag, so full coverage and
# the integration suites still run on every PR.
NO_E2E=0
for arg in "$@"; do
  if [ "$arg" = "--no-e2e" ]; then
    NO_E2E=1
  fi
done

npm ci
npm run format:check
npm run build
npm run typecheck
npm run lint
npm run knip
if [ "$NO_E2E" = "1" ]; then
  npx vitest run --exclude '**/*.integration.test.{ts,tsx}'
else
  npm run test
  npm run coverage-ratchet
fi
npm run eval -- --stub
bash scripts/auto-merge-sweep.test.sh
bash scripts/filter-green-prs.test.sh
bash scripts/repo-merge-settings.test.sh
bash scripts/ruleset-copilot-review.test.sh
