#!/usr/bin/env bash
# Fails when npm `latest` of any package in scripts/publish-workspaces.txt and the GitHub
# Latest release disagree (#4123). Every value goes to the job summary and stdout, and the
# run ends in one result line:
#   RELEASE IN SYNC v<x>                                            exit 0
#   RELEASE DRIFT: npm latest != GitHub latest <b> for <name@a ...>  exit 1
# A failed or empty lookup counts as `unavailable`. Registry and API reads can lag right
# after a publish, so the check retries for about 10 minutes before it fails.
#
# Env:
#   GITHUB_REPOSITORY   owner/name (required)
#   GH_TOKEN            token for gh
#   GITHUB_STEP_SUMMARY job summary file (optional)
#   DRIFT_ATTEMPTS      tries before failing (default 30)
#   DRIFT_SLEEP         seconds between tries (default 20)
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
attempts="${DRIFT_ATTEMPTS:-30}"
pause="${DRIFT_SLEEP:-20}"

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  line="${line//[[:space:]]/}"
  [ -z "$line" ] || NAMES+=("$line")
done <"$(dirname "$0")/publish-workspaces.txt"
[ "${#NAMES[@]}" -gt 0 ] || { echo "scripts/publish-workspaces.txt is empty" >&2; exit 1; }

lookup() {
  local v
  v="$("$@" 2>/dev/null || true)"
  v="${v//[[:space:]]/}"
  printf '%s' "${v:-unavailable}"
}

in_sync=false
n=1
while :; do
  gh_latest="$(lookup gh release view --repo "$GITHUB_REPOSITORY" --json tagName -q .tagName)"
  rows=""
  behind=""
  for name in "${NAMES[@]}"; do
    npm_latest="$(lookup npm view "$name" dist-tags.latest)"
    rows="$rows| $name dist-tags.latest | $npm_latest |"$'\n'
    if [ "$npm_latest" = unavailable ] || [ "v$npm_latest" != "$gh_latest" ]; then
      behind="$behind $name@$npm_latest"
    fi
  done
  if [ "$gh_latest" != unavailable ] && [ -z "$behind" ]; then
    in_sync=true
    break
  fi
  [ "$n" -lt "$attempts" ] || break
  n=$((n + 1))
  sleep "$pause"
done

if [ "$in_sync" = true ]; then
  result="RELEASE IN SYNC $gh_latest"
else
  result="RELEASE DRIFT: npm latest != GitHub latest $gh_latest for$behind"
fi

lines="$rows| GitHub latest release | $gh_latest |
$result"
echo "$lines"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$lines" >>"$GITHUB_STEP_SUMMARY"
fi
[ "$in_sync" = true ]
