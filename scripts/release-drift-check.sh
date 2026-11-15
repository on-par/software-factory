#!/usr/bin/env bash
# Fails when npm `latest` and the GitHub Latest release disagree (#4123). Both values go
# to the job summary and stdout, and the run ends in one result line:
#   RELEASE IN SYNC v<x>                              exit 0
#   RELEASE DRIFT: npm latest <a> != GitHub latest <b>  exit 1
# A failed or empty lookup counts as `unavailable`. Registry and API reads can lag right
# after a publish, so the check retries before it fails.
#
# Env:
#   GITHUB_REPOSITORY   owner/name (required)
#   GH_TOKEN            token for gh
#   GITHUB_STEP_SUMMARY job summary file (optional)
#   DRIFT_PACKAGE       npm package to read (default @on-par/factory-cli)
#   DRIFT_ATTEMPTS      tries before failing (default 5)
#   DRIFT_SLEEP         seconds between tries (default 20)
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
package="${DRIFT_PACKAGE:-@on-par/factory-cli}"
attempts="${DRIFT_ATTEMPTS:-5}"
pause="${DRIFT_SLEEP:-20}"

trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

npm_latest=unavailable
gh_latest=unavailable
in_sync=false
n=1
while :; do
  npm_latest="$(npm view "$package" dist-tags.latest 2>/dev/null || true)"
  npm_latest="$(trim "$npm_latest")"
  [ -n "$npm_latest" ] || npm_latest=unavailable
  gh_latest="$(gh release view --repo "$GITHUB_REPOSITORY" --json tagName -q .tagName 2>/dev/null || true)"
  gh_latest="$(trim "$gh_latest")"
  [ -n "$gh_latest" ] || gh_latest=unavailable
  if [ "$npm_latest" != unavailable ] && [ "v$npm_latest" = "$gh_latest" ]; then
    in_sync=true
    break
  fi
  [ "$n" -lt "$attempts" ] || break
  n=$((n + 1))
  sleep "$pause"
done

if [ "$in_sync" = true ]; then
  result="RELEASE IN SYNC v$npm_latest"
else
  result="RELEASE DRIFT: npm latest $npm_latest != GitHub latest $gh_latest"
fi

lines="| npm dist-tags.latest | $npm_latest |
| GitHub latest release | $gh_latest |
$result"
echo "$lines"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$lines" >>"$GITHUB_STEP_SUMMARY"
fi
[ "$in_sync" = true ]
