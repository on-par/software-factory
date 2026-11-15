#!/usr/bin/env bash
# Tests scripts/github-release.sh (#4123): a stable tag creates its release (Latest only
# for the highest stable version), an existing release is edited, a prerelease tag gets
# none, and a bad tag, a missing CHANGELOG section or failing contract notes fail. Each
# case runs the script in a scratch git repo with stub `gh` and `npx` on PATH.
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
export GH_CALL_LOG="$WORK/gh-calls.log"
export NPX_CALL_LOG="$WORK/npx-calls.log"
cat >"$BINDIR/gh" <<'STUB'
#!/usr/bin/env bash
echo "$@" >>"$GH_CALL_LOG"
if [ "$1 $2" = "release view" ]; then
  [ "${GH_RELEASE_EXISTS:-}" = 1 ]
  exit $?
fi
if [ "$1" = release ] && { [ "$2" = create ] || [ "$2" = edit ]; }; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --notes-file ]; then cp "$2" "$WORK_BODY"; fi
    shift
  done
fi
exit 0
STUB
cat >"$BINDIR/npx" <<'STUB'
#!/usr/bin/env bash
echo "$@" >>"$NPX_CALL_LOG"
[ "${NPX_FAIL:-}" != 1 ] || exit 1
echo "No CLI JSON contract changes"
STUB
chmod +x "$BINDIR/gh" "$BINDIR/npx"
export PATH="$BINDIR:$PATH"
export WORK_BODY="$WORK/body"
export GITHUB_REPOSITORY=on-par/software-factory
export GH_TOKEN=stub

REPO="$WORK/repo"
SUMMARY="$WORK/summary"
STATUS=0
fresh_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/scripts"
  cp "$ROOT/scripts/github-release.sh" "$REPO/scripts/"
  printf '# Changelog\n\n## Unreleased\n\n## 0.9.2 - 2026-11-15\n\n- thing (#1)\n\n## 0.9.1\n\n## [0.9.0]\n\n## [0.9.10]\n\n- ten\n' >"$REPO/CHANGELOG.md"
  git -C "$REPO" init -q
  git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
  local t
  for t in "$@"; do git -C "$REPO" tag "$t"; done
  : >"$GH_CALL_LOG"
  : >"$NPX_CALL_LOG"
  : >"$SUMMARY"
  rm -f "$WORK_BODY"
}
run() {
  STATUS=0
  RELEASE_TAG="$1" GITHUB_STEP_SUMMARY="$SUMMARY" bash "$REPO/scripts/github-release.sh" >"$WORK/out" 2>&1 || STATUS=$?
}

fresh_repo v0.9.0 v0.9.1 v0.9.2 v0.9.3-next.1
run v0.9.2
[ "$STATUS" -eq 0 ] || fail "highest stable: exit $STATUS: $(cat "$WORK/out")"
grep -q 'release create v0.9.2' "$GH_CALL_LOG" || fail "no release create"
grep -q -- '--verify-tag' "$GH_CALL_LOG" || fail "no --verify-tag"
grep -q -- '--title 0.9.2' "$GH_CALL_LOG" || fail "no --title 0.9.2"
grep -q -- '--latest$' "$GH_CALL_LOG" || fail "not marked --latest"
grep -q -- '- thing (#1)' "$WORK_BODY" || fail "body lacks the CHANGELOG section"
grep -q 'No CLI JSON contract changes' "$WORK_BODY" || fail "body lacks contract notes"
grep -q 'compare/v0.9.1...v0.9.2' "$WORK_BODY" || fail "body lacks the compare link"
grep -q -- '## 0.9.1' "$WORK_BODY" && fail "body leaks the next section"
grep -q -- '--from v0.9.1 --to v0.9.2' "$NPX_CALL_LOG" || fail "npx range wrong"
grep -q 'RELEASE CREATED v0.9.2 (latest)' "$SUMMARY" || fail "summary line wrong"
echo "PASS: stable highest tag creates release marked latest with changelog body"

fresh_repo v0.9.0 v0.9.1 v0.9.2
export GH_RELEASE_EXISTS=1
run v0.9.2
[ "$STATUS" -eq 0 ] || fail "edit: exit $STATUS"
grep -q 'release edit v0.9.2' "$GH_CALL_LOG" || fail "no release edit"
grep -q 'release create' "$GH_CALL_LOG" && fail "recreated an existing release"
run v0.9.2
[ "$STATUS" -eq 0 ] || fail "second edit: exit $STATUS"
unset GH_RELEASE_EXISTS
echo "PASS: existing release is edited not recreated"

fresh_repo v0.9.0 v0.9.1 v0.9.2 v0.9.3-next.1
run v0.9.3-next.1
[ "$STATUS" -eq 0 ] || fail "prerelease: exit $STATUS"
grep -q -E 'release (create|edit)' "$GH_CALL_LOG" && fail "prerelease wrote a release"
grep -q 'NO RELEASE' "$SUMMARY" || fail "prerelease: no NO RELEASE line"
echo "PASS: next prerelease tag creates no release"

fresh_repo v0.9.0 v0.9.1 v0.9.2
run v0.9.1
[ "$STATUS" -eq 0 ] || fail "older: exit $STATUS"
grep -q -- '--latest=false' "$GH_CALL_LOG" || fail "older tag not --latest=false"
echo "PASS: older stable tag is not marked latest"

fresh_repo v0.9.0 v0.9.1 v0.9.2 v0.9.10
run v0.9.10
[ "$STATUS" -eq 0 ] || fail "sort: exit $STATUS"
grep -q -- '--latest$' "$GH_CALL_LOG" || fail "v0.9.10 not --latest"
grep -q -- '--from v0.9.2 --to v0.9.10' "$NPX_CALL_LOG" || fail "previous tag is not v0.9.2"
echo "PASS: version sort beats lexical sort"

fresh_repo v0.9.0
run v0.9.0
[ "$STATUS" -eq 0 ] || fail "first tag: exit $STATUS"
grep -q 'commits/v0.9.0' "$WORK_BODY" || fail "body lacks the commits link"
[ ! -s "$NPX_CALL_LOG" ] || fail "npx called for the first tag"
echo "PASS: first stable tag has commits link and no contract notes"

fresh_repo v0.9.0 v0.9.1 v0.9.2 v0.9.5
run v0.9.5
[ "$STATUS" -eq 1 ] || fail "missing section: exit $STATUS"
grep -q 'NOT RELEASED' "$SUMMARY" || fail "missing section: no NOT RELEASED line"
echo "PASS: missing changelog section fails"

fresh_repo v0.9.0 v0.9.1 v0.9.2
run main
[ "$STATUS" -eq 1 ] || fail "malformed tag: exit $STATUS"
run ""
[ "$STATUS" -eq 1 ] || fail "empty tag: exit $STATUS"
echo "PASS: malformed tag fails"

fresh_repo v0.9.0 v0.9.1 v0.9.2
NPX_FAIL=1 run v0.9.2
[ "$STATUS" -eq 1 ] || fail "contract failure: exit $STATUS"
grep -q 'release create' "$GH_CALL_LOG" && fail "released despite contract notes failure"
echo "PASS: contract notes failure fails"
