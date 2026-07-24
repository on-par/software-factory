#!/usr/bin/env bash
# Unit test for scripts/repo-merge-settings.sh, using the same no-network `gh`-stub
# pattern as scripts/auto-merge-sweep.test.sh: a fake `gh` executable logs its full
# argv to $GH_CALL_LOG and answers based on env-controlled toggles.
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

cat >"$BINDIR/gh" <<'EOF'
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
  echo "${GH_VERIFY_OUTPUT:-true true true PR_TITLE BLANK}"
  exit 0
fi
exit 0
EOF
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export REPO="test-org/test-repo"

# --- 1. PATCH payload is complete; verification matches => PASS ---

: >"$GH_CALL_LOG"
output="$(bash "$ROOT/scripts/repo-merge-settings.sh" 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "FAIL: expected exit 0 on matching settings, got $status: $output" >&2
  exit 1
fi
grep -qF "PASS:" <<<"$output" || {
  echo "FAIL: expected a PASS: line in output: $output" >&2; exit 1; }

patch_call="$(grep -F 'api -X PATCH' "$GH_CALL_LOG" || true)"
[ -n "$patch_call" ] || { echo "FAIL: no PATCH call logged" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
for needle in "repos/test-org/test-repo" "-F delete_branch_on_merge=true" "-F allow_auto_merge=true" \
  "-F allow_update_branch=true" "-f squash_merge_commit_title=PR_TITLE" \
  "-f squash_merge_commit_message=BLANK"; do
  grep -qF -- "$needle" <<<"$patch_call" || {
    echo "FAIL: PATCH call missing '$needle': $patch_call" >&2; exit 1; }
done

# --- 2. Verification mismatch fails, naming the field ---

: >"$GH_CALL_LOG"
export GH_VERIFY_OUTPUT="false true true PR_TITLE BLANK"
if output="$(bash "$ROOT/scripts/repo-merge-settings.sh" 2>&1)"; then
  echo "FAIL: expected non-zero exit on verification mismatch" >&2
  exit 1
fi
grep -qF "delete_branch_on_merge" <<<"$output" || {
  echo "FAIL: mismatch message did not name the drifted field: $output" >&2; exit 1; }
grep -qF "PASS:" <<<"$output" && {
  echo "FAIL: PASS: line should not appear on mismatch: $output" >&2; exit 1; }
unset GH_VERIFY_OUTPUT

# --- 3. PATCH failure propagates; no PASS printed ---

: >"$GH_CALL_LOG"
export GH_PATCH_FAIL=1
if output="$(bash "$ROOT/scripts/repo-merge-settings.sh" 2>&1)"; then
  echo "FAIL: expected non-zero exit on PATCH failure" >&2
  exit 1
fi
grep -qF "PASS:" <<<"$output" && {
  echo "FAIL: PASS: line should not appear on PATCH failure: $output" >&2; exit 1; }
unset GH_PATCH_FAIL

# --- 4. DRY_RUN makes no mutating call ---

: >"$GH_CALL_LOG"
export DRY_RUN=1
output="$(bash "$ROOT/scripts/repo-merge-settings.sh" 2>&1)"
status=$?
unset DRY_RUN

if [ "$status" -ne 0 ]; then
  echo "FAIL: expected exit 0 under DRY_RUN, got $status: $output" >&2
  exit 1
fi
if grep -qF "PATCH" "$GH_CALL_LOG"; then
  echo "FAIL: DRY_RUN made a mutating gh call" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi
[ -s "$GH_CALL_LOG" ] && {
  echo "FAIL: DRY_RUN should not invoke gh at all: $(cat "$GH_CALL_LOG")" >&2; exit 1; }

echo "PASS: repo-merge-settings applies all five merge-hygiene fields in one PATCH, fails loudly naming the drifted field on a verification mismatch, propagates a PATCH failure without printing PASS, and DRY_RUN makes no gh call at all"
