#!/usr/bin/env bash
# Quickstart smoke test: packs @on-par/factory-{config,core,cli} into tarballs,
# installs them into a fresh project (as npm would from the registry), and
# verifies `factory --version`, `factory --help`, and `factory init` work.
#
# Assumes `npm ci` and `npm run build` have already run at the repo root
# (CI does this before invoking this script).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKDIR="$(mktemp -d)"
INSTALL_DIR="$(mktemp -d)"
WORKDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$PACKDIR" "$INSTALL_DIR" "$WORKDIR"
}
trap cleanup EXIT

(cd "$ROOT" && npm pack \
  --workspace @on-par/factory-config \
  --workspace @on-par/factory-core \
  --workspace @on-par/factory-cli \
  --pack-destination "$PACKDIR")

CONFIG_TGZ=("$PACKDIR"/on-par-factory-config-*.tgz)
CORE_TGZ=("$PACKDIR"/on-par-factory-core-*.tgz)
CLI_TGZ=("$PACKDIR"/on-par-factory-cli-*.tgz)

cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install "${CONFIG_TGZ[@]}" "${CORE_TGZ[@]}" "${CLI_TGZ[@]}"

FACTORY="$INSTALL_DIR/node_modules/.bin/factory"

EXPECTED_VERSION="$(node -p "require('$ROOT/packages/cli/package.json').version")"
ACTUAL_VERSION="$("$FACTORY" --version)"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "expected factory --version to print $EXPECTED_VERSION, got $ACTUAL_VERSION" >&2
  exit 1
fi

"$FACTORY" --help | grep -q "Prerequisites"

cd "$WORKDIR"
git init -q
"$FACTORY" init

test -d .factory/
test -f .factory/queue
grep -q "^\.factory/$" .git/info/exclude

echo "quickstart smoke OK"
