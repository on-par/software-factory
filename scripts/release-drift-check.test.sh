#!/usr/bin/env bash
# Tests scripts/release-drift-check.sh (#4123): matching npm and GitHub latest pass,
# a mismatch or a failed lookup fails, both values reach the summary, and a lagging
# read is retried. Stub `npm` and `gh` on PATH stand in for the registry and the API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

BINDIR="$WORK/bin"
mkdir -p "$BINDIR"
cat >"$BINDIR/npm" <<'STUB'
#!/usr/bin/env bash
if [ -n "${NPM_COUNTER:-}" ]; then
  n=$(($(cat "$NPM_COUNTER" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$NPM_COUNTER"
  [ "$n" -gt 1 ] || { echo "${NPM_STUB_OLD:-0.9.1}"; exit 0; }
fi
[ -n "${NPM_STUB_LATEST:-}" ] || exit 1
echo "$NPM_STUB_LATEST"
STUB
cat >"$BINDIR/gh" <<'STUB'
#!/usr/bin/env bash
[ "${GH_FAIL:-}" != 1 ] || exit 1
[ -n "${GH_STUB_LATEST:-}" ] || exit 1
echo "$GH_STUB_LATEST"
STUB
chmod +x "$BINDIR/npm" "$BINDIR/gh"
export PATH="$BINDIR:$PATH"
export GITHUB_REPOSITORY=on-par/software-factory
export DRIFT_ATTEMPTS=1
export DRIFT_SLEEP=0

SUMMARY="$WORK/summary"
STATUS=0
run() {
  : >"$SUMMARY"
  STATUS=0
  GITHUB_STEP_SUMMARY="$SUMMARY" bash "$ROOT/scripts/release-drift-check.sh" >"$WORK/out" 2>&1 || STATUS=$?
}

NPM_STUB_LATEST=0.9.40 GH_STUB_LATEST=v0.9.40 run
[ "$STATUS" -eq 0 ] || fail "matching values: exit $STATUS"
grep -q 'RELEASE IN SYNC' "$SUMMARY" || fail "matching values: no IN SYNC line"
echo "PASS: matching values pass"

NPM_STUB_LATEST=0.9.37 GH_STUB_LATEST=v0.9.28 run
[ "$STATUS" -ne 0 ] || fail "mismatched values exited 0"
grep -q 'RELEASE DRIFT' "$SUMMARY" || fail "mismatched values: no DRIFT line"
echo "PASS: mismatched values fail"

grep -q '0.9.37' "$SUMMARY" && grep -q 'v0.9.28' "$SUMMARY" || fail "summary lacks both values"
grep -q '0.9.37' "$WORK/out" || fail "stdout lacks the values"
echo "PASS: summary reports both values"

GH_STUB_LATEST=v0.9.40 run
[ "$STATUS" -eq 1 ] || fail "npm lookup failure: exit $STATUS"
grep -q 'unavailable' "$SUMMARY" || fail "npm lookup failure: no unavailable"
echo "PASS: npm lookup failure fails"

NPM_STUB_LATEST=0.9.40 GH_STUB_LATEST=v0.9.40 GH_FAIL=1 run
[ "$STATUS" -eq 1 ] || fail "gh lookup failure: exit $STATUS"
echo "PASS: gh lookup failure fails"

rm -f "$WORK/counter"
NPM_COUNTER="$WORK/counter" NPM_STUB_LATEST=0.9.40 GH_STUB_LATEST=v0.9.40 DRIFT_ATTEMPTS=2 run
[ "$STATUS" -eq 0 ] || fail "retry: exit $STATUS"
grep -q 'RELEASE IN SYNC' "$SUMMARY" || fail "retry: no IN SYNC line"
echo "PASS: retries until match"
