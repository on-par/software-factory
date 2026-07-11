#!/usr/bin/env bash
# lib/checkers/custom.sh — Product-specific custom checker runner.
#
# Loads custom checkers from the constitution and runs them via Claude
# (or a checker model). Custom checkers are defined as prompt instructions
# in the constitution's Quality Gates section and run as agent prompts.

set -euo pipefail

# check_custom <worktree> <spec> <constitution_body> <checker_name>
# Runs a custom checker by name. The constitution body must contain a
# section describing what this checker verifies. The checker runs as a
# Claude prompt that inspects the worktree and returns a JSON verdict.
check_custom() {
  local wt="$1" spec="$2" constitution_body="$3" checker_name="$4"
  local result="PASS" details=""

  [ -z "$checker_name" ] && {
    jq -n --arg r "PASS" --arg d "no custom checker specified — skipped" \
      '{checker: "custom", result: $r, details: $d}'
    return 0
  }

  # Source the router to resolve a checker model
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$SCRIPT_DIR/../router.sh" ] && . "$SCRIPT_DIR/../router.sh"

  local model
  model="$(router_resolve check_custom 2>/dev/null || echo "claude-sonnet-5")"

  local prompt
  prompt="You are a CHECKER agent for a software factory. Your job is to independently
verify the work in the worktree against a specific standard. Do NOT trust the worker's
self-report — verify directly.

WORKTREE: $wt
CHECKER NAME: $checker_name
SPEC: $(cat "$spec" 2>/dev/null || echo "(no spec)")

CONSTITUTION (the written standard):
$constitution_body

Your job: Run the '$checker_name' check. This is a custom checker defined in the
constitution above. Find the relevant standard in the constitution and verify the
work in the worktree against it.

Steps:
1. Read the constitution to understand what '$checker_name' should verify.
2. Inspect the worktree files relevant to this check.
3. Run any necessary commands (lint, build, test, grep, etc.) to verify.
4. Return a JSON verdict on stdout (and ONLY the JSON):

{
  \"checker\": \"$checker_name\",
  \"result\": \"PASS\" or \"FAIL\",
  \"details\": \"<specific findings — what passed, what failed, with evidence>\"
}

If the work passes all relevant standards, result is PASS. If any standard is
violated, result is FAIL with specific evidence. Do not be lenient — the system
relies on you to be the independent verifier."

  local output; output="$(mktemp)"
  local rc=0
  local flag; flag="$(models_claude_flag "$model" 2>/dev/null || echo "")"
  ( cd "$wt" && timeout "${FACTORY_CHECK_TIMEOUT:-1800}" \
    claude -p "$prompt" ${flag:+$flag} --dangerously-skip-permissions \
    > "$output" 2>&1 ) || rc=$?

  if [ "$rc" -ne 0 ] || [ ! -s "$output" ]; then
    rm -f "$output"
    jq -n --arg r "FAIL" --arg d "checker agent failed (rc=$rc)" \
      '{checker: "custom", result: $r, details: $d}'
    return 0
  fi

  # Extract JSON from output (agent may wrap in markdown)
  local json
  json="$(grep -oE '\{[^{}]*"checker"[^{}]*"result"[^{}]*\}' "$output" | head -1)"
  [ -z "$json" ] && json="$(cat "$output")"
  echo "$json" | jq -c '.' 2>/dev/null || {
    jq -n --arg r "FAIL" --arg d "checker produced no valid JSON: $(head -5 "$output")" \
      '{checker: "custom", result: $r, details: $d}'
  }
  rm -f "$output"
}

# Run all custom checkers for a product: check_all_custom <wt> <spec> <product>
# Reads the constitution to find which custom checkers to run.
check_all_custom() {
  local wt="$1" spec="$2" product="$3"
  local results="" checker

  # Source constitution.sh to get the checkers list
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$SCRIPT_DIR/../constitution.sh" ] && . "$SCRIPT_DIR/../constitution.sh"

  local constitution_body
  constitution_body="$(constitution_body "$product" 2>/dev/null || echo "")"

  # Get custom checkers (those starting with custom_)
  while IFS= read -r checker; do
    [ -z "$checker" ] && continue
    case "$checker" in
      custom_*)
        local result
        result="$(check_custom "$wt" "$spec" "$constitution_body" "$checker")"
        results="${results}${result}
"
        ;;
    esac
  done < <(constitution_checkers "$product" 2>/dev/null)

  echo "$results"
}