#!/usr/bin/env bash
# Unit test for scripts/nightly-failure-issue.sh using a no-network `gh` stub that logs
# its argv to $GH_CALL_LOG; `gh issue list` prints $GH_EXISTING.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

GH_CALL_LOG="$BINDIR/gh-calls.log"
export GH_CALL_LOG

cat >"$BINDIR/gh" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >>"$GH_CALL_LOG"
if [ "$1 $2" = "issue list" ]; then
  printf '%s' "${GH_EXISTING:-}"
fi
exit 0
EOF2
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export TITLE="Nightly real-CLI smoke failing"
export LABEL=ci
export RUN_URL="https://example.test/run/1"
export BODY_FILE="$BINDIR/body.md"
echo "body" >"$BODY_FILE"

SCRIPT="$ROOT/scripts/nightly-failure-issue.sh"
WORKFLOW="$ROOT/.github/workflows/nightly-real-cli.yml"
RC=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

count() {
  grep -c "^$1" "$GH_CALL_LOG" || true
}

run() {
  : >"$GH_CALL_LOG"
  RC=0
  bash "$SCRIPT" >/dev/null 2>&1 || RC=$?
}

GH_EXISTING='' run
[ "$RC" -eq 0 ] || fail "create case exited $RC"
[ "$(count 'issue create')" -eq 1 ] || fail "expected one issue create"
[ "$(count 'issue edit')" -eq 0 ] && [ "$(count 'issue comment')" -eq 0 ] || fail "create case must not edit or comment"
echo "PASS: creates one issue when none open"

GH_EXISTING=17 run
[ "$RC" -eq 0 ] || fail "update case exited $RC"
[ "$(count 'issue edit 17')" -eq 1 ] || fail "expected one issue edit 17"
[ "$(count 'issue comment 17')" -eq 1 ] || fail "expected one issue comment 17"
[ "$(count 'issue create')" -eq 0 ] || fail "must not create a duplicate issue"
echo "PASS: updates existing issue without creating a duplicate"

: >"$GH_CALL_LOG"
RC=0
(unset TITLE; bash "$SCRIPT" >/dev/null 2>&1) || RC=$?
[ "$RC" -eq 2 ] || fail "missing TITLE should exit 2, got $RC"
[ ! -s "$GH_CALL_LOG" ] || fail "missing inputs must not call gh"
echo "PASS: rejects missing inputs"

grep -q 'scripts/nightly-failure-issue.sh' "$WORKFLOW" || fail "workflow does not call the script"
grep -q 'continue-on-error: true' "$WORKFLOW" || fail "workflow is not continue-on-error"
echo "PASS: workflow uses the script"
