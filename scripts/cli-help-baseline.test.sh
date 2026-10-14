#!/usr/bin/env bash
# Unit test for scripts/cli-help-baseline.sh using a stub CLI that prints $STUB_HELP.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

cat >"$TMP/cli.js" <<'EOF2'
if (process.argv[2] === '--help') {
  process.stdout.write((process.env.STUB_HELP ?? '') + '\n');
  process.stderr.write('stub-stderr-noise\n');
}
EOF2

SCRIPT="$ROOT/scripts/cli-help-baseline.sh"
export FACTORY_HELP_CLI="$TMP/cli.js"
export FACTORY_HELP_BASELINE="$TMP/baseline.txt"
OUT=""
RC=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  RC=0
  OUT=$(bash "$SCRIPT" "$@" 2>/dev/null) || RC=$?
}

FACTORY_HELP_CLI="$TMP/missing.js" run
[ "$RC" -eq 2 ] || fail "missing cli exited $RC"
RC=0
OUT=$(FACTORY_HELP_CLI="$TMP/missing.js" bash "$SCRIPT" 2>&1) || RC=$?
echo "$OUT" | grep -q 'npm run build' || fail "missing cli message lacks npm run build"
echo "PASS: missing CLI exits 2"

run --bogus
[ "$RC" -eq 2 ] || fail "unknown arg exited $RC"
echo "PASS: rejects an unknown argument"

run
[ "$RC" -eq 2 ] || fail "missing baseline exited $RC"
echo "PASS: missing baseline exits 2"

STUB_HELP=A run --update
[ "$RC" -eq 0 ] || fail "update exited $RC"
[ "$(cat "$FACTORY_HELP_BASELINE")" = "A" ] || fail "baseline not written from stub help"
grep -q 'stub-stderr-noise' "$FACTORY_HELP_BASELINE" && fail "stderr leaked into baseline"
echo "PASS: --update writes the baseline"

STUB_HELP=A run
[ "$RC" -eq 0 ] || fail "matching help exited $RC"
[ -z "$OUT" ] || fail "matching help printed output: $OUT"
echo "PASS: matching help passes with no output"

STUB_HELP=B run
[ "$RC" -eq 1 ] || fail "drifted help exited $RC"
echo "$OUT" | grep -q '^-A$' || fail "diff lacks -A"
echo "$OUT" | grep -q '^+B$' || fail "diff lacks +B"
RC=0
OUT=$(STUB_HELP=B bash "$SCRIPT" 2>&1) || RC=$?
echo "$OUT" | grep -q 'drifted' || fail "drift message missing"
echo "PASS: drifted help exits 1 with a diff"

echo "PASS: cli-help-baseline.sh"
