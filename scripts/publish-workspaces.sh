#!/usr/bin/env bash
# Publishes every non-private @on-par workspace, one `npm publish` per package, in the
# order listed in scripts/publish-workspaces.txt (#1560). The list is leaves-first so each
# package's @on-par/* dependencies are on the registry before it is. A single multi-
# --workspace call would use npm's own iteration order and leave a partial release with no
# clear stop point. The first failure aborts. Extra args (e.g. --dry-run) go to every call.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

for name in "${NAMES[@]}"; do
  echo "publishing $name"
  npm publish --workspace "$name" "$@"
done
