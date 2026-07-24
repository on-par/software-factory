#!/usr/bin/env bash
# Periodic auto-merge sweep for on-par/{sound-buddy,software-factory,launchblitz}.
# Lands any open, non-draft, mergeable PR whose CI checks are ALL green.
# Requested by Patrick 2026-07-13: auto-merge "for right now" across all three repos
# while the factory supervisors (sb-factory/sf-factory/lb-factory tmux sessions) build.
# Runs under launchd via scripts/launchd/com.on-par.auto-merge-sweep.plist (KeepAlive
# restarts it on crash). Writes a heartbeat to ~/.factory/auto-merge-sweep.heartbeat
# (override with HEARTBEAT_FILE) at the end of every completed pass so a monitor can
# detect a stalled/dead sweeper.
set -uo pipefail

REPOS=(sound-buddy software-factory launchblitz)

FACTORY_BIN="${FACTORY_BIN:-$HOME/.local/bin/factory}"
REPO_ROOT="${REPO_ROOT:-/Users/moltbot/repos/on-par}"
SLEEP_SECONDS="${SLEEP_SECONDS:-300}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-$HOME/.factory/auto-merge-sweep.heartbeat}"

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
      if [ ! -d "$repo_dir" ]; then
        log "$repo: repo dir missing: $repo_dir"
        continue
      fi
      log "$repo: landing issue #$issue (PR #$pr) via factory land"
      if (cd "$repo_dir" && "$FACTORY_BIN" land "$issue") 2>&1; then
        log "$repo: landed #$issue (PR #$pr)"
      else
        log "$repo: FAILED to land #$issue (PR #$pr) (exit $?)"
      fi
    else
      local merge_args=(--squash --delete-branch)
      if [ "${FACTORY_MERGE_ADMIN:-0}" = "1" ]; then
        merge_args+=(--admin)
      fi
      log "$repo: merging standalone PR #$pr via gh"
      if gh pr merge "$pr" --repo "$ghrepo" "${merge_args[@]}" 2>&1; then
        log "$repo: merged PR #$pr"
      else
        log "$repo: FAILED to merge PR #$pr (exit $?)"
      fi
    fi
  done
}

write_heartbeat() {
  mkdir -p "$(dirname "$HEARTBEAT_FILE")"
  date '+%Y-%m-%dT%H:%M:%S%z' >"$HEARTBEAT_FILE"
}

sweep_once() {
  for r in "${REPOS[@]}"; do
    sweep_repo "$r"
  done
  write_heartbeat
}

run_sweep_loop() {
  while true; do
    sweep_once
    sleep "$SLEEP_SECONDS"
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_sweep_loop
fi
