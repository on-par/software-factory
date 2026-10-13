#!/usr/bin/env bash
# Tests scripts/publish-release.sh (#2335, #2244): a skipped or failed publish can never
# show green, the tag name picks the version and dist-tag, and a main push publishes the
# next X.Y.Z-next.N prerelease. Each case runs the script in a fresh scratch copy of the
# repo's publish files with stub `npm` and `gh` on PATH, and checks the exit code, the
# job-summary line, the `published=` step output and the npm calls. Together the cases
# cover every branch of the script.
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

REPO="$WORK/repo"
# fresh_repo: the real publish scripts, list and package.json files, nothing else.
fresh_repo() {
  rm -rf "$REPO" "$NPM_REGISTRY"
  mkdir -p "$NPM_REGISTRY"
  mkdir -p "$REPO/scripts" "$REPO/packages"
  cp "$ROOT/scripts/publish-release.sh" "$ROOT/scripts/publish-workspaces.sh" \
    "$ROOT/scripts/set-release-version.sh" "$ROOT/scripts/publish-workspaces.txt" "$REPO/scripts/"
  local f d
  for f in "$ROOT"/packages/*/package.json; do
    d="$(basename "$(dirname "$f")")"
    mkdir -p "$REPO/packages/$d"
    cp "$f" "$REPO/packages/$d/package.json"
  done
}
# drift: puts one published package a version ahead of the rest.
drift() {
  node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version="9.9.9";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$REPO/packages/tui/package.json"
}

BINDIR="$WORK/bin"
mkdir -p "$BINDIR"
export NPM_CALL_LOG="$WORK/npm-calls.log"
export GH_CALL_LOG="$WORK/gh-calls.log"
export NPM_REGISTRY="$WORK/registry"
# Stub npm: logs calls; NPM_FAIL_ON fails a call containing it, NPM_FAIL_EXACT a call
# equal to it. `npm view <pkg> dist-tags.latest` prints NPM_STUB_LATEST (404 when unset);
# `npm view <pkg> versions --json` prints $NPM_REGISTRY/<pkg with / as __> (404 when
# missing); any other `npm view` 404s (nothing on the registry).
cat >"$BINDIR/npm" <<'STUB'
#!/usr/bin/env bash
echo "$@" >>"$NPM_CALL_LOG"
[ "$1" != --version ] || { [ "${NPM_VERSION_FAIL:-}" != 1 ] || exit 1; echo "${NPM_STUB_VERSION-11.5.1}"; exit 0; }
[ -z "${NPM_FAIL_ON:-}" ] || case "$*" in *"$NPM_FAIL_ON"*) exit 1 ;; esac
[ "$*" != "${NPM_FAIL_EXACT:-}" ] || exit 1
if [ "$1" = view ] && [ "$3" = dist-tags.latest ]; then
  [ -n "${NPM_STUB_LATEST:-}" ] || exit 1
  echo "$NPM_STUB_LATEST"
  exit 0
fi
if [ "$1" = view ] && [ "$3" = versions ]; then
  f="$NPM_REGISTRY/${2//\//__}"
  [ -f "$f" ] || exit 1
  cat "$f"
  exit 0
fi
[ "$1" != view ] || exit 1
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
done <"$ROOT/scripts/publish-workspaces.txt"
[ "${#NAMES[@]}" = 7 ] || fail "expected 7 published packages, list has ${#NAMES[@]}"
fresh_repo
CURRENT="$(bash "$REPO/scripts/set-release-version.sh" --current)"

# published_list <version>: the PUBLISHED payload for every package at <version>.
published_list() {
  local out="" n
  for n in "${NAMES[@]}"; do out="$out $n@$1"; done
  echo "$out"
}

SUMMARY="$WORK/summary.md"
OUTPUT="$WORK/output.txt"
# run <expected exit> [VAR=value ...]: runs the script with a fresh summary/output/logs.
# Call fresh_repo (and optionally drift) first.
run() {
  local want="$1"
  shift
  : >"$SUMMARY"
  : >"$OUTPUT"
  : >"$NPM_CALL_LOG"
  : >"$GH_CALL_LOG"
  local got=0
  env -u PUBLISH_DRY_RUN -u PUBLISH_PRERELEASE -u GITHUB_REF -u PUBLISH_BLOCKERS -u NPM_FAIL_ON -u NPM_FAIL_EXACT -u GH_FAIL -u NPM_STUB_VERSION -u NPM_VERSION_FAIL -u NPM_STUB_LATEST \
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
# expect_publishes <count> <suffix>: exactly <count> publish calls, each ending in <suffix>.
expect_publishes() {
  local calls
  calls="$(grep '^publish ' "$NPM_CALL_LOG" || true)"
  [ "$(grep -c . <<<"$calls" || true)" = "$1" ] || fail "${CASE}: publish calls were: $calls"
  [ "$1" = 0 ] || [ "$(grep -cE -- "$2\$" <<<"$calls")" = "$1" ] || fail "${CASE}: publish calls not ending '$2': $calls"
}

CASE="dry run on a branch uses the checked-out version"
fresh_repo
run 0 PUBLISH_DRY_RUN=true GITHUB_REF=refs/heads/main
expect_summary "NOT PUBLISHED: dry-run, not published"
expect_output false
expect_publishes 7 "--tag latest --provenance --dry-run"
[ ! -s "$GH_CALL_LOG" ] || fail "$CASE: dry run checked the blockers"

CASE="dry run on a next tag routes to next at the tag version"
fresh_repo
run 0 PUBLISH_DRY_RUN=true GITHUB_REF=refs/tags/v0.9.0-next.3
expect_summary "NOT PUBLISHED: dry-run, not published"
expect_publishes 7 "--tag next --provenance --dry-run"
[ "$(grep -c '^view @on-par/.*@0.9.0-next.3 version$' "$NPM_CALL_LOG")" = 7 ] || fail "$CASE: registry checks were not at 0.9.0-next.3"
grep -q '"@on-par/factory-core": "0.9.0-next.3"' "$REPO/packages/cli/package.json" || fail "$CASE: cli's core pin is not exact"

CASE="dry run fails"
fresh_repo
run 1 PUBLISH_DRY_RUN=true NPM_FAIL_ON=@on-par/contracts
expect_summary "NOT PUBLISHED: dry-run failed"
expect_output false

CASE="dry run with packages out of lockstep"
fresh_repo
drift
run 1 PUBLISH_DRY_RUN=true
expect_summary "NOT PUBLISHED: the packages are not at one version"
expect_publishes 0

CASE="no ref"
fresh_repo
run 1
expect_summary "NOT PUBLISHED: no ref is not a release tag (refs/tags/v*)"
expect_output false
[ ! -s "$NPM_CALL_LOG" ] || fail "$CASE: npm was called"

CASE="branch ref"
fresh_repo
run 1 PUBLISH_DRY_RUN=false GITHUB_REF=refs/heads/main
expect_summary "NOT PUBLISHED: refs/heads/main is not a release tag (refs/tags/v*)"
expect_output false

for tag in v1.0 v0.9.0-rc.1 v0.9.0-next.01 v0.9.0.1 vnext; do
  CASE="tag $tag does not parse"
  fresh_repo
  run 1 GITHUB_REF="refs/tags/$tag"
  expect_summary "NOT PUBLISHED: tag $tag does not parse as vX.Y.Z or vX.Y.Z-next.N"
  expect_output false
  [ ! -s "$NPM_CALL_LOG" ] || fail "$CASE: npm was called"
done

CASE="tag with packages out of lockstep"
fresh_repo
drift
run 1 GITHUB_REF=refs/tags/v0.9.0
expect_summary "NOT PUBLISHED: could not set the package versions to 0.9.0"
[ ! -s "$NPM_CALL_LOG" ] || fail "$CASE: npm was called"

CASE="blocker lookup fails"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 GH_FAIL=1
expect_summary "NOT PUBLISHED: could not read the state of blocker #195"
expect_output false
expect_publishes 7 "--dry-run"

CASE="closed gate"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 GH_STATE_151=OPEN
expect_summary "NOT PUBLISHED: v1.0 blockers still open: #151"
expect_output false
expect_publishes 7 "--dry-run"
[ "$(cat "$GH_CALL_LOG")" = "issue view 195 --repo on-par/software-factory --json state -q .state
issue view 151 --repo on-par/software-factory --json state -q .state" ] || fail "$CASE: gh calls were $(cat "$GH_CALL_LOG")"

CASE="closed gate, every blocker named"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 PUBLISH_BLOCKERS="7 8" GH_STATE_7=OPEN GH_STATE_8=OPEN
expect_summary "NOT PUBLISHED: v1.0 blockers still open: #7 #8"

CASE="publish fails"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_FAIL_EXACT="publish --workspace @on-par/factory-core --tag latest --provenance"
expect_summary "NOT PUBLISHED: npm publish failed; packages before the failing one in scripts/publish-workspaces.txt may already be on the registry (a rerun skips them)"
expect_output false

CASE="stable tag publishes all 7 to latest"
fresh_repo
run 0 GITHUB_REF=refs/tags/v0.9.0
expect_summary "PUBLISHED$(published_list 0.9.0) (--tag latest)"
expect_output true
calls="$(grep '^publish ' "$NPM_CALL_LOG")"
want=""
for n in "${NAMES[@]}"; do want="${want}publish --workspace $n --tag latest --provenance --dry-run"$'\n'; done
for n in "${NAMES[@]}"; do want="${want}publish --workspace $n --tag latest --provenance"$'\n'; done
[ "$calls" = "${want%$'\n'}" ] || fail "$CASE: publish calls were: $calls"

CASE="next tag publishes all 7 to next at the tag version"
fresh_repo
run 0 GITHUB_REF=refs/tags/v0.9.0-next.3
expect_summary "PUBLISHED$(published_list 0.9.0-next.3) (--tag next)"
expect_output true
expect_publishes 14 "--tag next --provenance( --dry-run)?"

for v in 11.5.0 10.9.2 11.5.1-pre.0; do
  CASE="npm $v is too old"
  fresh_repo
  run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_STUB_VERSION=$v
  expect_summary "NOT PUBLISHED: npm $v is older than 11.5.1, the minimum for npm trusted publishing (OIDC)"
  expect_output false
  expect_publishes 0
  [ ! -s "$GH_CALL_LOG" ] || fail "$CASE: gh was called"
done

CASE="npm too old on a dry run"
fresh_repo
run 1 PUBLISH_DRY_RUN=true NPM_STUB_VERSION=11.4.0
expect_summary "NOT PUBLISHED: npm 11.4.0 is older than 11.5.1, the minimum for npm trusted publishing (OIDC)"
expect_output false
expect_publishes 0

CASE="npm version unreadable (garbage)"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_STUB_VERSION=garbage
expect_summary "NOT PUBLISHED: could not read the npm version (got 'garbage')"
expect_output false
expect_publishes 0

CASE="npm version unreadable (empty)"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_STUB_VERSION=
expect_summary "NOT PUBLISHED: could not read the npm version (got '')"
expect_publishes 0

CASE="npm version unreadable (npm fails)"
fresh_repo
run 1 GITHUB_REF=refs/tags/v0.9.0 NPM_VERSION_FAIL=1
expect_summary "NOT PUBLISHED: could not read the npm version (got '')"
expect_publishes 0

for v in 11.5.1 12.0.0 11.10.0 11.6.0-pre.0 $'11.5.1\r'; do
  CASE="npm ${v%$'\r'} passes"
  fresh_repo
  run 0 GITHUB_REF=refs/tags/v0.9.0 NPM_STUB_VERSION="$v"
  expect_summary "PUBLISHED$(published_list 0.9.0) (--tag latest)"
  expect_output true
  expect_publishes 14 "--tag latest --provenance( --dry-run)?"
done

CASE="gate removed (no blockers), list with CRLF and blank lines"
fresh_repo
{ printf '\n'; for n in "${NAMES[@]}"; do printf '%s\r\n\n' "$n"; done; } >"$REPO/scripts/publish-workspaces.txt"
run 0 GITHUB_REF=refs/tags/v$CURRENT PUBLISH_BLOCKERS=
expect_summary "PUBLISHED$(published_list "$CURRENT") (--tag latest)"
[ ! -s "$GH_CALL_LOG" ] || fail "$CASE: checked blockers"

# registry <pkg> <json>: what `npm view <pkg> versions --json` prints.
registry() {
  printf '%s\n' "$2" >"$NPM_REGISTRY/${1//\//__}"
}

CASE="main prerelease with none published yet starts at next.1 above latest"
fresh_repo
run 0 PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/main NPM_STUB_LATEST=0.9.4
expect_summary "PUBLISHED$(published_list 0.9.5-next.1) (--tag next)"
expect_output true
expect_publishes 14 "--tag next --provenance( --dry-run)?"
grep -q '"@on-par/factory-core": "0.9.5-next.1"' "$REPO/packages/cli/package.json" || fail "$CASE: cli's core pin is not exact"

CASE="main prerelease takes the highest next.N across every package"
fresh_repo
registry @on-par/factory-cli '["0.9.4","0.9.5-next.1","0.9.5-next.2"]'
registry @on-par/adr-kit '["0.9.4","0.9.5-next.1","0.9.5-next.2","0.9.5-next.3"]'
registry @on-par/contracts '"0.9.4"'
registry @on-par/factory-core '["0.9.4-next.9","0.9.6-next.7","0.9.5-next.x","0.9.5-next.04"]'
run 0 PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/main NPM_STUB_LATEST=0.9.4
expect_summary "PUBLISHED$(published_list 0.9.5-next.4) (--tag next)"

CASE="main prerelease dry run computes the version and publishes nothing"
fresh_repo
registry @on-par/factory-cli '["1.2.3","1.2.4-next.5"]'
run 0 PUBLISH_DRY_RUN=true PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/main NPM_STUB_LATEST=1.2.3
expect_summary "NOT PUBLISHED: dry-run, not published"
expect_publishes 7 "--tag next --provenance --dry-run"
grep -q '"version": "1.2.4-next.6"' "$REPO/packages/cli/package.json" || fail "$CASE: cli is not at 1.2.4-next.6"

CASE="prerelease off main"
fresh_repo
run 1 PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/feature NPM_STUB_LATEST=0.9.4
expect_summary "NOT PUBLISHED: prereleases publish only from refs/heads/main, not refs/heads/feature"
expect_output false
[ ! -s "$NPM_CALL_LOG" ] || fail "$CASE: npm was called"

CASE="prerelease from a tag ref"
fresh_repo
run 1 PUBLISH_PRERELEASE=true GITHUB_REF=refs/tags/v0.9.0 NPM_STUB_LATEST=0.9.4
expect_summary "NOT PUBLISHED: prereleases publish only from refs/heads/main, not refs/tags/v0.9.0"

for latest in "" 0.9.4-next.1 garbage; do
  CASE="prerelease with unreadable latest '$latest'"
  fresh_repo
  run 1 PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/main NPM_STUB_LATEST="$latest"
  expect_summary "NOT PUBLISHED: could not work out the next prerelease version from npm"
  expect_output false
  expect_publishes 0
done

CASE="prerelease with packages out of lockstep"
fresh_repo
drift
run 1 PUBLISH_PRERELEASE=true GITHUB_REF=refs/heads/main NPM_STUB_LATEST=0.9.4
expect_summary "NOT PUBLISHED: could not set the package versions to 0.9.5-next.1"
expect_publishes 0

CASE="PUBLISH_PRERELEASE=false on main still needs a tag"
fresh_repo
run 1 PUBLISH_PRERELEASE=false GITHUB_REF=refs/heads/main
expect_summary "NOT PUBLISHED: refs/heads/main is not a release tag (refs/tags/v*)"

CASE="no GITHUB_OUTPUT or GITHUB_STEP_SUMMARY"
fresh_repo
: >"$SUMMARY"
: >"$OUTPUT"
out="$(env -u GITHUB_OUTPUT -u GITHUB_STEP_SUMMARY -u PUBLISH_DRY_RUN -u PUBLISH_PRERELEASE -u PUBLISH_BLOCKERS -u NPM_FAIL_ON -u NPM_FAIL_EXACT -u GH_FAIL -u NPM_STUB_VERSION -u NPM_VERSION_FAIL \
  GITHUB_REF=refs/tags/v0.9.0 bash "$REPO/scripts/publish-release.sh")"
[ "$(printf '%s\n' "$out" | tail -n 1)" = "PUBLISHED$(published_list 0.9.0) (--tag latest)" ] || fail "$CASE: stdout ended '$out'"
[ ! -s "$SUMMARY" ] && [ ! -s "$OUTPUT" ] || fail "$CASE: wrote a file"

echo "publish-release test OK"
