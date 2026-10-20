#!/usr/bin/env bash
# Periodic auto-merge sweep for a configurable list of repos under one GitHub org.
# Lands green factory-branch PRs closing exactly one issue through factory land.
# Added 2026-07-13: auto-merge across the configured repos
# while the factory supervisors (per-repo tmux sessions) build.
# Runs under launchd via scripts/launchd/com.on-par.auto-merge-sweep.plist (KeepAlive
# restarts it on crash). Writes a heartbeat to ~/.factory/auto-merge-sweep.heartbeat
# (override with HEARTBEAT_FILE) at the end of every completed pass so a monitor can
# detect a stalled/dead sweeper. See docs/runbooks/sweep-heartbeat.md for how factory
# doctor/status consume this file. Every log line is also appended to a dated persistent
# log at ~/.local/state/auto-merge-sweep.log (override with LOG_FILE). On a sweep-wide
# failure (every repo's `gh pr list`
# failed), the sleep between passes doubles each consecutive failing pass up to
# MAX_SLEEP_SECONDS (default 3600), resetting to SLEEP_SECONDS as soon as a pass
# succeeds again. PRs outside BRANCH_PREFIX or closing other than exactly one issue
# receive an explicit SKIPPING log line. PRs labelled GATE_LABEL, or whose closing issue is labelled GATE_LABEL (or
# whose labels can't be read), are skipped with a SKIPPING log line (human merge required).
#
# Usage: ORG=owner SWEEP_REPOS="example-app other-app" scripts/auto-merge-sweep.sh
# Preview once without landing: ORG=owner SWEEP_REPOS="example-app" scripts/auto-merge-sweep.sh --dry-run
#
# All config below is env-overridable, each defined exactly once:
#   ORG               GitHub org (default: empty — required; see usage guard below)
#   REPO_ROOT         local checkout root (default: $HOME/repos/$ORG)
#   SWEEP_REPOS       space-separated repo names under $ORG / $REPO_ROOT
#                     (default: empty — required; see usage guard below).
#                     A repo whose checkout is missing under $REPO_ROOT is
#                     skipped with a WARN each preflight, not a fatal error;
#                     hosts that only run a subset of repos can set SWEEP_REPOS
#                     to just the repos they have. Preflight still fails fast
#                     when every configured checkout is missing.
#   FACTORY_BIN       factory CLI path (default: `factory` on PATH, else
#                     $HOME/.local/bin/factory)
#   BRANCH_PREFIX     required literal prefix for eligible PR heads (default: factory/)
#   GATE_LABEL        label marking a PR/issue as needing a human merge (default:
#                     no-auto-merge; should match the repo's filing.selfFixLabel)
#   SLEEP_SECONDS     delay between passes (default: 300)
#   MAX_SLEEP_SECONDS backoff cap on sweep-wide failure (default: 3600)
#   HEARTBEAT_FILE    heartbeat path (default: ~/.factory/auto-merge-sweep.heartbeat)
#   LOG_FILE          persistent log path (default: ~/.local/state/auto-merge-sweep.log)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All config is env-overridable; each value is defined exactly once here.
ORG="${ORG:-}"
REPO_ROOT="${REPO_ROOT:-$HOME/repos/$ORG}"
FACTORY_BIN="${FACTORY_BIN:-$(command -v factory || echo "$HOME/.local/bin/factory")}"
# Space-separated repo names under $ORG / $REPO_ROOT.
SWEEP_REPOS="${SWEEP_REPOS:-}"
IFS=' ' read -r -a REPOS <<<"$SWEEP_REPOS"
BRANCH_PREFIX="${BRANCH_PREFIX:-factory/}"
export BRANCH_PREFIX
DRY_RUN=0
# Label that marks a PR/issue as needing a human merge; the sweep never merges it.
GATE_LABEL="${GATE_LABEL:-no-auto-merge}"
export GATE_LABEL
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
  # A missing checkout is a per-repo skip, not a sweep-wide fatal: hosts that
  # only run a subset of repos (see SWEEP_REPOS) still sweep what they have.
  local r present=()
  for r in "${REPOS[@]+"${REPOS[@]}"}"; do
    if [ -d "$REPO_ROOT/$r" ]; then
      present+=("$r")
    else
      log "WARN: skipping repo, checkout missing: $REPO_ROOT/$r" >&2
    fi
  done
  if [ "${#present[@]}" -eq 0 ]; then
    echo "FATAL: no configured repo checkouts found under $REPO_ROOT (SWEEP_REPOS: ${REPOS[*]})" >&2
    ok=1
  else
    REPOS=("${present[@]}")
  fi
  return "$ok"
}

sweep_repo() {
  local repo="$1"
  local repo_dir="$REPO_ROOT/$repo"
  local ghrepo="$ORG/$repo"

  local pr_json gh_exit
  pr_json="$(gh pr list --repo "$ghrepo" --state open \
    --json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences,labels,headRefName 2>&1)"
  gh_exit=$?
  if [ "$gh_exit" -ne 0 ]; then
    log "$repo: gh pr list failed (exit $gh_exit): $pr_json" >&2
    return 1
  fi

  local filter_output filter_exit
  filter_output="$(printf '%s' "$pr_json" | python3 "$SCRIPT_DIR/filter-green-prs.py" 2>&1)"
  filter_exit=$?
  if [ "$filter_exit" -ne 0 ]; then
    log "$repo: filter-green-prs.py failed (exit $filter_exit): $filter_output" >&2
    return 1
  fi

  while IFS= read -r line; do
    if [[ "$line" == "SKIPPING PR #"* ]]; then
      log "$repo: $line"
      continue
    fi
    # Validate tabs explicitly: `read` with a tab IFS collapses empty columns.
    local pr issue gated rest record_pattern
    record_pattern=$'^[0-9]+\t[0-9]+\t(gated)?$'
    if [[ ! "$line" =~ $record_pattern ]]; then
      [ -z "$line" ] && continue
      log "$repo: ignoring invalid filter record: $line" >&2
      continue
    fi
    pr="${line%%$'\t'*}"
    rest="${line#*$'\t'}"
    issue="${rest%%$'\t'*}"
    gated="${rest#*$'\t'}"
    if [ -n "$gated" ]; then
      log "$repo: SKIPPING PR #$pr: labelled $GATE_LABEL — awaiting human merge"
      continue
    fi
    if [ -n "$issue" ]; then
      if [ ! -d "$repo_dir" ]; then
        log "$repo: repo dir missing: $repo_dir"
        continue
      fi
      local issue_labels label_exit
      issue_labels="$(gh issue view "$issue" --repo "$ghrepo" --json labels --jq '.labels[].name' </dev/null 2>&1)"
      label_exit=$?
      if [ "$label_exit" -ne 0 ]; then
        log "$repo: SKIPPING PR #$pr: could not read labels of issue #$issue (exit $label_exit) — failing closed on $GATE_LABEL"
        continue
      fi
      if grep -qxF -- "$GATE_LABEL" <<<"$issue_labels"; then
        log "$repo: SKIPPING PR #$pr: issue #$issue is labelled $GATE_LABEL — awaiting human merge"
        continue
      fi
      if [ "$DRY_RUN" = "1" ]; then
        log "$repo: WOULD land #$issue (PR #$pr)"
      else
        log "$repo: landing issue #$issue (PR #$pr) via factory land"
        if (cd "$repo_dir" && "$FACTORY_BIN" land "$issue") 2>&1; then
          log "$repo: landed #$issue (PR #$pr)"
        else
          local land_exit=$?
          log "$repo: FAILED to land #$issue (PR #$pr) (exit $land_exit)"
        fi
      fi
    fi
  done <<<"$filter_output"
}

write_heartbeat() {
  mkdir -p "$(dirname "$HEARTBEAT_FILE")"
  date '+%Y-%m-%dT%H:%M:%S%z' >"$HEARTBEAT_FILE"
}

sweep_once() {
  local failures=0
  for r in "${REPOS[@]+"${REPOS[@]}"}"; do
    sweep_repo "$r" || failures=$((failures + 1))
  done
  if [ "$DRY_RUN" != "1" ]; then
    write_heartbeat
  fi
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
  if [ "$#" -gt 0 ]; then
    if [ "$#" -ne 1 ] || [ "$1" != "--dry-run" ]; then
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
    fi
    DRY_RUN=1
  fi
  if [ -z "$ORG" ] || [ -z "$SWEEP_REPOS" ]; then
    echo "Usage: ORG=owner SWEEP_REPOS=\"example-app other-app\" $0 — both are required; refusing to run with an empty ORG or SWEEP_REPOS"
    exit 0
  fi
  preflight || exit 1
  if [ "$DRY_RUN" = "1" ]; then
    sweep_once || true
    exit 0
  fi
  run_sweep_loop
fi
