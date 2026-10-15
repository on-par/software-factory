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
OPENAI_API_KEY='' OPENCODE_API_KEY='' OPENROUTER_API_KEY='' run pi
[ "$RC" -eq 0 ] || fail "pi skip exited $RC"
echo "$OUT" | grep -q 'skipping' || fail "pi skip notice missing"
[ ! -s "$NPX_LOG" ] || fail "pi skip must not call npx"
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

OPENROUTER_API_KEY=x run pi
[ "$RC" -eq 0 ] || fail "pi run exited $RC"
grep -q 'FACTORY_REAL_CLI=pi' "$NPX_LOG" || fail "FACTORY_REAL_CLI=pi not passed"
grep -q 'real-cli-loop.real-cli.test.ts' "$NPX_LOG" || fail "suite file not passed for pi"
echo "PASS: runs the real-cli suite for pi when OPENROUTER_API_KEY is set"

WF="$ROOT/.github/workflows/nightly-real-cli.yml"
grep -qF 'npm install -g @earendil-works/pi-coding-agent@1.2.0' "$WF" || fail "workflow lacks the exact Pi install"
if grep -o 'pi-coding-agent[^ "]*' "$WF" | grep -vqx 'pi-coding-agent@1.2.0'; then
  fail "workflow has a non-exact pi-coding-agent spec"
fi
grep -qF "if: env.OPENROUTER_API_KEY != ''" "$WF" || fail "Pi install is not gated on the secret"
grep -qF 'bash scripts/real-cli-smoke.sh pi' "$WF" || fail "workflow lacks the Pi smoke step"
echo "PASS: nightly workflow installs the exact Pi pin behind the secret"
