#!/usr/bin/env bash
# Publishes every non-private @on-par workspace, one `npm publish` per package, in the
# order listed in scripts/publish-workspaces.txt (#1560). The list is leaves-first so each
# package's @on-par/* dependencies are on the registry before it is. A single multi-
# --workspace call would use npm's own iteration order and leave a partial release with no
# clear stop point. The first failure aborts.
#
# usage: publish-workspaces.sh --tag staging [npm publish args, e.g. --dry-run]
#
# #2244: the packages must share one version (scripts/set-release-version.sh --current).
# Everything publishes under the `staging` dist-tag; promote-release.sh moves latest/next
# after a fresh-container install, so any other --tag fails before any publish. A package
# already on the registry at that version is skipped with a log line, and a "cannot
# publish over" (E403/E409) answer counts as published, so a half-finished run can be
# retried. Every other arg goes to every `npm publish` call.
# @on-par/factory-core publishes first. The rest publish only once
# `npm view @on-par/factory-core@<v> version` resolves: it is polled every
# PUBLISH_CORE_INTERVAL seconds (default 20) for PUBLISH_CORE_TIMEOUT seconds (default
# 600), then republished, up to PUBLISH_CORE_REPUBLISH times (default 3). If it never
# resolves the script exits 3 and publishes nothing else. A --dry-run does not wait.
# #2627: every publish passes `--provenance`, which needs a CI provider with OIDC
# (publish.yml grants `id-token: write`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || { echo "--tag needs a value (staging)" >&2; exit 2; }
      TAG="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] && NAMES+=("$line")
done <"$ROOT/scripts/publish-workspaces.txt"

if [ "${#NAMES[@]}" -eq 0 ]; then
  echo "scripts/publish-workspaces.txt is empty" >&2
  exit 1
fi

VERSION="$(bash "$ROOT/scripts/set-release-version.sh" --current)"
if [ "$TAG" != staging ]; then
  echo "refusing to publish $VERSION with --tag '${TAG}': publish to --tag staging; promote-release.sh moves latest/next" >&2
  exit 1
fi

CORE=@on-par/factory-core
case " ${NAMES[*]} " in
  *" $CORE "*) ;;
  *) echo "$CORE is not in scripts/publish-workspaces.txt" >&2; exit 1 ;;
esac
TIMEOUT="${PUBLISH_CORE_TIMEOUT:-600}"
INTERVAL="${PUBLISH_CORE_INTERVAL:-20}"
REPUBLISH="${PUBLISH_CORE_REPUBLISH:-3}"
[ "$INTERVAL" -gt 0 ] || { echo "PUBLISH_CORE_INTERVAL must be above 0" >&2; exit 1; }
DRY_RUN=false
for arg in ${ARGS[@]+"${ARGS[@]}"}; do
  [ "$arg" != --dry-run ] || DRY_RUN=true
done

on_registry() {
  [ "$(npm view "$1@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]
}

publish() {
  local out rc=0
  echo "publishing $1@$VERSION (--tag $TAG)"
  out="$(npm publish --workspace "$1" --tag "$TAG" --provenance ${ARGS[@]+"${ARGS[@]}"} 2>&1)" || rc=$?
  [ -z "$out" ] || echo "$out"
  [ "$rc" != 0 ] || return 0
  if grep -qE 'E40[39]' <<<"$out" && grep -qi 'cannot publish over' <<<"$out"; then
    echo "$1@$VERSION is already published"
    return 0
  fi
  return 1
}

publish_unless_present() {
  if on_registry "$1"; then
    echo "skipping $1@$VERSION: already on the registry"
    return 0
  fi
  publish "$1"
}

wait_for_core() {
  local tries=0 waited
  while :; do
    waited=0
    while :; do
      if on_registry "$CORE"; then
        echo "$CORE@$VERSION resolves on the registry"
        return 0
      fi
      [ "$waited" -lt "$TIMEOUT" ] || break
      sleep "$INTERVAL"
      waited=$((waited + INTERVAL))
    done
    if [ "$tries" -ge "$REPUBLISH" ]; then
      echo "$CORE@$VERSION never resolved on the registry after $REPUBLISH republishes; nothing else was published" >&2
      exit 3
    fi
    tries=$((tries + 1))
    echo "$CORE@$VERSION still missing after ${TIMEOUT}s; republish $tries of $REPUBLISH"
    publish "$CORE" || exit 1
  done
}

publish_unless_present "$CORE" || exit 1
if [ "$DRY_RUN" = true ]; then
  echo "dry run: not waiting for $CORE@$VERSION to resolve"
else
  wait_for_core
fi
for name in "${NAMES[@]}"; do
  [ "$name" != "$CORE" ] || continue
  publish_unless_present "$name" || exit 1
done
