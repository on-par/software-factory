#!/usr/bin/env bash
# Packs every package in scripts/publish-workspaces.txt into <dest> as it stands in the working tree
# (publish-release.sh has already written the release version). publish.yml uploads the tarballs and
# the factory-job image installs them, so the image never waits for npm to show a fresh publish.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: pack-release-tarballs.sh <dest>}"
mkdir -p "$DEST"
while IFS= read -r name || [ -n "$name" ]; do
  name="${name//$'\r'/}"
  [ -n "$name" ] && (cd "$ROOT" && npm pack --workspace "$name" --pack-destination "$DEST" >/dev/null)
done <"$ROOT/scripts/publish-workspaces.txt"
want="$(grep -c . "$ROOT/scripts/publish-workspaces.txt")"
got="$(find "$DEST" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')"
[ "$got" = "$want" ] || { echo "packed $got tarballs, want $want" >&2; exit 1; }
ls -l "$DEST"
