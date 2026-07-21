#!/usr/bin/env bash
# Periodic auto-merge sweep for on-par/{sound-buddy,software-factory,launchblitz}.
# Lands any open, non-draft, mergeable PR whose CI checks are ALL green.
# Requested by Patrick 2026-07-13: auto-merge "for right now" across all three repos
# while the factory supervisors (sb-factory/sf-factory/lb-factory tmux sessions) build.
set -uo pipefail

REPOS=(sound-buddy software-factory launchblitz)

FACTORY_BIN="${FACTORY_BIN:-$HOME/.local/bin/factory}"
REPO_ROOT="${REPO_ROOT:-/Users/moltbot/repos/on-par}"
SLEEP_SECONDS="${SLEEP_SECONDS:-300}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

sweep_repo() {
  local repo="$1"
  local repo_dir="$REPO_ROOT/$repo"
  local ghrepo="on-par/$repo"

  local pr_json gh_exit
  pr_json="$(gh pr list --repo "$ghrepo" --state open \
    --json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences 2>&1)"
  gh_exit=$?
  if [ "$gh_exit" -ne 0 ]; then
    log "$repo: gh pr list failed (exit $gh_exit): $pr_json" >&2
    return
  fi

  printf '%s' "$pr_json" | python3 -c '
import json, sys
raw = sys.stdin.read()
prs = json.loads(raw) if raw.strip() else []
for pr in prs:
    if pr["isDraft"]:
        continue
    if pr.get("mergeable") != "MERGEABLE":
        continue
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        continue
    states = {c.get("conclusion") or c.get("state") for c in checks}
    if states != {"SUCCESS"}:
        continue
    refs = pr.get("closingIssuesReferences") or []
    issue = refs[0]["number"] if refs else ""
    num = pr["number"]
    print(f"{num}\t{issue}")
' | while IFS=$'\t' read -r pr issue; do
    [ -z "$pr" ] && continue
    if [ -n "$issue" ]; then
      log "$repo: landing issue #$issue (PR #$pr) via factory land"
      if (cd "$repo_dir" && "$FACTORY_BIN" land "$issue") 2>&1; then
        log "$repo: landed #$issue (PR #$pr)"
      else
        log "$repo: FAILED to land #$issue (PR #$pr) (exit $?)"
      fi
    else
      log "$repo: merging standalone PR #$pr via gh"
      if gh pr merge "$pr" --repo "$ghrepo" --squash --delete-branch 2>&1; then
        log "$repo: merged PR #$pr"
      else
        log "$repo: FAILED to merge PR #$pr (exit $?)"
      fi
    fi
  done
}

run_sweep_loop() {
  while true; do
    for r in "${REPOS[@]}"; do
      sweep_repo "$r"
    done
    sleep "$SLEEP_SECONDS"
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_sweep_loop
fi
