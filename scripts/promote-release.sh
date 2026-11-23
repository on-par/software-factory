#!/usr/bin/env bash
# Runs the promote job of publish.yml: proves the staged release installs, then moves the
# final dist-tag. Every path ends with one job-summary line:
#   PROMOTED <name@version ...> to <latest|next>   exit 0
#   NOT PROMOTED: <reason>                         exit 1
# The install check runs `npm install -g @on-par/factory-cli@<v>` and `factory --version`
# in a clean container (`docker run --rm PROMOTE_IMAGE`) and needs it to print <v>. It
# retries, since the registry can lag a fresh publish; if it never passes no dist-tag
# moves. Then every package in scripts/publish-workspaces.txt gets
# `npm dist-tag add <name>@<v> <tag>`: `next` for X.Y.Z-next.N, `latest` for X.Y.Z. The
# dist-tag calls use the job's npm trusted publishing (OIDC), like the publish step.
#
# Env:
#   PROMOTE_VERSION           the version publish-release.sh published (required)
#   PROMOTE_IMAGE             clean container image (default node:24-slim)
#   PROMOTE_INSTALL_ATTEMPTS  install tries before failing (default 10)
#   PROMOTE_INSTALL_SLEEP     seconds between tries (default 30)
#   GITHUB_STEP_SUMMARY       job summary file (optional)
set -euo pipefail
cd "$(dirname "$0")/.."

version="${PROMOTE_VERSION:-}"
image="${PROMOTE_IMAGE:-node:24-slim}"
attempts="${PROMOTE_INSTALL_ATTEMPTS:-10}"
pause="${PROMOTE_INSTALL_SLEEP:-30}"

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

not_promoted() {
  summary "NOT PROMOTED: $1"
  exit 1
}

[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-next\.(0|[1-9][0-9]*))?$ ]] ||
  not_promoted "PROMOTE_VERSION '${version}' is not X.Y.Z or X.Y.Z-next.N"
case "$version" in
  *-*) tag=next ;;
  *) tag=latest ;;
esac
cli="@on-par/factory-cli@$version"

installed=false
n=1
while :; do
  echo "install check $n of $attempts: $cli in a clean $image container"
  out="$(docker run --rm "$image" sh -c 'npm install -g --no-fund --no-audit "$1" >&2 && factory --version' sh "$cli")" || out=""
  out="${out//[[:space:]]/}"
  if [ "$out" = "$version" ]; then
    installed=true
    break
  fi
  echo "factory --version printed '${out}', want $version"
  [ "$n" -lt "$attempts" ] || break
  n=$((n + 1))
  sleep "$pause"
done
[ "$installed" = true ] ||
  not_promoted "$cli did not install and print $version in a clean $image container after $attempts tries; $tag is unchanged"

moved=""
while IFS= read -r name || [ -n "$name" ]; do
  name="${name//$'\r'/}"
  name="${name//[[:space:]]/}"
  [ -n "$name" ] || continue
  npm dist-tag add "$name@$version" "$tag" ||
    not_promoted "npm dist-tag add $name@$version $tag failed; moved so far:${moved:- none}"
  moved="$moved $name@$version"
done <scripts/publish-workspaces.txt

summary "PROMOTED$moved to $tag"
