#!/usr/bin/env bash
# Regression test for auto-merge-sweep.sh: proves that a failing `gh pr merge`
# and a failing `factory land` are each logged as an explicit FAILURE line
# carrying the command's real non-zero exit code, instead of being silently
# swallowed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"
REPO_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR" "$REPO_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO_ROOT/fakerepo"

cat >"$BINDIR/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
if [ "$1 $2" = "pr list" ]; then
  cat <<'JSON'
[
  {
    "number": 101,
    "isDraft": false,
    "mergeable": "MERGEABLE",
    "statusCheckRollup": [{"conclusion": "SUCCESS"}],
    "closingIssuesReferences": []
  },
  {
    "number": 102,
    "isDraft": false,
    "mergeable": "MERGEABLE",
    "statusCheckRollup": [{"conclusion": "SUCCESS"}],
    "closingIssuesReferences": [{"number": 42}]
  }
]
JSON
  exit 0
elif [ "$1 $2" = "pr merge" ]; then
  echo "simulated merge failure" >&2
  exit 3
fi
exit 0
EOF
chmod +x "$BINDIR/gh"

cat >"$BINDIR/fake-factory" <<'EOF'
#!/usr/bin/env bash
echo "simulated land failure" >&2
exit 7
EOF
chmod +x "$BINDIR/fake-factory"

export PATH="$BINDIR:$PATH"
export FACTORY_BIN="$BINDIR/fake-factory"
export REPO_ROOT

# shellcheck disable=SC1091
source "$ROOT/scripts/auto-merge-sweep.sh"

output="$(sweep_repo fakerepo 2>&1)"

# Usage: assert_line contains|not_contains "<needle>"
assert_line() {
  local mode="$1" needle="$2" found=1
  grep -qF "$needle" <<<"$output" && found=0
  if { [ "$mode" = "contains" ] && [ "$found" -ne 0 ]; } || { [ "$mode" = "not_contains" ] && [ "$found" -eq 0 ]; }; then
    echo "FAIL: expected output to $mode: $needle" >&2
    echo "--- actual output ---" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_line contains "FAILED to merge PR #101 (exit 3)"
assert_line contains "FAILED to land #42 (PR #102) (exit 7)"
assert_line not_contains "merged PR #101"
assert_line not_contains "landed #42"

echo "PASS: auto-merge-sweep logs merge/land failures with exit codes"
