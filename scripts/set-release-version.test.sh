#!/usr/bin/env bash
# Tests scripts/set-release-version.sh (#2244) in a scratch copy of the package.json
# files: lockstep version set with exact internal pins, drift caught and named, usage
# errors. Together the cases cover every branch of the script.
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
mkdir -p "$REPO/scripts" "$REPO/packages/no-manifest"
cp "$ROOT/scripts/set-release-version.sh" "$ROOT/scripts/publish-workspaces.txt" "$REPO/scripts/"
for f in "$ROOT"/packages/*/package.json; do
  d="$(basename "$(dirname "$f")")"
  mkdir -p "$REPO/packages/$d"
  cp "$f" "$REPO/packages/$d/package.json"
done
SET="$REPO/scripts/set-release-version.sh"

# pkg <dir> <node expression on j>: evaluates against packages/<dir>/package.json.
pkg() {
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$REPO/packages/$1/package.json" "$2"
}
edit() {
  node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));eval(process.argv[2]);fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$REPO/packages/$1/package.json" "$2"
}

# The checked-in packages are in lockstep at a stable version with ^ internal ranges.
CURRENT="$(bash "$SET" --current)"
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "--current printed '$CURRENT'"
[ "$(pkg cli 'j.dependencies["@on-par/factory-core"]')" = "^$CURRENT" ] || fail "cli's core range is not ^$CURRENT"

# Every dependency field is rewritten; non-@on-par deps and private packages are not.
edit tui 'j.devDependencies={...j.devDependencies,"@on-par/contracts":"^0.0.1"};j.peerDependencies={"@on-par/adr-kit":"*"};j.optionalDependencies={"@on-par/repo-context":"^0.0.1"}'
DASH_BEFORE="$(cat "$REPO/packages/dashboard/package.json")"
LOCK_DEP="$(pkg core 'j.dependencies["@octokit/rest"]')"

out="$(bash "$SET" 0.9.0-next.3)"
[ "$(wc -l <<<"$out" | tr -d ' ')" = 7 ] || fail "expected 7 packages set, got: $out"
for f in "$REPO"/packages/*/package.json; do
  d="$(basename "$(dirname "$f")")"
  name="$(pkg "$d" 'j.name')"
  grep -qx "$name" "$REPO/scripts/publish-workspaces.txt" || continue
  [ "$(pkg "$d" 'j.version')" = 0.9.0-next.3 ] || fail "$name version is $(pkg "$d" 'j.version')"
  bad="$(pkg "$d" '["dependencies","devDependencies","peerDependencies","optionalDependencies"].flatMap((k)=>Object.entries(j[k]||{})).filter(([n,v])=>n.startsWith("@on-par/")&&v!=="0.9.0-next.3").map(([n,v])=>n+"="+v).join(",")')"
  [ -z "$bad" ] || fail "$name has inexact internal pins: $bad"
done
[ "$(pkg tui 'j.peerDependencies["@on-par/adr-kit"]')" = 0.9.0-next.3 ] || fail "peerDependencies not pinned"
[ "$(pkg tui 'j.optionalDependencies["@on-par/repo-context"]')" = 0.9.0-next.3 ] || fail "optionalDependencies not pinned"
[ "$(pkg tui 'j.devDependencies["@on-par/contracts"]')" = 0.9.0-next.3 ] || fail "devDependencies not pinned"
[ "$(pkg core 'j.dependencies["@octokit/rest"]')" = "$LOCK_DEP" ] || fail "a third-party range changed"
[ "$(cat "$REPO/packages/dashboard/package.json")" = "$DASH_BEFORE" ] || fail "a private package changed"
[ "$(bash "$SET" --current)" = 0.9.0-next.3 ] || fail "--current after set"

# Lockstep drift: one package ahead fails and is named, for both forms.
edit tui 'j.version="0.9.1"'
if bash "$SET" 0.9.0-next.4 >/dev/null 2>"$WORK/err.txt"; then fail "drift not caught"; fi
grep -q '@on-par/factory-tui@0.9.1' "$WORK/err.txt" || fail "drift message did not name the package: $(cat "$WORK/err.txt")"
[ "$(pkg core 'j.version')" = 0.9.0-next.3 ] || fail "drift run still wrote versions"
if bash "$SET" --current >/dev/null 2>&1; then fail "--current ignored drift"; fi
edit tui 'j.version="0.9.0-next.3"'

# Usage errors exit 2 without writing.
for args in "" "--current extra" "-x" "1.0" "v0.9.0" "0.9.0-" "01.2.3"; do
  set +e
  # shellcheck disable=SC2086
  bash "$SET" $args >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" = 2 ] || fail "'$args' exited $rc, want 2"
done
[ "$(pkg core 'j.version')" = 0.9.0-next.3 ] || fail "a usage error wrote versions"

# A listed package with no package.json fails and is named.
echo "@on-par/not-a-package" >>"$REPO/scripts/publish-workspaces.txt"
if bash "$SET" --current >/dev/null 2>"$WORK/err.txt"; then fail "unknown package accepted"; fi
grep -q 'no package.json for @on-par/not-a-package' "$WORK/err.txt" || fail "unknown package message: $(cat "$WORK/err.txt")"

echo "set-release-version test OK"
