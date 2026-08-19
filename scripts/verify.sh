#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Pipeline integration/simulation tests (each spins up real git worktrees and runs
# whole plan->build->check->ship cycles) are excluded from vitest's default include
# (vitest.config.ts) — a git-lock race between them can hang a subprocess indefinitely
# (#739/#755), which is not safe on the required per-PR path. They run instead on a
# schedule via .github/workflows/nightly-integration.yml.
#
# --no-e2e: additionally skip coverage collection and the coverage ratchet, for a
# fast agent-facing pass (used by the CHECK-phase checker). Without it, the full
# coverage run + ratchet still runs — both now exclude integration tests either way.
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
