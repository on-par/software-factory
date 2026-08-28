#!/usr/bin/env bash
# Guard (#795): oxlint's JS plugin API is alpha and explicitly not subject to semver, so
# @oxlint/plugins must track oxlint release-for-release. A silent version drift between the
# two would change rule-visitor behaviour with no diff to point at, so fail the build instead.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules/oxlint ] || [ ! -d node_modules/@oxlint/plugins ]; then
  echo "check-oxlint-plugin-version: node_modules/oxlint or node_modules/@oxlint/plugins is missing." >&2
  echo "Run 'npm ci' first." >&2
  exit 1
fi

oxlint_version="$(node -p "require('./node_modules/oxlint/package.json').version")"
plugins_version="$(node -p "require('./node_modules/@oxlint/plugins/package.json').version")"

if [ "$oxlint_version" != "$plugins_version" ]; then
  echo "check-oxlint-plugin-version: oxlint ($oxlint_version) and @oxlint/plugins ($plugins_version) versions have drifted apart (#795)." >&2
  echo "Bump both together — see tools/oxlint/anti-slop/VENDORED.md." >&2
  exit 1
fi

echo "check-oxlint-plugin-version: OK — oxlint and @oxlint/plugins both at $oxlint_version"
