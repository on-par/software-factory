#!/usr/bin/env bash
# Unit test for scripts/triage-factory-report.sh using a no-network `gh` stub that logs
# its argv to $GH_CALL_LOG (same pattern as scripts/repo-merge-settings.test.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

GH_CALL_LOG="$BINDIR/gh-calls.log"
export GH_CALL_LOG

cat >"$BINDIR/gh" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >>"$GH_CALL_LOG"
exit 0
EOF2
chmod +x "$BINDIR/gh"

export PATH="$BINDIR:$PATH"
export REPO="test-org/test-repo"
export ISSUE_NUMBER=42

SCRIPT="$ROOT/scripts/triage-factory-report.sh"
WORKFLOW="$ROOT/.github/workflows/triage-factory-reports.yml"
OUT=""
RC=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  : >"$GH_CALL_LOG"
  RC=0
  OUT="$(ISSUE_BODY="$1" bash "$SCRIPT" 2>&1)" || RC=$?
}

calls() { wc -l <"$GH_CALL_LOG" | tr -d ' '; }

assert_labeled() {
  [ "$RC" = 0 ] || fail "$1: exit $RC"
  [ "$(calls)" = 1 ] || fail "$1: expected exactly one gh call"
  local call
  call="$(cat "$GH_CALL_LOG")"
  for want in "api" "-X POST" "repos/test-org/test-repo/issues/42/labels" \
    "labels[]=bug" "labels[]=factory:auto-filed" "labels[]=factory:needs-triage"; do
    case "$call" in *"$want"*) ;; *) fail "$1: missing '$want' in: $call" ;; esac
  done
  [ "$(grep -o 'labels\[\]=' <<<"$call" | wc -l | tr -d ' ')" = 3 ] || fail "$1: expected 3 labels"
  echo "PASS: $1"
}

assert_unlabeled() {
  [ "$RC" = 0 ] || fail "$1: exit $RC"
  [ "$(calls)" = 0 ] || fail "$1: expected no gh calls"
  echo "PASS: $1"
}

MARKER='<!-- factory-upstream-report v1 fp:abc_DEF-123 -->'
BODY="## Summary
something broke

## Details
more

$MARKER
"

# 1. real report
run "$BODY"
assert_labeled "report body is labeled"

# 2. CRLF
run "${BODY//$'\n'/$'\r\n'}"
assert_labeled "CRLF report body is labeled"

# 3. no marker
run "just a normal issue"
assert_unlabeled "no marker"
case "$OUT" in *"no labels added"*) ;; *) fail "no marker: missing log line" ;; esac

# 4. malformed markers
LONG="$(printf 'a%.0s' $(seq 1 65))"
for bad in \
  '<!-- factory-upstream-report v2 fp:abc -->' \
  '<!-- factory-upstream-report v1 fp: -->' \
  '<!-- factory-upstream-report v1 fp:has space -->' \
  "<!-- factory-upstream-report v1 fp:$LONG -->" \
  "see $MARKER" \
  '<!-- factory-upstream-report v1 fp:abc'; do
  run "$bad"
  assert_unlabeled "malformed marker: $bad"
done

# 5. injection-shaped body
run "\$(touch $BINDIR/pwned) \`touch $BINDIR/pwned\`
$MARKER"
assert_labeled "injection-shaped body is labeled"
[ ! -e "$BINDIR/pwned" ] || fail "injection executed"

# 6. empty body
run ""
assert_unlabeled "empty body"

# 7. bad issue number
: >"$GH_CALL_LOG"
RC=0
ISSUE_NUMBER=abc ISSUE_BODY="$MARKER" bash "$SCRIPT" >/dev/null 2>&1 || RC=$?
[ "$RC" != 0 ] || fail "bad ISSUE_NUMBER should fail"
[ "$(calls)" = 0 ] || fail "bad ISSUE_NUMBER made gh calls"
echo "PASS: bad ISSUE_NUMBER rejected"

# 8. static checks
for f in "$WORKFLOW" "$SCRIPT"; do
  if grep -Eq 'factory:queued|factory:lane|factory:order|factory:in-progress' "$f"; then
    fail "$f mentions a queue/lane/order label"
  fi
done
grep -qF 'types: [opened]' "$WORKFLOW" || fail "workflow must trigger on opened"
grep -qF 'ISSUE_BODY: ${{ github.event.issue.body }}' "$WORKFLOW" || fail "workflow must pass body via env"
if grep -E 'run:' "$WORKFLOW" | grep -q 'github.event'; then
  fail "run: line interpolates github.event"
fi
echo "PASS: static workflow/script checks"
