#!/usr/bin/env bash
# Periodic auto-merge sweep for a configurable list of repos under one GitHub org.
# Lands any open, non-draft, mergeable PR whose CI checks are ALL green.
# Requested by Patrick 2026-07-13: auto-merge "for right now" across all three repos
# while the factory supervisors (sb-factory/sf-factory/lb-factory tmux sessions) build.
# Runs under launchd via scripts/launchd/com.on-par.auto-merge-sweep.plist (KeepAlive
# restarts it on crash). Writes a heartbeat to ~/.factory/auto-merge-sweep.heartbeat
# (override with HEARTBEAT_FILE) at the end of every completed pass so a monitor can
# detect a stalled/dead sweeper. Every log line is also appended to a dated persistent
# log at ~/.local/state/auto-merge-sweep.log (override with LOG_FILE). On a sweep-wide
# failure (every repo's `gh pr list`
# failed), the sleep between passes doubles each consecutive failing pass up to
# MAX_SLEEP_SECONDS (default 3600), resetting to SLEEP_SECONDS as soon as a pass
# succeeds again. PRs that close more than one issue are skipped with an explicit
# SKIPPING log line (factory land takes exactly one issue); they must be landed
# manually.
#
# All config below is env-overridable, each defined exactly once:
#   ORG               GitHub org (default: on-par)
#   REPO_ROOT         local checkout root (default: $HOME/repos/$ORG)
#   SWEEP_REPOS       space-separated repo names under $ORG / $REPO_ROOT
#                     (default: sound-buddy software-factory launchblitz)
#   FACTORY_BIN       factory CLI path (default: `factory` on PATH, else
#                     $HOME/.local/bin/factory)
#   MERGE_FLAGS       flags passed to `gh pr merge` for standalone PRs
#                     (default: --squash --delete-branch)
#   SLEEP_SECONDS     delay between passes (default: 300)
#   MAX_SLEEP_SECONDS backoff cap on sweep-wide failure (default: 3600)
#   HEARTBEAT_FILE    heartbeat path (default: ~/.factory/auto-merge-sweep.heartbeat)
#   LOG_FILE          persistent log path (default: ~/.local/state/auto-merge-sweep.log)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All config is env-overridable; each value is defined exactly once here.
ORG="${ORG:-on-par}"
REPO_ROOT="${REPO_ROOT:-$HOME/repos/$ORG}"
FACTORY_BIN="${FACTORY_BIN:-$(command -v factory || echo "$HOME/.local/bin/factory")}"
# Space-separated repo names under $ORG / $REPO_ROOT.
IFS=' ' read -r -a REPOS <<<"${SWEEP_REPOS:-sound-buddy software-factory launchblitz}"
# Flags passed to `gh pr merge` for standalone PRs (word-split; no spaces within a flag).
MERGE_FLAGS="${MERGE_FLAGS:---squash --delete-branch}"
SLEEP_SECONDS="${SLEEP_SECONDS:-300}"
MAX_SLEEP_SECONDS="${MAX_SLEEP_SECONDS:-3600}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-$HOME/.factory/auto-merge-sweep.heartbeat}"
LOG_FILE="${LOG_FILE:-$HOME/.local/state/auto-merge-sweep.log}"
mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }

preflight() {
  local ok=0
  for bin in gh python3; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "FATAL: $bin not found on PATH" >&2
      ok=1
    fi
  done
  if [ ! -x "$FACTORY_BIN" ]; then
    echo "FATAL: factory CLI missing or not executable at $FACTORY_BIN" >&2
    ok=1
  fi
  if [ ! -f "$SCRIPT_DIR/filter-green-prs.py" ]; then
    echo "FATAL: filter script missing: $SCRIPT_DIR/filter-green-prs.py" >&2
    ok=1
  fi
  local r
  for r in "${REPOS[@]}"; do
    if [ ! -d "$REPO_ROOT/$r" ]; then
      echo "FATAL: repo dir missing: $REPO_ROOT/$r" >&2
      ok=1
    fi
  done
  return "$ok"
}

sweep_repo() {
  local repo="$1"
  local repo_dir="$REPO_ROOT/$repo"
  local ghrepo="$ORG/$repo"

  local pr_json gh_exit
  pr_json="$(gh pr list --repo "$ghrepo" --state open \
    --json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences 2>&1)"
  gh_exit=$?
  if [ "$gh_exit" -ne 0 ]; then
    log "$repo: gh pr list failed (exit $gh_exit): $pr_json" >&2
    return 1
  fi

  printf '%s' "$pr_json" | python3 "$SCRIPT_DIR/filter-green-prs.py" | while IFS=$'\t' read -r pr issue; do
    [ -z "$pr" ] && continue
    if [[ "$issue" == *,* ]]; then
      log "$repo: SKIPPING PR #$pr: closes multiple issues (#${issue//,/, #}) — factory land takes exactly one issue; land manually"
      continue
    elif [ -n "$issue" ]; then
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
      local merge_args
      IFS=' ' read -r -a merge_args <<<"$MERGE_FLAGS"
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
  local failures=0
  for r in "${REPOS[@]}"; do
    sweep_repo "$r" || failures=$((failures + 1))
  done
  write_heartbeat
  [ "$failures" -lt "${#REPOS[@]}" ]
}

# Doubles the current delay, clamped to MAX_SLEEP_SECONDS.
next_sleep_seconds() {
  local doubled=$(( $1 * 2 ))
  if [ "$doubled" -gt "$MAX_SLEEP_SECONDS" ]; then
    doubled="$MAX_SLEEP_SECONDS"
  fi
  echo "$doubled"
}

run_sweep_loop() {
  local max_passes="${1:-0}"
  local delay="$SLEEP_SECONDS"
  local passes=0
  while true; do
    if sweep_once; then
      delay="$SLEEP_SECONDS"
    else
      delay="$(next_sleep_seconds "$delay")"
      log "sweep-wide failure: backing off, next sweep in ${delay}s (cap ${MAX_SLEEP_SECONDS}s)" >&2
    fi
    passes=$((passes + 1))
    if [ "$max_passes" -gt 0 ] && [ "$passes" -ge "$max_passes" ]; then
      return 0
    fi
    sleep "$delay"
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  preflight || exit 1
  run_sweep_loop
fi
