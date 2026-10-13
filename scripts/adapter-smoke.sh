#!/usr/bin/env bash
# Adapter smoke test: installs the packed `factory` CLI the way a user would, builds a temp git
# repo from scripts/fixtures/smoke-repo/ whose config pins the given agent's recorded shim, and
# runs `factory doctor` on a PATH where claude cannot be found. Exits 0 only when doctor passes.
#
# `codex` and `opencode` are supported; command, the ship step and CI wiring are later slices. Assumes `npm ci` and `npm run build` have already run at the repo root.
set -euo pipefail

AGENT="${1:-}"
case "$AGENT" in
  codex | opencode) ;;
  *) echo "usage: $0 <codex|opencode>" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKDIR="$(mktemp -d)"
INSTALL_DIR="$(mktemp -d)"
REPO_DIR="$(mktemp -d)"
FAKEBIN="$(mktemp -d)"
CODEX_HOME_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$PACKDIR" "$INSTALL_DIR" "$REPO_DIR" "$FAKEBIN" "$CODEX_HOME_DIR"
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

cp -R "$ROOT/scripts/fixtures/smoke-repo/." "$REPO_DIR/"
cd "$REPO_DIR"
git init -q
git config user.name "Adapter Smoke"
git config user.email smoke@example.invalid
"$FACTORY" init >/dev/null
bash "$ROOT/scripts/fixtures/smoke-repo/render-config.sh" "$AGENT" >.factory/config.yaml
git add -A
git commit -q -m "smoke-repo fixture"

# The agent entry is a wrapper, not a symlink: the shim resolves its fixtures from dirname "$0".
printf '#!/bin/sh\nexec "%s" "$@"\n' "$ROOT/scripts/fixtures/agents/bin/$AGENT" >"$FAKEBIN/$AGENT"
chmod +x "$FAKEBIN/$AGENT"
cat >"$FAKEBIN/gh" <<'FAKE'
#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "auth token") echo "smoke-dummy-token"; exit 0 ;;
esac
exit 1
FAKE
chmod +x "$FAKEBIN/gh"
ln -s "$(command -v node)" "$FAKEBIN/node"
ln -s "$(command -v git)" "$FAKEBIN/git"
AGENT_PATH="$FAKEBIN"
IFS=: read -r -a PATH_DIRS <<<"$PATH"
for dir in "${PATH_DIRS[@]}"; do
  [ -x "$dir/claude" ] || [ -x "$dir/codex" ] || [ -x "$dir/opencode" ] || AGENT_PATH="$AGENT_PATH:$dir"
done
echo "$AGENT PATH: $AGENT_PATH"

CLAUDE_EXIT=0
CLAUDE_OUT="$(PATH="$AGENT_PATH" command -v claude)" || CLAUDE_EXIT=$?
if [ -n "$CLAUDE_OUT" ] || [ "$CLAUDE_EXIT" -eq 0 ]; then
  echo "expected claude to be unreachable on the $AGENT PATH, got '$CLAUDE_OUT' (exit $CLAUDE_EXIT)" >&2
  exit 1
fi
echo "claude not reachable on $AGENT PATH: OK"

# FAKE_AGENT_MODE=empty keeps the shim from committing into the repo when doctor probes the agent.
# The env key is the sign-in evidence, so the signed-in row passes without reading stored logins.
case "$AGENT" in
  codex) AGENT_ENV=(CODEX_HOME="$CODEX_HOME_DIR" CODEX_API_KEY=smoke-dummy-key) ;;
  opencode) AGENT_ENV=(OPENCODE_API_KEY=smoke-dummy-key) ;;
esac
DOCTOR_EXIT=0
DOCTOR_OUT="$(env PATH="$AGENT_PATH" "${AGENT_ENV[@]}" FAKE_AGENT_MODE=empty "$FACTORY" doctor 2>&1)" || DOCTOR_EXIT=$?
echo "$DOCTOR_OUT"
if [ "$DOCTOR_EXIT" -ne 0 ]; then
  echo "expected factory doctor to exit 0 on the $AGENT PATH, got exit $DOCTOR_EXIT" >&2
  exit 1
fi
echo "$DOCTOR_OUT" | grep -q "coding agent.*found $AGENT" || {
  echo "expected doctor to find $AGENT as the coding agent" >&2
  exit 1
}
if echo "$DOCTOR_OUT" | grep -i "claude" | grep -q "❌"; then
  echo "expected doctor to report no failing claude row" >&2
  exit 1
fi

echo "adapter smoke $AGENT OK"
