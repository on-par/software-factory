#!/usr/bin/env bash
# Publishes every non-private @on-par workspace, one `npm publish` per package, in the
# order listed in scripts/publish-workspaces.txt (#1560). The list is leaves-first so each
# package's @on-par/* dependencies are on the registry before it is. A single multi-
# --workspace call would use npm's own iteration order and leave a partial release with no
# clear stop point. The first failure aborts.
#
# usage: publish-workspaces.sh --tag <next|latest> [npm publish args, e.g. --dry-run]
#
# #2244: the packages must share one version (scripts/set-release-version.sh --current).
# A pre-release version (X.Y.Z-pre) must go to --tag next and a plain X.Y.Z to
# --tag latest; anything else fails before any publish. A package already on the
# registry at that version is skipped with a log line, so a half-finished run can be
# retried. Every other arg goes to every `npm publish` call.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || { echo "--tag needs a value (next or latest)" >&2; exit 2; }
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
case "$VERSION" in
  *-*) WANT=next ;;
  *) WANT=latest ;;
esac
if [ "$TAG" != "$WANT" ]; then
  echo "refusing to publish $VERSION with --tag '${TAG}': $VERSION must use --tag $WANT" >&2
  exit 1
fi

for name in "${NAMES[@]}"; do
  if [ "$(npm view "$name@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; then
    echo "skipping $name@$VERSION: already on the registry"
    continue
  fi
  echo "publishing $name@$VERSION (--tag $TAG)"
  npm publish --workspace "$name" --tag "$TAG" ${ARGS[@]+"${ARGS[@]}"}
done
