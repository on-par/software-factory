#!/usr/bin/env bash
# Periodic auto-merge sweep for on-par/{sound-buddy,software-factory,launchblitz}.
# Lands any open, non-draft, mergeable PR whose CI checks are ALL green.
# Requested by Patrick 2026-07-13: auto-merge "for right now" across all three repos
# while the factory supervisors (sb-factory/sf-factory/lb-factory tmux sessions) build.
set -uo pipefail

REPOS=(sound-buddy software-factory launchblitz)

sweep_repo() {
  local repo="$1"
  local repo_dir="/Users/moltbot/repos/on-par/$repo"
  local ghrepo="on-par/$repo"

  local pr_json gh_exit
  pr_json="$(gh pr list --repo "$ghrepo" --state open \
    --json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences 2>&1)"
  gh_exit=$?
  if [ "$gh_exit" -ne 0 ]; then
    echo "[$(date '+%H:%M:%S')] $repo: gh pr list failed (exit $gh_exit): $pr_json" >&2
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
      echo "[$(date '+%H:%M:%S')] $repo: landing issue #$issue (PR #$pr) via factory land"
      (cd "$repo_dir" && ~/.local/bin/factory land "$issue") 2>&1
    else
      echo "[$(date '+%H:%M:%S')] $repo: merging standalone PR #$pr via gh"
      gh pr merge "$pr" --repo "$ghrepo" --squash --delete-branch 2>&1
    fi
  done
}

while true; do
  for r in "${REPOS[@]}"; do
    sweep_repo "$r"
  done
  sleep 300
done
