#!/usr/bin/env bash
# Unit test for scripts/repo-about.sh, using the same no-network `gh`-stub
# pattern as scripts/repo-merge-settings.test.sh: a fake `gh` executable logs its
# full argv to $GH_CALL_LOG and answers based on env-controlled toggles.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

GH_CALL_LOG="$BINDIR/gh-calls.log"
export GH_CALL_LOG
: >"$GH_CALL_LOG"

EXP_DESC='Local CLI: GitHub issue → constitution-checked PR (PLAN→BUILD→CHECK→SHIP) with multi-model routing and cost tracking.'
EXP_TOPICS='ai-agents,automation,cli,code-review,developer-tools,github,llm,pull-requests,typescript'
export EXP_DESC EXP_TOPICS

cat >"$BINDIR/gh" <<'EOF2'
#!/usr/bin/env bash
set -uo pipefail
echo "$@" >>"$GH_CALL_LOG"
if [ "$1" = "api" ] && [ "$2" = "-X" ]; then
  if [ "${GH_PATCH_FAIL:-0}" = "1" ]; then
    echo "simulated patch failure" >&2
    exit 5
  fi
  exit 0
elif [ "$1" = "api" ]; then
  echo "${GH_VERIFY_OUTPUT:-$EXP_DESC|$EXP_TOPICS|}"
  exit 0
fi
exit 0
EOF2
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export REPO="test-org/test-repo"

expect_fail() { # name, needle that must appear in output
  local name="$1" needle="$2"
  : >"$GH_CALL_LOG"
  if output="$(bash "$ROOT/scripts/repo-about.sh" 2>&1)"; then
    echo "FAIL: $name: expected non-zero exit" >&2; exit 1
  fi
  grep -qF -- "$needle" <<<"$output" || {
    echo "FAIL: $name: output missing '$needle': $output" >&2; exit 1; }
  grep -qF "PASS:" <<<"$output" && {
    echo "FAIL: $name: PASS: should not appear: $output" >&2; exit 1; }
  return 0
}

# --- 1. Happy path ---

: >"$GH_CALL_LOG"
output="$(bash "$ROOT/scripts/repo-about.sh" 2>&1)"
grep -qF "PASS:" <<<"$output" || { echo "FAIL: expected PASS: in: $output" >&2; exit 1; }

patch_call="$(grep -F 'api -X PATCH repos/test-org/test-repo' "$GH_CALL_LOG" || true)"
[ -n "$patch_call" ] || { echo "FAIL: no PATCH call logged" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
grep -qF "description=Local CLI: GitHub issue" <<<"$patch_call" || {
  echo "FAIL: PATCH missing description: $patch_call" >&2; exit 1; }
put_call="$(grep -F 'api -X PUT repos/test-org/test-repo/topics' "$GH_CALL_LOG" || true)"
[ -n "$put_call" ] || { echo "FAIL: no PUT topics call logged" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
for t in cli typescript github pull-requests ai-agents; do
  grep -qF "names[]=$t" <<<"$put_call" || { echo "FAIL: PUT missing topic $t: $put_call" >&2; exit 1; }
done
if grep -F -- "-X" "$GH_CALL_LOG" | grep -qE "homepage|saas"; then
  echo "FAIL: a mutating gh call mentioned homepage or saas" >&2; cat "$GH_CALL_LOG" >&2; exit 1
fi

# --- 2. Description mismatch ---
export GH_VERIFY_OUTPUT="Local CLI for shipping GitHub issues with multi-agent planning.|$EXP_TOPICS|"
expect_fail "description mismatch" "description"

# --- 3. Empty topics ---
export GH_VERIFY_OUTPUT="$EXP_DESC||"
expect_fail "empty topics" "topics"

# --- 4. saas present ---
export GH_VERIFY_OUTPUT="$EXP_DESC|$EXP_TOPICS,saas|"
expect_fail "saas topic" "saas"

# --- 5. Homepage set ---
export GH_VERIFY_OUTPUT="$EXP_DESC|$EXP_TOPICS|https://example.com"
expect_fail "homepage set" "homepage"
unset GH_VERIFY_OUTPUT

# --- 6. PATCH failure propagates ---
export GH_PATCH_FAIL=1
expect_fail "patch failure" ""
unset GH_PATCH_FAIL

# --- 7. DRY_RUN makes no mutating call ---
: >"$GH_CALL_LOG"
output="$(DRY_RUN=1 bash "$ROOT/scripts/repo-about.sh" 2>&1)"
grep -qF "DRY_RUN:" <<<"$output" || { echo "FAIL: DRY_RUN output missing DRY_RUN:: $output" >&2; exit 1; }
if grep -qF -- "-X" "$GH_CALL_LOG"; then
  echo "FAIL: DRY_RUN made a mutating gh call" >&2; cat "$GH_CALL_LOG" >&2; exit 1
fi

echo "PASS: repo-about.sh tests"
