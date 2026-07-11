#!/usr/bin/env bash
# lib/phases/check.sh — CHECK phase.
#
# Independent checker agents verify the worker's output against the spec
# and constitution. The worker's self-report is ignored. Failures go back
# to the worker with specific feedback. Disputes escalate to the boss.
#
# This is the structural anti-hallucination layer. No rank is high enough
# to skip verification — the boss can be caught by checkers, and checkers
# can be overruled by the boss on dispute.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

[ -f "$FACTORY_ROOT/lib/router.sh" ] && . "$FACTORY_ROOT/lib/router.sh"
[ -f "$FACTORY_ROOT/lib/constitution.sh" ] && . "$FACTORY_ROOT/lib/constitution.sh"

# Source all checkers
for checker in "$FACTORY_ROOT"/lib/checkers/*.sh; do
  [ -f "$checker" ] && . "$checker"
done

# phase_check <issue_number> <worktree> <spec_file> [product]
# Returns: 0 = all passed, 1 = failures found, 10 = escalation needed
phase_check() {
  local issue="$1" wt="$2" spec="$3" product="${4:-}"
  local results_file; results_file="$(mktemp)"
  local failures=0 passes=0 total=0

  echo "[]" > "$results_file"

  # Always run these checkers
  local standard_checkers="compile tests lint"

  # Add product-specific checkers from constitution
  local product_checkers=""
  if [ -n "$product" ]; then
    product_checkers="$(constitution_checkers "$product" 2>/dev/null || echo "")"
  fi

  local constitution_body=""
  [ -n "$product" ] && constitution_body="$(constitution_body "$product" 2>/dev/null || echo "")"

  # Run each standard checker
  for checker_name in $standard_checkers; do
    local func="check_${checker_name}"
    if type "$func" >/dev/null 2>&1; then
      total=$((total+1))
      local result
      result="$("$func" "$wt" "$spec" "$constitution_body" 2>&1 || \
        jq -nc --arg c "$checker_name" --arg d "checker crashed" \
          '{checker: $c, result: "FAIL", details: $d}')"
      echo "$result" >> "$results_file"

      local r; r="$(echo "$result" | jq -r '.result')"
      if [ "$r" = "FAIL" ]; then
        failures=$((failures+1))
        log_event "check" "$issue" "FAIL: $checker_name — $(echo "$result" | jq -r '.details | .[0:120]')"
      else
        passes=$((passes+1))
        log_event "check" "$issue" "PASS: $checker_name"
      fi
    fi
  done

  # Run product-specific checkers (including custom_*)
  if [ -n "$product" ]; then
    for checker_name in $product_checkers; do
      [ -z "$checker_name" ] && continue
      total=$((total+1))

      local func="check_${checker_name}"
      local result
      if type "$func" >/dev/null 2>&1; then
        # Built-in checker with this name
        result="$("$func" "$wt" "$spec" "$constitution_body" 2>&1 || \
          jq -nc --arg c "$checker_name" --arg d "checker crashed" \
            '{checker: $c, result: "FAIL", details: $d}')"
      elif [[ "$checker_name" == custom_* ]]; then
        # Custom checker — run via agent
        result="$(check_custom "$wt" "$spec" "$constitution_body" "$checker_name" 2>&1 || \
          jq -nc --arg c "$checker_name" --arg d "checker agent failed" \
            '{checker: $c, result: "FAIL", details: $d}')"
      else
        # Unknown checker — skip
        total=$((total-1))
        continue
      fi

      echo "$result" >> "$results_file"
      local r; r="$(echo "$result" | jq -r '.result')"
      if [ "$r" = "FAIL" ]; then
        failures=$((failures+1))
        log_event "check" "$issue" "FAIL: $checker_name — $(echo "$result" | jq -r '.details | .[0:120]')"
      else
        passes=$((passes+1))
        log_event "check" "$issue" "PASS: $checker_name"
      fi
    done
  fi

  # Output summary
  jq -nc --argjson fails "$failures" --argjson passes "$passes" --argjson total "$total" \
    '{failures: $fails, passes: $passes, total: $total, results: .}' < <(jq -s '.' "$results_file")

  rm -f "$results_file"

  [ "$failures" -gt 0 ] && return 1
  return 0
}

# phase_check_rework <issue> <wt> <spec> <failures_json> [product]
# Generates a rework prompt from the check failures and sends the worker
# back to fix. This is the retry loop: execute → fail → get specific
# feedback → retry until true.
phase_check_rework() {
  local issue="$1" wt="$2" spec="$3" failures="$4" product="${5:-}"
  local constitution_ctx=""
  [ -n "$product" ] && constitution_ctx="$(constitution_context "$product" 2>/dev/null || echo "")"

  local failure_details
  failure_details="$(echo "$failures" | jq -r \
    '.results[] | select(.result == "FAIL") | "### \(.checker)\n\(.details)\n"')"

  local prompt="You are a WORKER agent in the rework loop of a software factory.
Your previous work on issue #$issue failed independent verification. Fix the
specific failures listed below.

WORKTREE: $wt (you are here)
SPEC: $spec

$( [ -n "$constitution_ctx" ] && echo "$constitution_ctx" )

## Check Failures (from independent verification agents)
$failure_details

## Instructions
1. Read each failure carefully. The checker verified your work independently —
   do not argue with the checkers. Fix the issues.
2. Re-read the spec and constitution if needed to understand the standard.
3. Fix each failure in the worktree.
4. Re-run any tests/builds to confirm your fixes work.
5. Commit your fixes with a clear message.

Do not push, do not open a PR. Just fix and commit. The checker will re-verify."

  local output; output="$(mktemp)"
  router_run build_claude "$prompt" "$output" >/dev/null 2>&1 || true
  rm -f "$output"
}

# phase_dispute <issue> <wt> <spec> <checker_name> <checker_details> [product]
# Worker disputes a checker failure. The boss (expensive model) arbitrates
# by re-reading the constitution. Returns: 0 = checker overruled, 1 = checker upheld.
phase_dispute() {
  local issue="$1" wt="$2" spec="$3" checker_name="$4" checker_details="$5" product="${6:-}"
  local constitution_ctx=""
  [ -n "$product" ] && constitution_ctx="$(constitution_context "$product" 2>/dev/null || echo "")"

  local prompt="You are the BOSS in a software factory. A worker agent is disputing
a checker agent's failure. You must arbitrate by re-reading the constitution —
standards outrank both the worker and the checker.

ISSUE: #$issue
WORKTREE: $wt
SPEC: $spec

$( [ -n "$constitution_ctx" ] && echo "$constitution_ctx" )

## Checker Finding
Checker: $checker_name
Details: $checker_details

## Your Job
1. Read the constitution's standards and dispute rules carefully.
2. Inspect the actual work in the worktree.
3. Decide: Is the checker correct (uphold the failure) or is the worker correct
   (overrule the checker)?
4. Return JSON (and ONLY the JSON):
   {
     \"verdict\": \"upheld\" or \"overruled\",
     \"reasoning\": \"<one paragraph citing the specific constitution standard>\",
     \"action\": \"<what should happen next>\"
   }"

  local output; output="$(mktemp)"
  router_run dispute_resolution "$prompt" "$output" >/dev/null 2>&1 || true

  local verdict; verdict="$(grep -oE '"verdict"[[:space:]]*:[[:space:]]*"[^"]*"' "$output" | head -1 | sed -E 's/.*"verdict"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
  rm -f "$output"

  [ "$verdict" = "overruled" ] && return 0
  return 1
}