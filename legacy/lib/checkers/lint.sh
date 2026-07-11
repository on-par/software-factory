#!/usr/bin/env bash
# lib/checkers/lint.sh — Linting and type checking checker.

set -euo pipefail

check_lint() {
  local wt="$1" spec="$2" constitution_body="${3:-}"
  local result="PASS" details="" has_checks=0

  cd "$wt" || return 1

  # ESLint
  if [ -f "package.json" ] && jq -e '.scripts.lint' package.json >/dev/null 2>&1; then
    has_checks=1
    if npm run lint > /tmp/checker-lint.log 2>&1; then
      details="eslint: OK"
    else
      result="FAIL"
      details="eslint failed: $(tail -20 /tmp/checker-lint.log)"
    fi
  fi

  # TypeScript type check (if not already covered by build)
  if [ -f "tsconfig.json" ] && command -v npx >/dev/null 2>&1; then
    has_checks=1
    if npx tsc --noEmit > /tmp/checker-tsc.log 2>&1; then
      details="$details; tsc: OK"
    else
      result="FAIL"
      details="$details; tsc failed: $(tail -20 /tmp/checker-tsc.log)"
    fi
  fi

  # Stylelint (if present)
  if [ -f ".stylelintrc.json" ] || [ -f ".stylelintrc" ]; then
    has_checks=1
    if npx stylelint "**/*.css" > /tmp/checker-stylelint.log 2>&1; then
      details="$details; stylelint: OK"
    else
      result="FAIL"
      details="$details; stylelint failed: $(tail -20 /tmp/checker-stylelint.log)"
    fi
  fi

  [ "$has_checks" -eq 0 ] && details="no linting configured — skipped"

  jq -n --arg r "$result" --arg d "${details#; }" \
    '{checker: "lint", result: $r, details: $d}'
}