#!/usr/bin/env bash
# Regression test for auto-merge-sweep.sh: proves that a failing `gh pr merge`
# and a failing `factory land` are each logged as an explicit FAILURE line
# carrying the command's real non-zero exit code, instead of being silently
# swallowed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"
REPO_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR" "$REPO_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO_ROOT/fakerepo"

FACTORY_CALL_LOG="$BINDIR/factory-calls.log"
: >"$FACTORY_CALL_LOG"

GH_CALL_LOG="$BINDIR/gh-calls.log"
export GH_CALL_LOG
: >"$GH_CALL_LOG"

cat >"$BINDIR/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
if [ "$1 $2" = "pr list" ]; then
  if [ "${GH_PR_LIST_FAIL:-0}" = "1" ]; then
    echo "simulated rate limit" >&2
    exit 4
  fi
  cat <<'JSON'
[
  {
    "number": 101,
    "isDraft": false,
    "mergeable": "MERGEABLE",
    "statusCheckRollup": [{"conclusion": "SUCCESS"}],
    "closingIssuesReferences": []
  },
  {
    "number": 102,
    "isDraft": false,
    "mergeable": "MERGEABLE",
    "statusCheckRollup": [{"conclusion": "SUCCESS"}],
    "closingIssuesReferences": [{"number": 42}]
  },
  {
    "number": 103,
    "isDraft": false,
    "mergeable": "MERGEABLE",
    "statusCheckRollup": [{"conclusion": "SUCCESS"}],
    "closingIssuesReferences": [{"number": 55}, {"number": 56}]
  }
]
JSON
  exit 0
elif [ "$1 $2" = "pr merge" ]; then
  echo "$@" >>"${GH_CALL_LOG}"
  echo "simulated merge failure" >&2
  exit 3
fi
exit 0
EOF
chmod +x "$BINDIR/gh"

cat >"$BINDIR/fake-factory" <<EOF
#!/usr/bin/env bash
echo "called" >>"$FACTORY_CALL_LOG"
echo "simulated land failure" >&2
exit 7
EOF
chmod +x "$BINDIR/fake-factory"

export PATH="$BINDIR:$PATH"
export FACTORY_BIN="$BINDIR/fake-factory"
export REPO_ROOT
export LOG_FILE="$BINDIR/state/auto-merge-sweep.log"

# shellcheck disable=SC1091
source "$ROOT/scripts/auto-merge-sweep.sh"

unset FACTORY_MERGE_ADMIN
output="$(sweep_repo fakerepo 2>&1)"

# Usage: assert_line contains|not_contains "<needle>"
assert_line() {
  local mode="$1" needle="$2" found=1
  grep -qF "$needle" <<<"$output" && found=0
  if { [ "$mode" = "contains" ] && [ "$found" -ne 0 ]; } || { [ "$mode" = "not_contains" ] && [ "$found" -eq 0 ]; }; then
    echo "FAIL: expected output to $mode: $needle" >&2
    echo "--- actual output ---" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_line contains "FAILED to merge PR #101 (exit 3)"
assert_line contains "FAILED to land #42 (PR #102) (exit 7)"
assert_line not_contains "merged PR #101"
assert_line not_contains "landed #42"
assert_line contains "SKIPPING PR #103: closes multiple issues (#55, #56)"
assert_line not_contains "landing issue #55"
assert_line not_contains "merging standalone PR #103"

# --- log persistence: log() tees dated lines to LOG_FILE, creating its dir ---

if [ ! -f "$LOG_FILE" ]; then
  echo "FAIL: expected log file to be created at $LOG_FILE" >&2
  exit 1
fi
grep -qF "FAILED to merge PR #101 (exit 3)" "$LOG_FILE" || {
  echo "FAIL: merge failure line not persisted to $LOG_FILE" >&2; exit 1; }
grep -qF "FAILED to land #42 (PR #102) (exit 7)" "$LOG_FILE" || {
  echo "FAIL: land failure line not persisted to $LOG_FILE" >&2; exit 1; }
grep -qF "SKIPPING PR #103" "$LOG_FILE" || {
  echo "FAIL: skip line not persisted to $LOG_FILE" >&2; exit 1; }
if grep -Evq '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\] ' "$LOG_FILE"; then
  echo "FAIL: log file contains lines without a full dated timestamp" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# append, not truncate: line count grows across runs
log_lines_before="$(wc -l <"$LOG_FILE" | tr -d ' ')"

if [ "$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')" != "1" ]; then
  echo "FAIL: factory land call count wrong — multi-issue PR #103 may have been landed" >&2
  exit 1
fi

calls_before_missing_dir="$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')"

missing_repo_dir="$REPO_ROOT/missingrepo"
output="$(sweep_repo missingrepo 2>&1)"
assert_line contains "missingrepo: repo dir missing: $missing_repo_dir"
assert_line not_contains "landed #42"
assert_line not_contains "FAILED to land #42"

calls_after_missing_dir="$(wc -l <"$FACTORY_CALL_LOG" | tr -d ' ')"
if [ "$calls_after_missing_dir" != "$calls_before_missing_dir" ]; then
  echo "FAIL: factory land was invoked despite missing repo dir" >&2
  exit 1
fi

# --- admin merge flag: default path omits --admin ---

if ! grep -q -- "--squash --delete-branch" "$GH_CALL_LOG"; then
  echo "FAIL: expected gh pr merge call to include --squash --delete-branch" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi
if grep -q -- "--admin" "$GH_CALL_LOG"; then
  echo "FAIL: gh pr merge call included --admin without FACTORY_MERGE_ADMIN=1" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi

# --- admin merge flag: FACTORY_MERGE_ADMIN=1 adds --admin ---

: >"$GH_CALL_LOG"
export FACTORY_MERGE_ADMIN=1
output="$(sweep_repo fakerepo 2>&1)"
unset FACTORY_MERGE_ADMIN

assert_line contains "FAILED to merge PR #101 (exit 3)"

log_lines_after="$(wc -l <"$LOG_FILE" | tr -d ' ')"
if [ "$log_lines_after" -le "$log_lines_before" ]; then
  echo "FAIL: log file did not grow across runs — tee -a not appending" >&2
  exit 1
fi

if ! grep -q -- "--admin" "$GH_CALL_LOG"; then
  echo "FAIL: expected gh pr merge call to include --admin when FACTORY_MERGE_ADMIN=1" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi
if ! grep -q -- "--squash" "$GH_CALL_LOG"; then
  echo "FAIL: expected gh pr merge call to include --squash when FACTORY_MERGE_ADMIN=1" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi
if ! grep -q -- "--delete-branch" "$GH_CALL_LOG"; then
  echo "FAIL: expected gh pr merge call to include --delete-branch when FACTORY_MERGE_ADMIN=1" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi

# --- heartbeat: sweep_once writes a timestamp, creating parent dirs ---

REPOS=(fakerepo)
export HEARTBEAT_FILE="$BINDIR/hb/heartbeat"
sweep_once >/dev/null 2>&1 || true

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "FAIL: expected heartbeat file to be written at $HEARTBEAT_FILE" >&2
  exit 1
fi
if ! grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' "$HEARTBEAT_FILE"; then
  echo "FAIL: heartbeat file does not contain a timestamp: $(cat "$HEARTBEAT_FILE")" >&2
  exit 1
fi

# --- preflight: crash early on missing dependencies ---

# all deps present => preflight passes silently
if ! output="$( (preflight) 2>&1 )"; then
  echo "FAIL: preflight failed with all dependencies present: $output" >&2
  exit 1
fi

# missing factory binary => FATAL + non-zero
if output="$( (FACTORY_BIN="$BINDIR/does-not-exist"; preflight) 2>&1 )"; then
  echo "FAIL: preflight passed despite missing factory binary" >&2
  exit 1
fi
grep -qF "FATAL: factory CLI missing or not executable at $BINDIR/does-not-exist" <<<"$output" || {
  echo "FAIL: missing-factory FATAL message not found in: $output" >&2; exit 1; }

# missing gh on PATH => FATAL + non-zero (PATH reduced to a dir with python3 only)
GH_LESS_BIN="$(mktemp -d)"
ln -s "$(command -v python3)" "$GH_LESS_BIN/python3"
if output="$( (PATH="$GH_LESS_BIN"; preflight) 2>&1 )"; then
  echo "FAIL: preflight passed despite gh missing from PATH" >&2
  exit 1
fi
grep -qF "FATAL: gh not found on PATH" <<<"$output" || {
  echo "FAIL: missing-gh FATAL message not found in: $output" >&2; exit 1; }
rm -rf "$GH_LESS_BIN"

# missing repo dir => FATAL + non-zero
if output="$( (REPOS=(missingrepo); preflight) 2>&1 )"; then
  echo "FAIL: preflight passed despite missing repo dir" >&2
  exit 1
fi
grep -qF "FATAL: repo dir missing: $REPO_ROOT/missingrepo" <<<"$output" || {
  echo "FAIL: missing-repo-dir FATAL message not found in: $output" >&2; exit 1; }

# --- plist: valid property list with KeepAlive set ---

PLIST="$ROOT/scripts/launchd/com.on-par.auto-merge-sweep.plist"
if ! python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$PLIST"; then
  echo "FAIL: $PLIST is not a valid property list" >&2
  exit 1
fi
if ! grep -q "<key>KeepAlive</key>" "$PLIST"; then
  echo "FAIL: $PLIST does not set KeepAlive" >&2
  exit 1
fi

# --- backoff: next_sleep_seconds doubles and clamps to MAX_SLEEP_SECONDS ---

MAX_SLEEP_SECONDS=3600
[ "$(next_sleep_seconds 300)" = "600" ] || { echo "FAIL: next_sleep_seconds 300 != 600" >&2; exit 1; }
[ "$(next_sleep_seconds 1800)" = "3600" ] || { echo "FAIL: next_sleep_seconds 1800 != 3600" >&2; exit 1; }
[ "$(next_sleep_seconds 3600)" = "3600" ] || { echo "FAIL: next_sleep_seconds 3600 did not clamp" >&2; exit 1; }

# --- backoff: sweep_repo signals gh pr list failure; sweep_once aggregates ---

export GH_PR_LIST_FAIL=1
if sweep_repo fakerepo >/dev/null 2>&1; then
  echo "FAIL: sweep_repo returned success despite gh pr list failing" >&2; exit 1
fi
REPOS=(fakerepo)
if sweep_once >/dev/null 2>&1; then
  echo "FAIL: sweep_once returned success when every repo sweep failed" >&2; exit 1
fi
unset GH_PR_LIST_FAIL
if ! sweep_once >/dev/null 2>&1; then
  echo "FAIL: sweep_once returned failure on a healthy pass" >&2; exit 1
fi

# --- backoff: run_sweep_loop doubles sleep on repeated failure, clamps, resets on success ---

SLEEP_LOG="$BINDIR/sleep.log"
: >"$SLEEP_LOG"
SWEEP_FAIL_COUNT_FILE="$BINDIR/sweep-fails"
echo 3 >"$SWEEP_FAIL_COUNT_FILE" # first 3 passes fail, then succeed

sweep_once() {
  local left
  left="$(cat "$SWEEP_FAIL_COUNT_FILE")"
  if [ "$left" -gt 0 ]; then
    echo $((left - 1)) >"$SWEEP_FAIL_COUNT_FILE"
    return 1
  fi
  return 0
}
sleep() { echo "$1" >>"$SLEEP_LOG"; }

SLEEP_SECONDS=300
MAX_SLEEP_SECONDS=1000
run_sweep_loop 5

expected=$'600\n1000\n1000\n300'
actual="$(cat "$SLEEP_LOG")"
if [ "$actual" != "$expected" ]; then
  echo "FAIL: backoff sleep sequence wrong" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi
unset -f sweep_once sleep

echo "PASS: auto-merge-sweep logs merge/land failures with real exit codes, skips landing when the repo dir is missing, honours FACTORY_MERGE_ADMIN for the standalone merge path, writes a heartbeat on each pass, ships a valid KeepAlive launchd plist, preflight fatally rejects missing gh/factory/repo-dir dependencies, backs off exponentially up to MAX_SLEEP_SECONDS on sweep-wide failures resetting on success, skips multi-issue-closing PRs with an explicit SKIPPING log line instead of silently landing only the first issue, and tees every dated log line to a persistent LOG_FILE, creating its parent directory"
