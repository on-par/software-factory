#!/usr/bin/env bash
# Idempotent apply + verify for repo-level merge hygiene settings, so unattended
# agent PRs keep history clean and can land themselves (issue #148, following the
# four Low findings from #128): auto-delete head branches on merge, allow auto-merge,
# allow "update branch" suggestions, and default the squash commit to the PR title
# with a blank body. Uses `gh api` (not `gh repo edit`, which has no flags for
# squash_merge_commit_title/squash_merge_commit_message) so both PATCH and verify
# go through one consistent tool.
#
# Re-running against already-correct settings PATCHes the same values and passes
# verification (idempotent). The PATCH silently requires squash merging to be
# enabled on the repo already, which it is. This script touches nothing about
# branch protection.
#
# All config below is env-overridable, each defined exactly once:
#   REPO      GitHub repo as owner/name (default: on-par/software-factory)
#   DRY_RUN   when "1", print the would-be PATCH command instead of executing it
set -euo pipefail

REPO="${REPO:-on-par/software-factory}"
DRY_RUN="${DRY_RUN:-0}"

apply() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: gh api -X PATCH repos/$REPO" \
      "-F delete_branch_on_merge=true -F allow_auto_merge=true -F allow_update_branch=true" \
      "-f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK"
    return 0
  fi
  gh api -X PATCH "repos/$REPO" \
    -F delete_branch_on_merge=true \
    -F allow_auto_merge=true \
    -F allow_update_branch=true \
    -f squash_merge_commit_title=PR_TITLE \
    -f squash_merge_commit_message=BLANK >/dev/null
}

verify() {
  local expected_fields=(delete_branch_on_merge allow_auto_merge allow_update_branch squash_merge_commit_title squash_merge_commit_message)
  local expected_arr=(true true true PR_TITLE BLANK)
  local actual
  # "|"-joined, with nulls mapped to "": join(" ") silently collapses a null
  # field to an empty string, and a space-delimited empty field is then lost
  # entirely by bash's default (whitespace-collapsing) word-splitting below.
  actual="$(gh api "repos/$REPO" --jq \
    '[.delete_branch_on_merge, .allow_auto_merge, .allow_update_branch, .squash_merge_commit_title, .squash_merge_commit_message] | map(if . == null then "" else (.|tostring) end) | join("|")')"

  local actual_arr
  IFS='|' read -r -a actual_arr <<<"$actual"

  local i mismatch=0
  for i in "${!expected_fields[@]}"; do
    if [ "${expected_arr[$i]}" != "${actual_arr[$i]:-}" ]; then
      echo "MISMATCH: ${expected_fields[$i]} expected=${expected_arr[$i]} actual=${actual_arr[$i]:-}" >&2
      mismatch=1
    fi
  done
  if [ "$mismatch" -ne 0 ]; then
    return 1
  fi

  echo "PASS: $REPO merge settings confirmed — delete_branch_on_merge=true allow_auto_merge=true allow_update_branch=true squash_merge_commit_title=PR_TITLE squash_merge_commit_message=BLANK"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  apply
  if [ "$DRY_RUN" = "1" ]; then
    exit 0
  fi
  verify
fi
