#!/usr/bin/env bash
# lib/phases/ship.sh — SHIP phase.
#
# Creates the PR after the CHECK phase passes. Handles push, PR creation,
# CI watching, and marking ready for review. If the build phase already
# created a PR (claude route), this phase verifies it exists and is ready.

set -euo pipefail

# phase_ship <issue_number> <worktree> <branch> [pr_title]
phase_ship() {
  local issue="$1" wt="$2" br="$3" title="${4:-}"
  local pr

  cd "$wt" || return 1

  # Check if a PR already exists (claude route may have created one)
  pr="$(gh pr list --repo "${GH_REPO}" --state open --head "$br" --json number --jq '.[0].number' 2>/dev/null || true)"

  if [ -z "$pr" ]; then
    # Push the branch
    git push -u origin "$br" >/dev/null 2>&1 || true

    # Get title from issue if not provided
    [ -z "$title" ] && title="$(gh issue view "$issue" --repo "${GH_REPO}" --json title --jq .title)"

    # Get diff stats
    local stat
    stat="$(git diff --stat "origin/main...HEAD" 2>/dev/null | tail -20)"

    # Create PR
    pr="$(gh pr create --repo "${GH_REPO}" --head "$br" \
      --title "$title (#$issue)" \
      --body "## Summary
Implements #$issue. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).

## Changes
\`\`\`
$stat
\`\`\`

## Verification
This PR passed independent verification by checker agents before shipping.
See .factory/logs/issue-$issue.*.log for details.

Closes #$issue" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  fi

  if [ -z "$pr" ]; then
    echo "FAIL: could not create or find PR for $br" >&2
    return 1
  fi

  # Mark ready for review (if draft)
  gh pr ready "$pr" --repo "${GH_REPO}" 2>/dev/null || true

  # Watch CI (best-effort, don't block on it)
  if [ "${FACTORY_WATCH_CI:-1}" = "1" ]; then
    timeout 600 gh pr checks "$pr" --repo "${GH_REPO}" --watch --fail-fast >/dev/null 2>&1 || true
  fi

  echo "OK: PR #$pr ready for review"
}