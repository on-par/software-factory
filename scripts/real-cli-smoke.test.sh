#!/usr/bin/env bash
# Unit test for scripts/real-cli-smoke.sh using an `npx` stub that logs its invocation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

NPX_LOG="$BINDIR/npx.log"
export NPX_LOG

cat >"$BINDIR/npx" <<'EOF2'
#!/usr/bin/env bash
echo "FACTORY_REAL_CLI=${FACTORY_REAL_CLI:-} $*" >>"$NPX_LOG"
exit 0
EOF2
chmod +x "$BINDIR/npx"

export PATH="$BINDIR:$PATH"
SCRIPT="$ROOT/scripts/real-cli-smoke.sh"
OUT=""
RC=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  : >"$NPX_LOG"
  RC=0
  OUT=$(bash "$SCRIPT" "$@" 2>&1) || RC=$?
}

OPENAI_API_KEY='' OPENCODE_API_KEY='' run codex
[ "$RC" -eq 0 ] || fail "codex skip exited $RC"
echo "$OUT" | grep -q 'skipping' || fail "codex skip notice missing"
[ ! -s "$NPX_LOG" ] || fail "codex skip must not call npx"
OPENAI_API_KEY='' OPENCODE_API_KEY='' run opencode
[ "$RC" -eq 0 ] || fail "opencode skip exited $RC"
echo "$OUT" | grep -q 'skipping' || fail "opencode skip notice missing"
[ ! -s "$NPX_LOG" ] || fail "opencode skip must not call npx"
echo "PASS: skips with exit 0 when the agent secret is empty"

run foo
[ "$RC" -eq 2 ] || fail "unknown agent exited $RC"
run
[ "$RC" -eq 2 ] || fail "no argument exited $RC"
echo "PASS: rejects an unknown agent"

OPENAI_API_KEY=x run codex
[ "$RC" -eq 0 ] || fail "codex run exited $RC"
grep -q 'FACTORY_REAL_CLI=codex' "$NPX_LOG" || fail "FACTORY_REAL_CLI=codex not passed"
grep -q 'real-cli-loop.real-cli.test.ts' "$NPX_LOG" || fail "suite file not passed"
echo "PASS: runs the real-cli suite when the secret is set"
