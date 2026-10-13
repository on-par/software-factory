#!/usr/bin/env bash
# Runs the "Publish to npm" step of publish.yml (#2335). A skipped or failed publish
# can never show green: every path ends with exactly one job-summary line and a
# `published=true|false` step output.
#   PUBLISHED <name@version ...>   all packages in scripts/publish-workspaces.txt are out
#   NOT PUBLISHED: <reason>        anything else; the step fails unless it was a dry run
#
# The version and npm dist-tag come from the tag name (#2244):
#   vX.Y.Z-next.N  ->  version X.Y.Z-next.N, --tag next
#   vX.Y.Z         ->  version X.Y.Z,        --tag latest
# set-release-version.sh writes that version into the packages (never committed), then
# publish-workspaces.sh dry-runs and publishes. A dry run on a non-tag ref uses the
# checked-out version.
# #2627: before the first dry-run the runner's npm must be at least NPM_MIN_VERSION (the
# first npm with trusted publishing, OIDC), else the run ends NOT PUBLISHED.
#
# Env:
#   PUBLISH_DRY_RUN=true   dry-run only (green, never publishes)
#   GITHUB_REF             must be refs/tags/v* for a real publish
#   PUBLISH_BLOCKERS       issue numbers that must be CLOSED before a real publish
#                          (default "195 151", the v1.0 blockers)
#   GITHUB_REPOSITORY      repo for the blocker lookups (gh issue view --repo)
#   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY   set by Actions; ignored when unset
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Minimum npm CLI for npm trusted publishing (#2627).
NPM_MIN_VERSION=11.5.1

# npm_version_ok <version>: 0 when <version> is at or above NPM_MIN_VERSION, 1 when older,
# 2 when it is not X.Y.Z[-pre]. A pre-release of the minimum itself is too old.
npm_version_ok() {
  local v="${1//$'\r'/}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-.*)?$ ]] || return 2
  local have=("$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[3]}))")
  local pre="${BASH_REMATCH[4]}"
  local want
  IFS=. read -r -a want <<<"$NPM_MIN_VERSION"
  local i
  for i in 0 1 2; do
    [ "${have[$i]}" -le "${want[$i]}" ] || return 0
    [ "${have[$i]}" -ge "${want[$i]}" ] || return 1
  done
  [ -z "$pre" ] || return 1
}

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

set_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "published=$1" >>"$GITHUB_OUTPUT"; fi
}

# not_published <reason> <exit code>
not_published() {
  summary "NOT PUBLISHED: $1"
  set_output false
  exit "$2"
}

dry_run=false
[ "${PUBLISH_DRY_RUN:-}" != "true" ] || dry_run=true

ref="${GITHUB_REF:-}"
case "$ref" in
  refs/tags/v*)
    tag="${ref#refs/tags/}"
    [[ "$tag" =~ ^v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-next\.(0|[1-9][0-9]*))?)$ ]] ||
      not_published "tag $tag does not parse as vX.Y.Z or vX.Y.Z-next.N" 1
    version="${BASH_REMATCH[1]}"
    bash scripts/set-release-version.sh "$version" || not_published "could not set the package versions to $version" 1
    ;;
  *)
    [ "$dry_run" = true ] || not_published "${ref:-no ref} is not a release tag (refs/tags/v*)" 1
    version="$(bash scripts/set-release-version.sh --current)" ||
      not_published "the packages are not at one version" 1
    ;;
esac
case "$version" in
  *-*) channel=next ;;
  *) channel=latest ;;
esac

npm_version="$(npm --version 2>/dev/null)" || npm_version=""
npm_version="${npm_version//$'\r'/}"
npm_version="${npm_version#"${npm_version%%[![:space:]]*}"}"
npm_version="${npm_version%"${npm_version##*[![:space:]]}"}"
rc=0
npm_version_ok "$npm_version" || rc=$?
[ "$rc" != 2 ] || not_published "could not read the npm version (got '${npm_version}')" 1
[ "$rc" = 0 ] || not_published "npm $npm_version is older than $NPM_MIN_VERSION, the minimum for npm trusted publishing (OIDC)" 1
echo "npm $npm_version >= $NPM_MIN_VERSION"

bash scripts/publish-workspaces.sh --tag "$channel" --dry-run || not_published "dry-run failed" 1
[ "$dry_run" = false ] || not_published "dry-run, not published" 0

open=""
for n in ${PUBLISH_BLOCKERS-195 151}; do
  state="$(gh issue view "$n" --repo "${GITHUB_REPOSITORY:-}" --json state -q .state)" ||
    not_published "could not read the state of blocker #$n" 1
  echo "issue #$n: $state"
  [ "$state" = "CLOSED" ] || open="$open #$n"
done
[ -z "$open" ] || not_published "v1.0 blockers still open:$open" 1

bash scripts/publish-workspaces.sh --tag "$channel" ||
  not_published "npm publish failed; packages before the failing one in scripts/publish-workspaces.txt may already be on the registry (a rerun skips them)" 1

published=""
while IFS= read -r name || [ -n "$name" ]; do
  name="${name//$'\r'/}"
  name="${name//[[:space:]]/}"
  [ -z "$name" ] || published="$published $name@$version"
done <scripts/publish-workspaces.txt

summary "PUBLISHED$published (--tag $channel)"
set_output true
