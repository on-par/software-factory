#!/usr/bin/env bash
# Tests scripts/prerelease-plan.sh (#2245): the per-merge alpha is skipped when the merge
# commit touches no published package, and otherwise versioned as the patch after the
# higher of the lockstep version and npm `latest`, plus -alpha.<run_number>. Each case runs
# the script in a scratch git repo holding the real publish files, with a stub `npm`.
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
# Stub npm: `npm view ... dist-tags.latest` prints NPM_LATEST, or fails when NPM_LATEST_FAIL=1.
cat >"$BINDIR/npm" <<'STUB'
#!/usr/bin/env bash
[ "${NPM_LATEST_FAIL:-}" != "1" ] || exit 1
[ "$1" = view ] && [ "$3" = dist-tags.latest ] && { echo "$NPM_LATEST"; exit 0; }
echo "unexpected npm $*" >&2
exit 1
STUB
chmod +x "$BINDIR/npm"
export PATH="$BINDIR:$PATH"

REPO="$WORK/repo"
# fresh_repo <version>: a git repo with the publish scripts and every package.json at
# <version>, committed as the base, so a test commit on top is HEAD.
fresh_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/scripts" "$REPO/packages" "$REPO/docs"
  cp "$ROOT/scripts/prerelease-plan.sh" "$ROOT/scripts/set-release-version.sh" \
    "$ROOT/scripts/publish-workspaces.txt" "$REPO/scripts/"
  local f d
  for f in "$ROOT"/packages/*/package.json; do
    d="$(basename "$(dirname "$f")")"
    mkdir -p "$REPO/packages/$d"
    cp "$f" "$REPO/packages/$d/package.json"
  done
  echo '{}' >"$REPO/package-lock.json"
  (
    cd "$REPO"
    git init -q --initial-branch=main
    git config user.email tests@example.com
    git config user.name Tests
    git add .
    git commit -qm base
  )
  bash "$REPO/scripts/set-release-version.sh" "$1" >/dev/null
  (cd "$REPO" && git commit -qam "version $1")
}
# commit_change <path>: changes <path> and commits it as HEAD.
commit_change() {
  mkdir -p "$(dirname "$REPO/$1")"
  echo "$RANDOM" >>"$REPO/$1"
  (cd "$REPO" && git add -A && git commit -qm "change $1")
}

SUMMARY="$WORK/summary.md"
OUTPUT="$WORK/output.txt"
# run <expected exit> <run_number> [VAR=value ...]
run() {
  local want="$1" n="$2"
  shift 2
  : >"$SUMMARY"
  : >"$OUTPUT"
  local got=0
  env -u NPM_LATEST_FAIL GITHUB_STEP_SUMMARY="$SUMMARY" GITHUB_OUTPUT="$OUTPUT" NPM_LATEST=0.9.4 "$@" \
    bash "$REPO/scripts/prerelease-plan.sh" "$n" >"$WORK/stdout.txt" 2>&1 || got=$?
  [ "$got" = "$want" ] || { cat "$WORK/stdout.txt" >&2; fail "${CASE}: exit $got, want $want"; }
}
expect_version() {
  [ "$(cat "$OUTPUT")" = "version=$1" ] || fail "${CASE}: output was '$(cat "$OUTPUT")', want 'version=$1'"
}
expect_summary() {
  grep -qF -- "$1" "$SUMMARY" || fail "${CASE}: summary was '$(cat "$SUMMARY")', want '$1'"
}

CASE="core change while main is at latest -> next patch alpha"
fresh_repo 0.9.4
commit_change packages/core/src/x.ts
run 0 57
expect_version 0.9.5-alpha.57
expect_summary "PRE-RELEASE 0.9.5-alpha.57 (packages at 0.9.4, npm latest 0.9.4)"

CASE="main ahead of latest bases on main"
fresh_repo 0.10.0
commit_change packages/cli/src/x.ts
run 0 3
expect_version 0.10.1-alpha.3

CASE="latest ahead of main bases on latest"
fresh_repo 0.9.2
commit_change packages/config/src/x.ts
run 0 9 NPM_LATEST=1.2.3
expect_version 1.2.4-alpha.9

CASE="root lockfile change publishes"
fresh_repo 0.9.4
commit_change package-lock.json
run 0 4
expect_version 0.9.5-alpha.4

CASE="docs-only change is skipped"
fresh_repo 0.9.4
commit_change docs/readme.md
run 0 5
expect_version ""
expect_summary "changes no published package"

CASE="unpublished package change is skipped"
fresh_repo 0.9.4
commit_change packages/dashboard/src/x.ts
run 0 6
expect_version ""
expect_summary "changes no published package"

CASE="root commit never skips"
fresh_repo 0.9.4
(cd "$REPO" && git checkout -q --orphan solo && git commit -qm solo)
run 0 7
expect_version 0.9.5-alpha.7

for n in "" 0 07 x; do
  CASE="run number '$n' is rejected"
  fresh_repo 0.9.4
  commit_change packages/core/src/x.ts
  run 1 "$n"
  expect_version ""
  expect_summary "is not a positive integer"
done

CASE="npm latest unreadable fails"
fresh_repo 0.9.4
commit_change packages/core/src/x.ts
run 1 8 NPM_LATEST_FAIL=1
expect_version ""
expect_summary "NOT PUBLISHED: could not read npm latest"

echo "prerelease-plan test OK"
