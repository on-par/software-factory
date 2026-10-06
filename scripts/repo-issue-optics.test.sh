#!/usr/bin/env bash
# Unit test for scripts/repo-issue-optics.sh, using the same no-network `gh`-stub
# pattern as scripts/repo-about.test.sh: a fake `gh` executable logs its full
# argv to $GH_CALL_LOG and answers based on env-controlled toggles.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

GH_CALL_LOG="$BINDIR/gh-calls.log"
ALL_LOG="$BINDIR/all-calls.log"
export GH_CALL_LOG BINDIR
: >"$GH_CALL_LOG"
: >"$ALL_LOG"

EXP_TITLE='Visitors: most open issues here are factory dogfood backlog'
export EXP_TITLE

cat >"$BINDIR/gh" <<'EOF2'
#!/usr/bin/env bash
set -uo pipefail
echo "$@" >>"$GH_CALL_LOG"
case "$1 $2" in
  "label create") [ -z "${GH_LABEL_FAIL:-}" ] || exit 5 ;;
  "label list") echo "${GH_LABELS:-$'bug\ndogfood\noss-public\nicebox\ndocumentation'}" ;;
  "issue list") echo "${GH_EXISTING_ISSUE:-}" ;;
  "issue create")
    cat >"$BINDIR/body"
    echo "${GH_CREATE_OUTPUT:-https://github.com/test-org/test-repo/issues/42}" ;;
  "issue edit") cat >"$BINDIR/body" ;;
  "issue pin") touch "$BINDIR/pinned" ;;
  "api graphql")
    if [ "${GH_NEVER_PINNED:-0}" = "1" ]; then
      :
    elif [ -n "${GH_PINNED+x}" ]; then
      [ -z "$GH_PINNED" ] || printf '%s\n' "$GH_PINNED"
    elif [ -f "$BINDIR/pinned" ]; then
      printf '42\t%s\n' "$EXP_TITLE"
    fi ;;
esac
exit 0
EOF2
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export REPO="test-org/test-repo"

reset() {
  rm -f "$BINDIR/pinned" "$BINDIR/body"
  : >"$GH_CALL_LOG"
}

finish() { cat "$GH_CALL_LOG" >>"$ALL_LOG"; }

expect_fail() { # name, needle that must appear in output
  local name="$1" needle="$2"
  reset
  if output="$(bash "$ROOT/scripts/repo-issue-optics.sh" 2>&1)"; then
    echo "FAIL: $name: expected non-zero exit" >&2; exit 1
  fi
  finish
  grep -qF -- "$needle" <<<"$output" || {
    echo "FAIL: $name: output missing '$needle': $output" >&2; exit 1; }
  grep -qF "PASS:" <<<"$output" && {
    echo "FAIL: $name: PASS: should not appear: $output" >&2; exit 1; }
  return 0
}

# --- 1. Happy path, create ---
reset
output="$(bash "$ROOT/scripts/repo-issue-optics.sh" 2>&1)"
finish
grep -qF "PASS:" <<<"$output" || { echo "FAIL: expected PASS: in: $output" >&2; exit 1; }
[ "$(grep -c '^label create .*--force' "$GH_CALL_LOG")" = 3 ] || {
  echo "FAIL: expected 3 label create --force calls" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
for l in dogfood oss-public icebox; do
  grep -qE "^label create $l " "$GH_CALL_LOG" || { echo "FAIL: no label create $l" >&2; exit 1; }
done
create_call="$(grep -F 'issue create' "$GH_CALL_LOG" || true)"
[ -n "$create_call" ] || { echo "FAIL: no issue create" >&2; exit 1; }
grep -qF -- "--label oss-public" <<<"$create_call" && grep -qF -- "--label documentation" <<<"$create_call" || {
  echo "FAIL: create missing labels: $create_call" >&2; exit 1; }
grep -qF "dogfood" "$BINDIR/body" && grep -qF "labels/oss-public" "$BINDIR/body" || {
  echo "FAIL: body missing expected content" >&2; exit 1; }
grep -qF "issue pin 42" "$GH_CALL_LOG" || { echo "FAIL: no issue pin 42" >&2; exit 1; }

# --- 2. Existing, already pinned issue: edit only ---
reset
export GH_EXISTING_ISSUE=7 GH_PINNED="7"$'\t'"$EXP_TITLE"
output="$(bash "$ROOT/scripts/repo-issue-optics.sh" 2>&1)"
finish
grep -qF "PASS:" <<<"$output" || { echo "FAIL: case 2 expected PASS: $output" >&2; exit 1; }
grep -qF "issue edit 7" "$GH_CALL_LOG" || { echo "FAIL: no issue edit 7" >&2; exit 1; }
grep -qE "issue create|issue pin" "$GH_CALL_LOG" && {
  echo "FAIL: case 2 created or pinned" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
unset GH_EXISTING_ISSUE GH_PINNED

# --- 3. Missing label in verify ---
export GH_LABELS=$'bug\ndogfood\noss-public\ndocumentation'
expect_fail "missing label" "icebox"
unset GH_LABELS

# --- 4. Not pinned after apply ---
export GH_NEVER_PINNED=1
expect_fail "not pinned" "pinned"
unset GH_NEVER_PINNED

# --- 5. Label create failure propagates ---
export GH_LABEL_FAIL=1
expect_fail "label failure" ""
unset GH_LABEL_FAIL

# --- 6. Unparsable create output ---
export GH_CREATE_OUTPUT=oops
expect_fail "unparsable output" "could not parse"
unset GH_CREATE_OUTPUT

# --- 7. DRY_RUN makes no mutating call ---
reset
output="$(DRY_RUN=1 bash "$ROOT/scripts/repo-issue-optics.sh" 2>&1)"
finish
grep -qF "DRY_RUN:" <<<"$output" || { echo "FAIL: DRY_RUN output missing DRY_RUN:: $output" >&2; exit 1; }
if grep -qE "^(label create|issue create|issue edit|issue pin)" "$GH_CALL_LOG"; then
  echo "FAIL: DRY_RUN made a mutating gh call" >&2; cat "$GH_CALL_LOG" >&2; exit 1
fi

# --- 8. Never close/delete anything ---
if grep -qE "issue close|issue delete|label delete|state=closed" "$ALL_LOG"; then
  echo "FAIL: a destructive gh call was made" >&2; cat "$ALL_LOG" >&2; exit 1
fi

echo "PASS: repo-issue-optics.sh tests"
