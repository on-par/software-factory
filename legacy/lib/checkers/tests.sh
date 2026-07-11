#!/usr/bin/env bash
# lib/checkers/tests.sh — Test suite execution checker.
#
# Runs the project's test command and verifies all tests pass.

set -euo pipefail

check_tests() {
  local wt="$1" spec="$2" constitution_body="${3:-}"
  local result="PASS" details=""

  cd "$wt" || return 1

  # Check for verify.sh (factory convention)
  if [ -x "scripts/verify.sh" ]; then
    if scripts/verify.sh --no-e2e > /tmp/checker-tests.log 2>&1; then
      details="scripts/verify.sh: OK"
    else
      result="FAIL"
      details="scripts/verify.sh failed: $(tail -30 /tmp/checker-tests.log)"
    fi
  elif [ -f "package.json" ] && jq -e '.scripts.test' package.json >/dev/null 2>&1; then
    if npm test > /tmp/checker-tests.log 2>&1; then
      details="npm test: OK"
    else
      result="FAIL"
      details="npm test failed: $(tail -30 /tmp/checker-tests.log)"
    fi
  elif [ -f "Makefile" ] && make -n test >/dev/null 2>&1; then
    if make test > /tmp/checker-tests.log 2>&1; then
      details="make test: OK"
    else
      result="FAIL"
      details="make test failed: $(tail -30 /tmp/checker-tests.log)"
    fi
  else
    details="no test command found — skipped"
  fi

  jq -n --arg r "$result" --arg d "$details" \
    '{checker: "tests", result: $r, details: $d}'
}