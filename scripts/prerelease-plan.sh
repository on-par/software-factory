#!/usr/bin/env bash
# Plans the per-merge alpha pre-release (#2245): decides whether the merge commit at HEAD
# needs one and, if so, which version. publish.yml runs it on `workflow_run` of a green CI
# on main, then hands the version to publish-release.sh (PUBLISH_PRERELEASE_VERSION).
#
#   prerelease-plan.sh <run_number>
#
# Skip: HEAD~1..HEAD changes no file under a published package's directory (the packages
# in scripts/publish-workspaces.txt) and not the root package-lock.json. Without HEAD~1
# (shallow or root commit) it never skips.
#
# Version: <next patch>-alpha.<run_number>, where next patch is the patch after the higher
# of the packages' lockstep version and npm `latest` for @on-par/factory-cli. A plain
# <version>-next.N would sort below the release already on `latest`.
#
# Output: `version=<v>` or `version=` (skip) to GITHUB_OUTPUT, and one job-summary line
# (`PRE-RELEASE <v>` or `NOT PUBLISHED: <reason>`). Exits 1 on any error.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

set_version() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "version=$1" >>"$GITHUB_OUTPUT"; fi
}

fail() {
  summary "NOT PUBLISHED: $1"
  set_version ""
  exit 1
}

run_number="${1:-}"
[[ "$run_number" =~ ^[1-9][0-9]*$ ]] || fail "run number '${run_number}' is not a positive integer"

# Directories of the published packages, matched by package.json name.
dirs=()
while IFS= read -r name || [ -n "$name" ]; do
  name="${name//$'\r'/}"
  name="${name//[[:space:]]/}"
  [ -n "$name" ] || continue
  dir=""
  for f in packages/*/package.json; do
    if [ "$(node -p 'require(process.argv[1]).name' "$ROOT/$f")" = "$name" ]; then
      dir="$(dirname "$f")"
      break
    fi
  done
  [ -n "$dir" ] || fail "no package directory for $name"
  dirs+=("$dir/")
done <scripts/publish-workspaces.txt

if git rev-parse --verify --quiet HEAD~1 >/dev/null; then
  changed="$(git diff --name-only HEAD~1 HEAD)"
  hit=""
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ "$path" != package-lock.json ] || { hit="$path"; break; }
    for d in "${dirs[@]}"; do
      case "$path" in "$d"*) hit="$path"; break 2 ;; esac
    done
  done <<<"$changed"
  if [ -z "$hit" ]; then
    summary "NOT PUBLISHED: $(git rev-parse --short HEAD) changes no published package"
    set_version ""
    exit 0
  fi
fi

current="$(bash scripts/set-release-version.sh --current)" || fail "the packages are not at one version"
latest="$(npm view @on-par/factory-cli dist-tags.latest 2>/dev/null)" || fail "could not read npm latest for @on-par/factory-cli"

version="$(node -e '
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(v.trim());
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1, 4).map(Number);
};
const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const [x, y, z] = cmp >= 0 ? a : b;
console.log(`${x}.${y}.${z + 1}-alpha.${process.argv[3]}`);
' "$current" "$latest" "$run_number")" || fail "could not compute the next version from $current and latest $latest"

summary "PRE-RELEASE $version (packages at $current, npm latest $latest)"
set_version "$version"
