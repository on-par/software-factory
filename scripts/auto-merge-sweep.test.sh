#!/usr/bin/env bash
# Regression tests for sweep selection, landing, preview, and loop behavior.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"
REPO_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$BINDIR" "$REPO_ROOT"; }
trap cleanup EXIT
mkdir -p "$REPO_ROOT/fakerepo" "$REPO_ROOT/otherrepo"

export GH_CALL_LOG="$BINDIR/gh-calls.log"
export FACTORY_CALL_LOG="$BINDIR/factory-calls.log"
export SLEEP_CALL_LOG="$BINDIR/sleep-calls.log"
: >"$GH_CALL_LOG"; : >"$FACTORY_CALL_LOG"; : >"$SLEEP_CALL_LOG"

cat >"$BINDIR/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >>"$GH_CALL_LOG"
if [ "$1 $2" = "pr list" ]; then
  if [ "${GH_PR_LIST_FAIL:-0}" = "1" ]; then echo "simulated rate limit" >&2; exit 4; fi
  if [ "${GH_EMPTY_LIST:-0}" = "1" ]; then echo '[]'; exit 0; fi
  cat <<'JSON'
[
 {"number":101,"headRefName":"factory/standalone","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[]},
 {"number":102,"headRefName":"factory/42-x","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":42}]},
 {"number":103,"headRefName":"factory/multi","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":55},{"number":56}]},
 {"number":104,"headRefName":"factory/104","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":44}],"labels":[{"name":"no-auto-merge"}]},
 {"number":105,"headRefName":"factory/105","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":60}]},
 {"number":106,"headRefName":"factory/106","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":61}]},
 {"number":2580,"headRefName":"feat/2245-prerelease-on-merge","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":2580}]}
]
JSON
  exit 0
fi
if [ "$1 $2" = "issue view" ]; then
  case "$3" in 44|60) echo no-auto-merge ;; 61) echo "simulated label failure" >&2; exit 9 ;; esac
  exit 0
fi
if [ "$1 $2" = "pr merge" ]; then echo "unexpected gh merge" >&2; exit 3; fi
exit 0
EOF
chmod +x "$BINDIR/gh"

cat >"$BINDIR/fake-factory" <<'EOF'
#!/usr/bin/env bash
printf 'cwd=%s args=%s\n' "$PWD" "$*" >>"$FACTORY_CALL_LOG"
echo "simulated land failure" >&2
exit 7
EOF
chmod +x "$BINDIR/fake-factory"
cat >"$BINDIR/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SLEEP_CALL_LOG"
exit 0
EOF
chmod +x "$BINDIR/sleep"

export PATH="$BINDIR:$PATH"
export ORG=on-par SWEEP_REPOS=fakerepo REPO_ROOT
export FACTORY_BIN="$BINDIR/fake-factory"
export LOG_FILE="$BINDIR/state/auto-merge-sweep.log"
export HEARTBEAT_FILE="$BINDIR/heartbeat"

fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -qF -- "$2" <<<"$1" || fail "missing '$2'"; }
not_contains() { ! grep -qF -- "$2" <<<"$1" || fail "unexpected '$2'"; }

# Sourcing does not consume the caller's arguments; normal sweep lands only issue 42.
set -- keep these
# shellcheck disable=SC1091
source "$ROOT/scripts/auto-merge-sweep.sh"
[ "$#" -eq 2 ] && [ "$1" = keep ] && [ "$2" = these ] || fail "source consumed positional arguments"
output="$(sweep_repo fakerepo 2>&1)"
contains "$output" "FAILED to land #42 (PR #102) (exit 7)"
contains "$output" "SKIPPING PR #101: closes no issue"
contains "$output" "SKIPPING PR #103: closes multiple issues (#55, #56)"
contains "$output" "SKIPPING PR #2580: not a factory branch"
contains "$output" "SKIPPING PR #104: labelled no-auto-merge"
contains "$output" "SKIPPING PR #105: issue #60 is labelled no-auto-merge"
contains "$output" "SKIPPING PR #106: could not read labels of issue #61 (exit 9)"
contains "$(cat "$LOG_FILE")" "SKIPPING PR #2580"
contains "$(cat "$LOG_FILE")" "FAILED to land #42 (PR #102) (exit 7)"
grep -qF -- '--json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences,labels,headRefName' "$GH_CALL_LOG" || fail "gh list omitted headRefName"
grep -qF "cwd=$REPO_ROOT/fakerepo args=land 42" "$FACTORY_CALL_LOG" || fail "factory land args or cwd wrong"
[ "$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')" = 1 ] || fail "unexpected factory call count"
! grep -qE '^pr merge ' "$GH_CALL_LOG" || fail "gh pr merge was invoked"

# A standalone factory PR never merges even when a legacy admin variable is set.
export FACTORY_MERGE_ADMIN=1
output="$(sweep_repo fakerepo 2>&1)"
contains "$output" "SKIPPING PR #101: closes no issue"
! grep -qE '^pr merge ' "$GH_CALL_LOG" || fail "legacy admin setting enabled gh merge"
unset FACTORY_MERGE_ADMIN

# Existing normal-mode heartbeat and dated persistent logging remain intact.
REPOS=(fakerepo)
sweep_once >/dev/null 2>&1 || true
[ -s "$HEARTBEAT_FILE" ] || fail "normal sweep did not write heartbeat"
grep -Eq '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\] ' "$LOG_FILE" || fail "log timestamps missing"

# Missing repo checkouts are skipped; no factory call occurs for a missing directory.
factory_calls_before_missing="$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')"
output="$(sweep_repo missingrepo 2>&1)"
contains "$output" "missingrepo: repo dir missing: $REPO_ROOT/missingrepo"
[ "$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')" = "$factory_calls_before_missing" ] || fail "missing checkout invoked factory land"

# Preflight checks dependencies, filter script, and configured checkout presence.
if preflight >/dev/null 2>&1; then :; else fail "preflight rejected valid configuration"; fi
output="$( (FACTORY_BIN="$BINDIR/missing"; preflight) 2>&1)" && fail "preflight accepted missing factory"
contains "$output" "FATAL: factory CLI missing or not executable at $BINDIR/missing"
GH_LESS_BIN="$(mktemp -d)"
ln -s "$(command -v python3)" "$GH_LESS_BIN/python3"
output="$( (PATH="$GH_LESS_BIN"; preflight) 2>&1)" && fail "preflight accepted missing gh"
contains "$output" "FATAL: gh not found on PATH"
python3 -c 'from pathlib import Path; import shutil,sys; shutil.rmtree(sys.argv[1])' "$GH_LESS_BIN"
output="$( (SCRIPT_DIR="$BINDIR/missing"; preflight) 2>&1)" && fail "preflight accepted missing filter"
contains "$output" "FATAL: filter script missing: $BINDIR/missing/filter-green-prs.py"
output="$( (REPOS=(missingrepo); preflight) 2>&1)" && fail "preflight accepted all checkouts missing"
contains "$output" "FATAL: no configured repo checkouts found under $REPO_ROOT"
output="$( (REPOS=(fakerepo missingrepo); preflight; echo "REPOS=${REPOS[*]}") 2>&1)" || fail "preflight rejected mixed present/missing checkouts"
contains "$output" "WARN: skipping repo, checkout missing: $REPO_ROOT/missingrepo"
contains "$output" "REPOS=fakerepo"

# Normal loop retains exponential backoff and resets after a successful pass.
: >"$SLEEP_CALL_LOG"
SWEEP_FAIL_COUNT_FILE="$BINDIR/sweep-failures"
echo 3 >"$SWEEP_FAIL_COUNT_FILE"
sweep_once() {
  local remaining
  remaining="$(cat "$SWEEP_FAIL_COUNT_FILE")"
  if [ "$remaining" -gt 0 ]; then
    echo $((remaining - 1)) >"$SWEEP_FAIL_COUNT_FILE"
    return 1
  fi
  return 0
}
SLEEP_SECONDS=300 MAX_SLEEP_SECONDS=1000 run_sweep_loop 5 >/dev/null 2>&1
expected_sleeps=$'600\n1000\n1000\n300'
[ "$(cat "$SLEEP_CALL_LOG")" = "$expected_sleeps" ] || fail "normal-loop backoff sequence changed"
unset -f sweep_once

# Missing repo, gh failure aggregation, and backoff behavior.
output="$(sweep_repo missingrepo 2>&1)"
contains "$output" "repo dir missing: $REPO_ROOT/missingrepo"
export GH_PR_LIST_FAIL=1
if sweep_repo fakerepo >/dev/null 2>&1; then fail "gh list failure was swallowed"; fi
if sweep_once >/dev/null 2>&1; then fail "sweep_once ignored all-repo failure"; fi
unset GH_PR_LIST_FAIL
MAX_SLEEP_SECONDS=3600
[ "$(next_sleep_seconds 300)" = 600 ] || fail "backoff doubling failed"
[ "$(next_sleep_seconds 1800)" = 3600 ] || fail "backoff cap failed"

# Executable dry-run: one pass, no land/merge/sleep/heartbeat mutation.
run_preview() {
  local heartbeat="$1" output_file="$2"; shift 2
  env PATH="$PATH" ORG=on-par SWEEP_REPOS="fakerepo otherrepo" REPO_ROOT="$REPO_ROOT" \
    FACTORY_BIN="$FACTORY_BIN" LOG_FILE="$BINDIR/preview.log" HEARTBEAT_FILE="$heartbeat" \
    GH_CALL_LOG="$GH_CALL_LOG" FACTORY_CALL_LOG="$FACTORY_CALL_LOG" SLEEP_CALL_LOG="$SLEEP_CALL_LOG" \
    "$ROOT/scripts/auto-merge-sweep.sh" "$@" >"$output_file" 2>&1
}
: >"$GH_CALL_LOG"; : >"$FACTORY_CALL_LOG"; : >"$SLEEP_CALL_LOG"
rm -f "$BINDIR/preview.log" "$BINDIR/preview-heartbeat"
run_preview "$BINDIR/preview-heartbeat" "$BINDIR/preview.out" --dry-run || fail "dry-run failed"
preview="$(cat "$BINDIR/preview.out")"
contains "$preview" "WOULD land #42 (PR #102)"
contains "$preview" "SKIPPING PR #2580: not a factory branch"
contains "$preview" "SKIPPING PR #104: labelled no-auto-merge"
contains "$preview" "SKIPPING PR #105: issue #60 is labelled no-auto-merge"
contains "$preview" "SKIPPING PR #106: could not read labels of issue #61"
[ "$(grep -c '^pr list ' "$GH_CALL_LOG")" = 2 ] || fail "preview did not list each repo exactly once"
[ ! -s "$FACTORY_CALL_LOG" ] || fail "preview invoked factory land"
! grep -qE '^pr merge ' "$GH_CALL_LOG" || fail "preview invoked gh merge"
[ ! -s "$SLEEP_CALL_LOG" ] || fail "preview slept"
[ ! -e "$BINDIR/preview-heartbeat" ] || fail "preview created heartbeat"
grep -qF "WOULD land #42 (PR #102)" "$BINDIR/preview.log" || fail "preview decision not persisted"
grep -qF "SKIPPING PR #2580: not a factory branch" "$BINDIR/preview.log" || fail "preview branch skip not persisted"

printf 'sentinel heartbeat\n' >"$BINDIR/sentinel-heartbeat"
run_preview "$BINDIR/sentinel-heartbeat" "$BINDIR/preview-existing.out" --dry-run || fail "dry-run with sentinel failed"
[ "$(cat "$BINDIR/sentinel-heartbeat")" = "sentinel heartbeat" ] || fail "preview changed existing heartbeat"

# Empty candidate and gh-list failure still complete one preview pass successfully.
env PATH="$PATH" ORG=on-par SWEEP_REPOS=fakerepo REPO_ROOT="$REPO_ROOT" FACTORY_BIN="$FACTORY_BIN" \
  GH_EMPTY_LIST=1 GH_CALL_LOG="$GH_CALL_LOG" FACTORY_CALL_LOG="$FACTORY_CALL_LOG" SLEEP_CALL_LOG="$SLEEP_CALL_LOG" \
  HEARTBEAT_FILE="$BINDIR/empty-hb" LOG_FILE="$BINDIR/empty.log" "$ROOT/scripts/auto-merge-sweep.sh" --dry-run >/dev/null 2>&1 || fail "empty preview failed"
[ ! -e "$BINDIR/empty-hb" ] || fail "empty preview wrote heartbeat"
env PATH="$PATH" ORG=on-par SWEEP_REPOS=fakerepo REPO_ROOT="$REPO_ROOT" FACTORY_BIN="$FACTORY_BIN" \
  GH_PR_LIST_FAIL=1 GH_CALL_LOG="$GH_CALL_LOG" FACTORY_CALL_LOG="$FACTORY_CALL_LOG" SLEEP_CALL_LOG="$SLEEP_CALL_LOG" \
  HEARTBEAT_FILE="$BINDIR/fail-hb" LOG_FILE="$BINDIR/fail.log" "$ROOT/scripts/auto-merge-sweep.sh" --dry-run >"$BINDIR/fail.out" 2>&1 || fail "failed-list preview did not exit 0"
grep -qF 'gh pr list failed (exit 4)' "$BINDIR/fail.log" || fail "preview gh failure not logged"
[ ! -e "$BINDIR/fail-hb" ] || fail "failed preview wrote heartbeat"

# Only no arguments or exactly one --dry-run are accepted, before preflight.
gh_calls_before_args="$(wc -l <"$GH_CALL_LOG" | tr -d ' ')"
for args in 'bad' '--dry-run --dry-run' '--dry-run bad' 'positional'; do
  set -- $args
  rc=0
  env ORG=on-par SWEEP_REPOS=fakerepo REPO_ROOT="$REPO_ROOT" FACTORY_BIN="$FACTORY_BIN" \
    GH_CALL_LOG="$GH_CALL_LOG" FACTORY_CALL_LOG="$FACTORY_CALL_LOG" SLEEP_CALL_LOG="$SLEEP_CALL_LOG" \
    "$ROOT/scripts/auto-merge-sweep.sh" "$@" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "invalid arguments accepted: $args"
done
[ "$(wc -l <"$GH_CALL_LOG" | tr -d ' ')" = "$gh_calls_before_args" ] || fail "invalid arguments started a sweep"

# Preflight retains missing-config and missing-factory behavior.
usage_out="$(env -u ORG -u SWEEP_REPOS "$ROOT/scripts/auto-merge-sweep.sh" 2>&1)"
contains "$usage_out" "Usage:"
rc=0
env ORG=on-par SWEEP_REPOS=fakerepo REPO_ROOT="$REPO_ROOT" FACTORY_BIN="$BINDIR/missing" "$ROOT/scripts/auto-merge-sweep.sh" --dry-run >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] || fail "preview did not enforce factory preflight"

# Sourced defaults remain stable; the factory executable fallback and repo derivation are covered.
repos="$(SWEEP_REPOS='alpha beta' bash -c 'source "$1"; echo "${REPOS[*]}"' _ "$ROOT/scripts/auto-merge-sweep.sh")"
[ "$repos" = 'alpha beta' ] || fail "SWEEP_REPOS source-time parsing failed"
repo_default="$(env -u REPO_ROOT ORG=xyz bash -c 'source "$1"; echo "$REPO_ROOT"' _ "$ROOT/scripts/auto-merge-sweep.sh")"
[ "$repo_default" = "$HOME/repos/xyz" ] || fail "REPO_ROOT default failed"
repos_default="$(env -u SWEEP_REPOS bash -c 'source "$1"; echo "[$SWEEP_REPOS:${REPOS[*]+${REPOS[*]}}]"' _ "$ROOT/scripts/auto-merge-sweep.sh")"
[ "$repos_default" = '[:]' ] || fail "empty SWEEP_REPOS default failed"
cat >"$BINDIR/factory" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$BINDIR/factory"
factory_path="$(env -u FACTORY_BIN PATH="$BINDIR:$PATH" bash -c 'source "$1"; echo "$FACTORY_BIN"' _ "$ROOT/scripts/auto-merge-sweep.sh")"
[ "$factory_path" = "$BINDIR/factory" ] || fail "FACTORY_BIN did not resolve through PATH"

echo "PASS: sweep filters to one-issue factory PRs, lands only through factory land, previews one pass without mutations, and retains normal logging, heartbeat, preflight, and backoff behavior"
