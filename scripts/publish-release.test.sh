#!/usr/bin/env bash
# Tests scripts/publish-release.sh (#2335): a skipped or failed publish can never show
# green. Each case runs the script in a scratch copy of the repo's publish files with stub
# `npm` and `gh` on PATH, and checks the exit code, the job-summary line and the
# `published=` step output. Together the cases cover every branch of the script.
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

# Scratch repo: the real scripts, list and package.json files, nothing else.
REPO="$WORK/repo"
mkdir -p "$REPO/scripts" "$REPO/packages"
cp "$ROOT/scripts/publish-release.sh" "$ROOT/scripts/publish-workspaces.sh" "$ROOT/scripts/publish-workspaces.txt" "$REPO/scripts/"
for f in "$ROOT"/packages/*/package.json; do
  d="$(basename "$(dirname "$f")")"
  mkdir -p "$REPO/packages/$d"
  cp "$f" "$REPO/packages/$d/package.json"
done

# A directory with no package.json (e.g. a leftover build dir) is skipped, not fatal.
mkdir -p "$REPO/packages/no-manifest"

BINDIR="$WORK/bin"
mkdir -p "$BINDIR"
export NPM_CALL_LOG="$WORK/npm-calls.log"
export GH_CALL_LOG="$WORK/gh-calls.log"
cat >"$BINDIR/npm" <<'STUB'
#!/usr/bin/env bash
echo "$@" >>"$NPM_CALL_LOG"
[ -z "${NPM_FAIL_ON:-}" ] || case "$*" in *"$NPM_FAIL_ON"*) exit 1 ;; esac
exit 0
STUB
# gh issue view N ... -> the state named by GH_STATE_<N> (default CLOSED); GH_FAIL=1 errors.
cat >"$BINDIR/gh" <<'STUB'
#!/usr/bin/env bash
echo "$@" >>"$GH_CALL_LOG"
[ "${GH_FAIL:-}" != "1" ] || { echo "gh: HTTP 401" >&2; exit 1; }
var="GH_STATE_$3"
echo "${!var:-CLOSED}"
STUB
chmod +x "$BINDIR/npm" "$BINDIR/gh"
export PATH="$BINDIR:$PATH"

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  [ -n "${line// /}" ] && NAMES+=("$line")
done <"$REPO/scripts/publish-workspaces.txt"

# run <expected exit> [VAR=value ...]: runs the script with a fresh summary/output/log.
SUMMARY="$WORK/summary.md"
OUTPUT="$WORK/output.txt"
run() {
  local want="$1"
  shift
  : >"$SUMMARY"
  : >"$OUTPUT"
  : >"$NPM_CALL_LOG"
  : >"$GH_CALL_LOG"
  local got=0
  env -u PUBLISH_DRY_RUN -u GITHUB_REF -u PUBLISH_BLOCKERS -u NPM_FAIL_ON -u GH_FAIL \
    GITHUB_STEP_SUMMARY="$SUMMARY" GITHUB_OUTPUT="$OUTPUT" GITHUB_REPOSITORY=on-par/software-factory \
    "$@" bash "$REPO/scripts/publish-release.sh" >"$WORK/stdout.txt" 2>&1 || got=$?
  [ "$got" = "$want" ] || { cat "$WORK/stdout.txt" >&2; fail "${CASE}: exit $got, want $want"; }
}
expect_summary() {
  [ "$(cat "$SUMMARY")" = "$1" ] || fail "${CASE}: summary was '$(cat "$SUMMARY")', want '$1'"
}
expect_output() {
  [ "$(cat "$OUTPUT")" = "published=$1" ] || fail "${CASE}: output was '$(cat "$OUTPUT")', want 'published=$1'"
}
expect_npm_calls() {
  [ "$(wc -l <"$NPM_CALL_LOG" | tr -d ' ')" = "$1" ] || fail "${CASE}: $(wc -l <"$NPM_CALL_LOG" | tr -d ' ') npm calls, want $1"
}

CASE="dry run"
run 0 PUBLISH_DRY_RUN=true GITHUB_REF=refs/tags/v0.9.0
expect_summary "NOT PUBLISHED: dry-run, not published"
expect_output false
expect_npm_calls "${#NAMES[@]}"
if grep -qv -- '--dry-run$' "$NPM_CALL_LOG"; then fail "$CASE: a call without --dry-run"; fi
[ ! -s "$GH_CALL_LOG" ] || fail "$CASE: dry run checked the blockers"

CASE="dry run fails"
run 1 PUBLISH_DRY_RUN=true NPM_FAIL_ON=@on-par/contracts
expect_summary "NOT PUBLISHED: dry-run failed"
expect_output false

CASE="no ref"
run 1
expect_summary "NOT PUBLISHED: no ref is not a release tag (refs/tags/v*)"
expect_output false
expect_npm_calls 0

CASE="branch ref"
run 1 PUBLISH_DRY_RUN=false GITHUB_REF=refs/heads/main
expect_summary "NOT PUBLISHED: refs/heads/main is not a release tag (refs/tags/v*)"
expect_output false
expect_npm_calls 0

CASE="blocker lookup fails"
run 1 GITHUB_REF=refs/tags/v0.9.0 GH_FAIL=1
expect_summary "NOT PUBLISHED: could not read the state of blocker #195"
expect_output false
expect_npm_calls 0

CASE="closed gate"
run 1 GITHUB_REF=refs/tags/v0.9.0 GH_STATE_151=OPEN
expect_summary "NOT PUBLISHED: v1.0 blockers still open: #151"
expect_output false
expect_npm_calls 0
[ "$(cat "$GH_CALL_LOG")" = "issue view 195 --repo on-par/software-factory --json state -q .state
issue view 151 --repo on-par/software-factory --json state -q .state" ] || fail "$CASE: gh calls were $(cat "$GH_CALL_LOG")"

CASE="closed gate, every blocker named"
run 1 GITHUB_REF=refs/tags/v0.9.0 PUBLISH_BLOCKERS="7 8" GH_STATE_7=OPEN GH_STATE_8=OPEN
expect_summary "NOT PUBLISHED: v1.0 blockers still open: #7 #8"

CASE="publish fails"
run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_FAIL_ON=@on-par/factory-core
expect_summary "NOT PUBLISHED: npm publish failed; packages before the failing one in scripts/publish-workspaces.txt may already be on the registry"
expect_output false

# Every package at its version, in list order.
want="PUBLISHED"
for name in "${NAMES[@]}"; do
  version="$(node -e 'const fs=require("fs");for(const d of fs.readdirSync(process.argv[1])){const f=process.argv[1]+"/"+d+"/package.json";if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,"utf8"));if(j.name===process.argv[2])process.stdout.write(j.version)}' "$REPO/packages" "$name")"
  [ -n "$version" ] || fail "no version for $name"
  want="$want $name@$version"
done

CASE="publish succeeds"
run 0 GITHUB_REF=refs/tags/v0.9.0
expect_summary "$want"
expect_output true
expect_npm_calls "${#NAMES[@]}"
i=0
while IFS= read -r call; do
  [ "$call" = "publish --workspace ${NAMES[$i]}" ] || fail "$CASE: call $i was '$call'"
  i=$((i + 1))
done <"$NPM_CALL_LOG"
[ "${#NAMES[@]}" = 7 ] || fail "expected 7 published packages, list has ${#NAMES[@]}"

CASE="gate removed (no blockers)"
run 0 GITHUB_REF=refs/tags/v0.9.0 PUBLISH_BLOCKERS=
expect_summary "$want"
[ ! -s "$GH_CALL_LOG" ] || fail "$CASE: checked blockers"

CASE="no GITHUB_OUTPUT or GITHUB_STEP_SUMMARY"
: >"$SUMMARY"
: >"$OUTPUT"
out="$(env -u GITHUB_OUTPUT -u GITHUB_STEP_SUMMARY GITHUB_REF=refs/tags/v0.9.0 bash "$REPO/scripts/publish-release.sh")"
[ "$(printf '%s\n' "$out" | tail -n 1)" = "$want" ] || fail "$CASE: stdout ended '$out'"
[ ! -s "$SUMMARY" ] && [ ! -s "$OUTPUT" ] || fail "$CASE: wrote a file"

CASE="package version unreadable"
echo "@on-par/not-a-package" >>"$REPO/scripts/publish-workspaces.txt"
run 1 GITHUB_REF=refs/tags/v0.9.0
expect_summary "NOT PUBLISHED: npm publish succeeded but the package versions could not be read"
expect_output false

echo "publish-release test OK"
