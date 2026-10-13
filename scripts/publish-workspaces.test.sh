#!/usr/bin/env bash
# Guard for scripts/publish-workspaces.txt (#1560): the list must match the non-private
# workspaces, be in dependency order, be used by both consumers, and drive the publish loop.
# #2244: the loop takes --tag next|latest, refuses the wrong channel for the version, and
# skips packages already on the registry so a half-finished run can be retried.
# #2627: every publish passes --provenance, and publish.yml grants id-token: write and is the
# only publish workflow.
# #2630: no workflow passes NPM_TOKEN / NODE_AUTH_TOKEN; npm authenticates via OIDC.
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
grep -qE 'run: bash scripts/publish-release.sh$' "$PUBLISH_YML" || fail "publish.yml lacks the publish step"
perm_line="$(grep -E '^ *permissions:' "$PUBLISH_YML" | head -n 1)"
for scope in 'contents: read' 'issues: read' 'id-token: write'; do
  grep -q -- "$scope" <<<"$perm_line" || fail "publish.yml permissions lack $scope"
done
OIDC_COMMENT='# #2630: no NODE_AUTH_TOKEN is passed, so npm must authenticate via OIDC.'
publish_step="$(awk '/- name: Publish to npm/{on=1;print;next} on&&/^      - /{on=0} on' "$PUBLISH_YML")"
if grep -qE 'NODE_AUTH_TOKEN|NPM_TOKEN' <<<"$publish_step"; then fail "publish.yml's Publish to npm step sets NODE_AUTH_TOKEN"; fi
grep -qF -- "$OIDC_COMMENT" "$PUBLISH_YML" || fail "publish.yml lacks the #2630 OIDC comment"
token_refs="$(grep -rnE 'NPM_TOKEN|NODE_AUTH_TOKEN' "$ROOT/.github/workflows" | grep -vF -- "$OIDC_COMMENT" || true)"
[ -z "$token_refs" ] || fail ".github/workflows references NPM_TOKEN or NODE_AUTH_TOKEN: $token_refs"
[ "$(ls "$ROOT/.github/workflows" | grep -i publish)" = "publish.yml" ] || fail "publish workflow is not only publish.yml"
grep -qE '^ *npm publish .*--provenance' "$ROOT/scripts/publish-workspaces.sh" || fail "publish-workspaces.sh does not pass --provenance"
grep -qE '^bash scripts/publish-workspaces.sh --tag "\$channel" --dry-run ' "$ROOT/scripts/publish-release.sh" || fail "publish-release.sh lacks the dry-run"
grep -qE '^bash scripts/publish-workspaces.sh --tag "\$channel" \|\|' "$ROOT/scripts/publish-release.sh" || fail "publish-release.sh does not run the publish loop"
if grep -q -- '--workspace' "$PUBLISH_YML"; then fail "publish.yml hard-codes --workspace"; fi
# publish.yml's Quickstart smoke step gets a GitHub token, like ci.yml's job does.
smoke_step="$(awk '/- name: Quickstart smoke/{on=1;print;next} on&&/^      - /{on=0} on' "$PUBLISH_YML")"
grep -q 'run: bash scripts/quickstart-smoke.sh' <<<"$smoke_step" || fail "publish.yml's Quickstart smoke step does not run quickstart-smoke.sh"
grep -q "GH_TOKEN: '\${{ github.token }}'" <<<"$smoke_step" || fail "publish.yml's Quickstart smoke step has no GH_TOKEN"
grep -q 'publish-workspaces.txt' "$SMOKE" || fail "quickstart-smoke.sh does not read the list"
if grep -q -- '--workspace @on-par/' "$SMOKE"; then fail "quickstart-smoke.sh hard-codes workspaces"; fi

# (d) loop behavior with a stub npm, in a scratch copy of the publish files so version
# changes never touch the checkout.
REPO="$BINDIR/repo"
mkdir -p "$REPO/scripts"
cp "$ROOT/scripts/publish-workspaces.sh" "$ROOT/scripts/set-release-version.sh" "$LIST" "$REPO/scripts/"
for f in "$ROOT"/packages/*/package.json; do
  d="$(basename "$(dirname "$f")")"
  mkdir -p "$REPO/packages/$d"
  cp "$f" "$REPO/packages/$d/package.json"
done
PUBLISH="$REPO/scripts/publish-workspaces.sh"

# Stub npm: logs every call; `npm view <name>@<v> version` prints <v> when <name> is in
# NPM_ON_REGISTRY (faked registry); NPM_FAIL_ON fails any call mentioning it.
NPM_CALL_LOG="$BINDIR/npm-calls.log"
export NPM_CALL_LOG
cat >"$BINDIR/npm" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >>"$NPM_CALL_LOG"
case "${NPM_FAIL_ON:-}" in
  "") ;;
  *) case "$*" in *"$NPM_FAIL_ON"*) exit 1 ;; esac ;;
esac
if [ "$1" = view ]; then
  name="${2%@*}"
  case " ${NPM_ON_REGISTRY:-} " in *" $name "*) echo "${2##*@}"; exit 0 ;; esac
  echo "npm error 404 Not Found - GET $name" >&2
  exit 1
fi
exit 0
EOF2
chmod +x "$BINDIR/npm"
export PATH="$BINDIR:$PATH"

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  [ -n "${line// /}" ] && NAMES+=("$line")
done <"$LIST"
VERSION="$(bash "$REPO/scripts/set-release-version.sh" --current)"
case "$VERSION" in *-*) fail "checked-in version $VERSION is a pre-release" ;; esac

publish_calls() {
  grep '^publish ' "$NPM_CALL_LOG" || true
}
expect_no_npm() {
  [ ! -s "$NPM_CALL_LOG" ] || fail "$1: npm was called: $(cat "$NPM_CALL_LOG")"
}

# Stable version: --tag latest, one registry check then one publish per package.
: >"$NPM_CALL_LOG"
bash "$PUBLISH" --tag latest --dry-run >/dev/null
[ "$(wc -l <"$NPM_CALL_LOG" | tr -d ' ')" = "$((2 * ${#NAMES[@]}))" ] || fail "expected $((2 * ${#NAMES[@]})) npm calls"
i=0
while IFS= read -r call; do
  name="${NAMES[$((i / 2))]}"
  if [ $((i % 2)) -eq 0 ]; then
    [ "$call" = "view $name@$VERSION version" ] || fail "call $i was '$call'"
  else
    [ "$call" = "publish --workspace $name --tag latest --provenance --dry-run" ] || fail "call $i was '$call'"
  fi
  i=$((i + 1))
done <"$NPM_CALL_LOG"

# Wrong channel, missing or empty --tag: refused before any npm call.
for args in "--tag next" "" "--tag beta" "--dry-run"; do
  : >"$NPM_CALL_LOG"
  # shellcheck disable=SC2086
  if bash "$PUBLISH" $args >/dev/null 2>&1; then fail "stable $VERSION published with '$args'"; fi
  expect_no_npm "stable with '$args'"
done
: >"$NPM_CALL_LOG"
set +e
bash "$PUBLISH" --dry-run --tag >/dev/null 2>"$BINDIR/err.txt"
rc=$?
set -e
[ "$rc" = 2 ] && grep -q -- '--tag needs a value' "$BINDIR/err.txt" || fail "--tag without a value: rc=$rc"
expect_no_npm "--tag without a value"

# The first publish failure aborts.
: >"$NPM_CALL_LOG"
if NPM_FAIL_ON='publish --workspace @on-par/contracts' bash "$PUBLISH" --tag latest >/dev/null 2>&1; then
  fail "script should exit non-zero when npm publish fails"
fi
[ "$(publish_calls | wc -l | tr -d ' ')" = "2" ] || fail "script did not stop at the first failure"

# Retry: packages 1-3 already on the (faked) registry are skipped with a log line; 4-7 publish.
: >"$NPM_CALL_LOG"
out="$(NPM_ON_REGISTRY="${NAMES[0]} ${NAMES[1]} ${NAMES[2]}" bash "$PUBLISH" --tag latest)"
for n in 0 1 2; do
  grep -qx "skipping ${NAMES[$n]}@$VERSION: already on the registry" <<<"$out" || fail "no skip line for ${NAMES[$n]}"
done
want=""
for n in 3 4 5 6; do want="${want}publish --workspace ${NAMES[$n]} --tag latest --provenance"$'\n'; done
[ "$(publish_calls)" = "${want%$'\n'}" ] || fail "retry published: $(publish_calls)"

# Pre-release: --tag next publishes with the exact version; --tag latest is refused.
bash "$REPO/scripts/set-release-version.sh" 0.9.0-next.3 >/dev/null
: >"$NPM_CALL_LOG"
if bash "$PUBLISH" --tag latest --dry-run >/dev/null 2>"$BINDIR/err.txt"; then fail "pre-release published to latest"; fi
grep -q "0.9.0-next.3 must use --tag next" "$BINDIR/err.txt" || fail "wrong-channel message: $(cat "$BINDIR/err.txt")"
expect_no_npm "pre-release with --tag latest"
: >"$NPM_CALL_LOG"
bash "$PUBLISH" --tag next --dry-run >/dev/null
[ "$(publish_calls | grep -c -- '--tag next --provenance --dry-run$')" = "${#NAMES[@]}" ] || fail "pre-release did not use --tag next: $(publish_calls)"
[ "$(grep -c '^view .*@0.9.0-next.3 version$' "$NPM_CALL_LOG")" = "${#NAMES[@]}" ] || fail "pre-release registry checks: $(cat "$NPM_CALL_LOG")"

# Lockstep drift: refused before any npm call.
node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version="0.9.1";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$REPO/packages/tui/package.json"
: >"$NPM_CALL_LOG"
if bash "$PUBLISH" --tag next --dry-run >/dev/null 2>&1; then fail "published packages out of lockstep"; fi
expect_no_npm "lockstep drift"

# An empty list is an error.
: >"$REPO/scripts/publish-workspaces.txt"
if bash "$PUBLISH" --tag latest >/dev/null 2>&1; then fail "empty list should fail"; fi

echo "publish-workspaces test OK"
