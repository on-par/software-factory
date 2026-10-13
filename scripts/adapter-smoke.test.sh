#!/usr/bin/env bash
# Unit test for scripts/adapter-smoke.sh argument validation using an `npm` stub that logs calls.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

NPM_LOG="$BINDIR/npm.log"
export NPM_LOG

cat >"$BINDIR/npm" <<'EOF2'
#!/usr/bin/env bash
echo "$*" >>"$NPM_LOG"
exit 1
EOF2
chmod +x "$BINDIR/npm"

export PATH="$BINDIR:$PATH"
SCRIPT="$ROOT/scripts/adapter-smoke.sh"
OUT=""
RC=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  : >"$NPM_LOG"
  RC=0
  OUT=$(bash "$SCRIPT" "$@" 2>&1) || RC=$?
}

run
[ "$RC" -eq 2 ] || fail "no argument exited $RC"
echo "$OUT" | grep -q 'usage:' || fail "usage line missing"
[ ! -s "$NPM_LOG" ] || fail "no argument must not call npm"
for agent in opencode command claude CODEX; do
  run "$agent"
  [ "$RC" -eq 2 ] || fail "$agent exited $RC"
  [ ! -s "$NPM_LOG" ] || fail "$agent must not call npm"
done
bash -n "$SCRIPT" || fail "adapter-smoke.sh has a syntax error"
echo "PASS: rejects a missing or unsupported agent before packing"
