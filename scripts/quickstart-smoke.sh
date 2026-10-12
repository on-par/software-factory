#!/usr/bin/env bash
# Quickstart smoke test: packs the workspaces named in scripts/publish-workspaces.txt (the
# same list publish.yml publishes) into tarballs, checks each tarball's file list
# (scripts/pack-hygiene.ts: README, LICENSE, dist/ only, no test files), installs them into a
# fresh project (as npm would from the registry), and verifies
# `factory --version`, `factory --help`, and `factory init` work.
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

WS_ARGS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] && WS_ARGS+=(--workspace "$line")
done <"$ROOT/scripts/publish-workspaces.txt"

# Lifecycle banners (prepack) go to stderr, so stdout is the pack JSON alone.
(cd "$ROOT" && npm pack "${WS_ARGS[@]}" --json --pack-destination "$PACKDIR") >"$PACKDIR/pack.json"
node "$ROOT/scripts/pack-hygiene-cli.ts" verify "$PACKDIR/pack.json" "$ROOT/scripts/publish-workspaces.txt"

ADR_KIT_TGZ=("$PACKDIR"/on-par-adr-kit-*.tgz)
CONTRACTS_TGZ=("$PACKDIR"/on-par-contracts-*.tgz)
REPO_CONTEXT_TGZ=("$PACKDIR"/on-par-repo-context-*.tgz)
CONFIG_TGZ=("$PACKDIR"/on-par-factory-config-*.tgz)
CORE_TGZ=("$PACKDIR"/on-par-factory-core-*.tgz)
TUI_TGZ=("$PACKDIR"/on-par-factory-tui-*.tgz)
CLI_TGZ=("$PACKDIR"/on-par-factory-cli-*.tgz)

cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install \
  "${ADR_KIT_TGZ[@]}" "${CONTRACTS_TGZ[@]}" "${REPO_CONTEXT_TGZ[@]}" \
  "${CONFIG_TGZ[@]}" "${CORE_TGZ[@]}" "${TUI_TGZ[@]}" "${CLI_TGZ[@]}"

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
# #724 split the layout: durable config lives at the .factory/ root, runtime state
# under .factory/state/. Pin both halves so a regression in either is caught here.
test -f .factory/config.yaml
test -d .factory/state/
test -f .factory/state/queue
grep -q "^\.factory/$" .git/info/exclude

# Codex-only machine (#2406): with a fake signed-in codex CLI and no claude on PATH, doctor must
# pass the coding agent prerequisite and report the ChatGPT sign-in.
FAKEBIN="$(mktemp -d)"
cat >"$FAKEBIN/codex" <<'FAKE'
#!/bin/sh
if [ "$1 $2" = "login status" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
exit 1
FAKE
chmod +x "$FAKEBIN/codex"
NO_CLAUDE_PATH="$FAKEBIN"
IFS=: read -r -a PATH_DIRS <<<"$PATH"
for dir in "${PATH_DIRS[@]}"; do
  [ -x "$dir/claude" ] || [ -x "$dir/opencode" ] || NO_CLAUDE_PATH="$NO_CLAUDE_PATH:$dir"
done
DOCTOR_OUT="$(PATH="$NO_CLAUDE_PATH" "$FACTORY" doctor 2>&1 || true)"
rm -rf "$FAKEBIN"
echo "$DOCTOR_OUT" | grep -q "coding agent.*found codex" || {
  echo "expected doctor to accept a codex-only machine, got:" >&2
  echo "$DOCTOR_OUT" >&2
  exit 1
}
echo "$DOCTOR_OUT" | grep -q "codex signed in.*ChatGPT" || {
  echo "expected doctor to report the codex ChatGPT sign-in, got:" >&2
  echo "$DOCTOR_OUT" >&2
  exit 1
}

echo "quickstart smoke OK"
