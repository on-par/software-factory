#!/usr/bin/env bash
# Guard for scripts/publish-workspaces.txt (#1560): the list must match the non-private
# workspaces, be in dependency order, be used by both consumers, and drive the publish loop.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BINDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

LIST="$ROOT/scripts/publish-workspaces.txt"
PUBLISH_YML="$ROOT/.github/workflows/publish.yml"
SMOKE="$ROOT/scripts/quickstart-smoke.sh"

# (a) set equality + (b) topological order
ROOT="$ROOT" node -e '
const fs = require("fs");
const path = require("path");
const root = process.env.ROOT;
const list = fs.readFileSync(path.join(root, "scripts/publish-workspaces.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);
const pkgs = {};
for (const d of fs.readdirSync(path.join(root, "packages"))) {
  const f = path.join(root, "packages", d, "package.json");
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  pkgs[j.name] = j;
}
const expected = Object.values(pkgs).filter((j) => j.private !== true).map((j) => j.name);
const missing = expected.filter((n) => !list.includes(n));
const extra = list.filter((n) => !expected.includes(n));
if (missing.length || extra.length || new Set(list).size !== list.length) {
  console.error("FAIL: list differs from non-private workspaces; missing=" + missing + " extra=" + extra);
  process.exit(1);
}
list.forEach((name, i) => {
  const j = pkgs[name];
  const deps = Object.keys({ ...j.dependencies, ...j.peerDependencies }).filter((d) => d.startsWith("@on-par/"));
  for (const d of deps) {
    if (list.indexOf(d) > i) {
      console.error("FAIL: " + name + " depends on " + d + " but is listed before it");
      process.exit(1);
    }
  }
});
'

# (c) consumers use the list
grep -q 'bash scripts/publish-workspaces.sh --dry-run' "$PUBLISH_YML" || fail "publish.yml lacks the dry-run step"
grep -qE 'bash scripts/publish-workspaces.sh$' "$PUBLISH_YML" || fail "publish.yml lacks the real publish step"
if grep -q -- '--workspace' "$PUBLISH_YML"; then fail "publish.yml hard-codes --workspace"; fi
grep -q 'publish-workspaces.txt' "$SMOKE" || fail "quickstart-smoke.sh does not read the list"
if grep -q -- '--workspace @on-par/' "$SMOKE"; then fail "quickstart-smoke.sh hard-codes workspaces"; fi

# (d) loop behavior with a stub npm
NPM_CALL_LOG="$BINDIR/npm-calls.log"
export NPM_CALL_LOG
cat >"$BINDIR/npm" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >>"$NPM_CALL_LOG"
case "${NPM_FAIL_ON:-}" in
  "") ;;
  *) case "$*" in *"$NPM_FAIL_ON"*) exit 1 ;; esac ;;
esac
exit 0
EOF2
chmod +x "$BINDIR/npm"
export PATH="$BINDIR:$PATH"

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  [ -n "${line// /}" ] && NAMES+=("$line")
done <"$LIST"

: >"$NPM_CALL_LOG"
bash "$ROOT/scripts/publish-workspaces.sh" --dry-run >/dev/null
[ "$(wc -l <"$NPM_CALL_LOG" | tr -d ' ')" = "${#NAMES[@]}" ] || fail "expected ${#NAMES[@]} npm calls"
i=0
while IFS= read -r call; do
  [ "$call" = "publish --workspace ${NAMES[$i]} --dry-run" ] || fail "call $i was '$call'"
  i=$((i + 1))
done <"$NPM_CALL_LOG"

: >"$NPM_CALL_LOG"
if NPM_FAIL_ON='@on-par/contracts' bash "$ROOT/scripts/publish-workspaces.sh" >/dev/null 2>&1; then
  fail "script should exit non-zero when npm publish fails"
fi
[ "$(wc -l <"$NPM_CALL_LOG" | tr -d ' ')" = "2" ] || fail "script did not stop at the first failure"

echo "publish-workspaces test OK"
