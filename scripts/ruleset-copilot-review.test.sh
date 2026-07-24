#!/usr/bin/env bash
# Unit test for scripts/ruleset-copilot-review.sh, using the same no-network `gh`-stub
# pattern as scripts/repo-merge-settings.test.sh: a fake `gh` executable logs its full
# argv (and, for PUT calls, the stdin body) to $GH_CALL_LOG and answers based on
# env-controlled toggles.
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

# Canned raw ruleset fixtures, fed through the SCRIPT'S OWN --jq filter via a
# real `jq` (not a pre-baked "as if jq already ran" string) so a broken filter
# in build_body()/verify() actually fails this test instead of passing silently.
RAW_RULESET_FIXTURE="$BINDIR/raw-ruleset.json"
cat >"$RAW_RULESET_FIXTURE" <<'JSON'
{"id":42,"name":"protect-main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"bypass_actors":[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"always"}],"rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"pull_request","parameters":{"allowed_merge_methods":["merge","squash","rebase"],"dismiss_stale_reviews_on_push":false,"dismissal_restriction":{"enabled":false,"allowed_actors":[]},"require_code_owner_review":false,"require_last_push_approval":false,"required_approving_review_count":1,"required_review_thread_resolution":false,"required_reviewers":[]}},{"type":"required_status_checks","parameters":{"required_status_checks":[],"strict_required_status_checks_policy":false}}]}
JSON
export RAW_RULESET_FIXTURE

RULESET_LIST_FIXTURE="$BINDIR/ruleset-list.json"
echo '[{"id":42,"name":"protect-main"},{"id":99,"name":"other-ruleset"}]' >"$RULESET_LIST_FIXTURE"
export RULESET_LIST_FIXTURE

cat >"$BINDIR/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
echo "$@" >>"$GH_CALL_LOG"

if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PUT" ]; then
  body="$(cat)"
  echo "PUT_BODY:$body" >>"$GH_CALL_LOG"
  if [ "${GH_PUT_FAIL:-0}" = "1" ]; then
    echo "simulated put failure" >&2
    exit 5
  fi
  exit 0
fi

if [ "$1" = "api" ]; then
  # Extract the --jq filter argument so it can be run for real, exercising
  # the same expression the script under test actually passed to `gh --jq`.
  jq_filter=""
  want_next=0
  for a in "$@"; do
    if [ "$want_next" = "1" ]; then
      jq_filter="$a"
      want_next=0
    fi
    [ "$a" = "--jq" ] && want_next=1
  done

  args="$*"
  case "$args" in
    *"/rulesets --jq"*)
      # resolve_ruleset_id's list call.
      jq -r "$jq_filter" "$RULESET_LIST_FIXTURE"
      exit 0
      ;;
    *"bypass_actors"*)
      # build_body's read-modify-write GET+jq call: run the actual transform
      # against a raw ruleset that does NOT yet have the Copilot flag, so the
      # PUT body only contains automatic_copilot_code_review_enabled:true if
      # the filter really sets it.
      jq -c "$jq_filter" "$RAW_RULESET_FIXTURE"
      exit 0
      ;;
    *"select(.type=="*)
      # verify()'s post-apply GET: run the actual extraction filter against a
      # ruleset whose Copilot field value simulates the real post-PUT state.
      # ${VAR+x} (not ${VAR:-x}) so an exported empty string (the field was
      # dropped) is distinguishable from unset (happy path, field is true).
      if [ -n "${GH_VERIFY_OUTPUT+x}" ]; then
        jq -r "$jq_filter" "$RAW_RULESET_FIXTURE"
      else
        jq -c '(.rules[] | select(.type=="pull_request") | .parameters.automatic_copilot_code_review_enabled) = true' "$RAW_RULESET_FIXTURE" \
          | jq -r "$jq_filter"
      fi
      exit 0
      ;;
  esac
fi
exit 0
EOF
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export REPO="test-org/test-repo"

# --- 1. Happy path: apply + verify both succeed ---

: >"$GH_CALL_LOG"
output="$(bash "$ROOT/scripts/ruleset-copilot-review.sh" 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "FAIL: expected exit 0 on matching settings, got $status: $output" >&2
  exit 1
fi
grep -qF "PASS:" <<<"$output" || {
  echo "FAIL: expected a PASS: line in output: $output" >&2; exit 1; }

put_body="$(grep -F 'PUT_BODY:' "$GH_CALL_LOG" || true)"
[ -n "$put_body" ] || { echo "FAIL: no PUT call logged" >&2; cat "$GH_CALL_LOG" >&2; exit 1; }
for needle in '"automatic_copilot_code_review_enabled":true' '"required_status_checks"' \
  '"non_fast_forward"' '"bypass_actors"' '"actor_type":"OrganizationAdmin"'; do
  grep -qF -- "$needle" <<<"$put_body" || {
    echo "FAIL: PUT body missing '$needle': $put_body" >&2; exit 1; }
done

# --- 2. Verify mismatch (the real-world 0-Copilot-seat outcome) ---

: >"$GH_CALL_LOG"
export GH_VERIFY_OUTPUT=""
if output="$(bash "$ROOT/scripts/ruleset-copilot-review.sh" 2>&1)"; then
  echo "FAIL: expected non-zero exit on verification mismatch" >&2
  exit 1
fi
grep -qF "automatic_copilot_code_review_enabled" <<<"$output" || {
  echo "FAIL: mismatch message did not name the drifted field: $output" >&2; exit 1; }
grep -qiF "Copilot" <<<"$output" || {
  echo "FAIL: mismatch message did not mention Copilot availability: $output" >&2; exit 1; }
grep -qF "PASS:" <<<"$output" && {
  echo "FAIL: PASS: line should not appear on mismatch: $output" >&2; exit 1; }
unset GH_VERIFY_OUTPUT

# --- 3. PUT failure propagates; no PASS printed ---

: >"$GH_CALL_LOG"
export GH_PUT_FAIL=1
if output="$(bash "$ROOT/scripts/ruleset-copilot-review.sh" 2>&1)"; then
  echo "FAIL: expected non-zero exit on PUT failure" >&2
  exit 1
fi
grep -qF "PASS:" <<<"$output" && {
  echo "FAIL: PASS: line should not appear on PUT failure: $output" >&2; exit 1; }
unset GH_PUT_FAIL

# --- 4. DRY_RUN makes no mutating call ---

: >"$GH_CALL_LOG"
export DRY_RUN=1
output="$(bash "$ROOT/scripts/ruleset-copilot-review.sh" 2>&1)"
status=$?
unset DRY_RUN

if [ "$status" -ne 0 ]; then
  echo "FAIL: expected exit 0 under DRY_RUN, got $status: $output" >&2
  exit 1
fi
if grep -qF "PUT" "$GH_CALL_LOG"; then
  echo "FAIL: DRY_RUN made a mutating gh call" >&2
  cat "$GH_CALL_LOG" >&2
  exit 1
fi

echo "PASS: ruleset-copilot-review preserves all existing rules and bypass_actors while enabling automatic_copilot_code_review_enabled in one PUT, fails loudly naming the drifted field (and the likely Copilot-availability cause) on a verification mismatch, propagates a PUT failure without printing PASS, and DRY_RUN makes no mutating gh call"
