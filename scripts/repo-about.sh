#!/usr/bin/env bash
# Idempotent apply + verify for the GitHub "About" metadata (issue #2158): a
# description that leads with the issue -> constitution-checked PR wedge, plus
# discoverability topics (never `saas`). Follows scripts/repo-merge-settings.sh:
# `gh api` for both apply and verify. PUT /topics replaces the whole topic set,
# so a stray topic is removed. This script never sends `homepage`; verify()
# requires it to stay empty.
#
# Re-running against already-correct metadata re-applies the same values and
# passes verification (idempotent). Run by a maintainer after merge; BUILD must
# not run it without DRY_RUN=1.
#
# Env overrides:
#   REPO      GitHub repo as owner/name (default: on-par/software-factory)
#   DRY_RUN   when "1", print the would-be commands instead of executing them
set -euo pipefail

REPO="${REPO:-on-par/software-factory}"
DRY_RUN="${DRY_RUN:-0}"

DESCRIPTION='Local CLI: GitHub issue → constitution-checked PR (PLAN→BUILD→CHECK→SHIP) with multi-model routing and cost tracking.'
# Already sorted alphabetically (verify() compares against the sorted live set).
TOPICS=(ai-agents automation cli code-review developer-tools github llm pull-requests typescript)

apply() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: gh api -X PATCH repos/$REPO -f description=$DESCRIPTION"
    local t topic_flags=""
    for t in "${TOPICS[@]}"; do
      topic_flags+=" -f names[]=$t"
    done
    echo "DRY_RUN: gh api -X PUT repos/$REPO/topics$topic_flags"
    return 0
  fi
  gh api -X PATCH "repos/$REPO" -f description="$DESCRIPTION" >/dev/null
  local args=() t
  for t in "${TOPICS[@]}"; do
    args+=(-f "names[]=$t")
  done
  gh api -X PUT "repos/$REPO/topics" "${args[@]}" >/dev/null
}

verify() {
  local actual desc topics homepage
  actual="$(gh api "repos/$REPO" --jq \
    '[(.description // ""), ((.topics // []) | sort | join(",")), (.homepage // "")] | join("|")')"
  IFS='|' read -r desc topics homepage <<<"$actual"

  local expected_topics
  expected_topics="$(IFS=,; echo "${TOPICS[*]}")"

  local mismatch=0
  if [ "$desc" != "$DESCRIPTION" ]; then
    echo "MISMATCH: description expected=$DESCRIPTION actual=$desc" >&2
    mismatch=1
  fi
  if [ "$topics" != "$expected_topics" ]; then
    echo "MISMATCH: topics expected=$expected_topics actual=$topics" >&2
    mismatch=1
  fi
  if [[ ",$topics," == *",saas,"* ]]; then
    echo "MISMATCH: topics contain forbidden 'saas'" >&2
    mismatch=1
  fi
  if [ -n "${homepage:-}" ]; then
    echo "MISMATCH: homepage expected= actual=$homepage" >&2
    mismatch=1
  fi
  if [ "$mismatch" -ne 0 ]; then
    return 1
  fi

  echo "PASS: $REPO About confirmed — description, topics=$expected_topics, homepage empty"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  apply
  if [ "$DRY_RUN" = "1" ]; then
    exit 0
  fi
  verify
fi
