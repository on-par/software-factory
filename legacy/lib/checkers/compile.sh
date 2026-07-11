#!/usr/bin/env bash
# lib/checkers/compile.sh — Build/compile verification checker.
#
# Runs the project's build command and verifies it succeeds.
# Detects the build system automatically (npm, yarn, make, cargo, etc.).

set -euo pipefail

check_compile() {
  local wt="$1" spec="$2" constitution_body="${3:-}"
  local result="PASS" details=""

  cd "$wt" || return 1

  # Detect build system
  if [ -f "package.json" ]; then
    # Check for build script
    if jq -e '.scripts.build' package.json >/dev/null 2>&1; then
      if npm run build > /tmp/checker-compile.log 2>&1; then
        details="npm run build: OK"
      else
        result="FAIL"
        details="npm run build failed: $(tail -20 /tmp/checker-compile.log)"
      fi
    else
      details="no build script in package.json — skipped"
    fi
  elif [ -f "Makefile" ]; then
    if make > /tmp/checker-compile.log 2>&1; then
      details="make: OK"
    else
      result="FAIL"
      details="make failed: $(tail -20 /tmp/checker-compile.log)"
    fi
  elif [ -f "Cargo.toml" ]; then
    if cargo build > /tmp/checker-compile.log 2>&1; then
      details="cargo build: OK"
    else
      result="FAIL"
      details="cargo build failed: $(tail -20 /tmp/checker-compile.log)"
    fi
  elif [ -f "go.mod" ]; then
    if go build ./... > /tmp/checker-compile.log 2>&1; then
      details="go build: OK"
    else
      result="FAIL"
      details="go build failed: $(tail -20 /tmp/checker-compile.log)"
    fi
  else
    details="no build system detected — skipped"
  fi

  # Output JSON result
  jq -n --arg r "$result" --arg d "$details" \
    '{checker: "compile", result: $r, details: $d}'
}