#!/usr/bin/env bash
# Tests scripts/release-prior-ci.sh with a stub `gh` on PATH: only a tag whose tree equals a merged
# PR head with a successful CI run is verified; every other case, API errors included, is
# verified=false, and the script always exits 0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$WORK/bin"
# Stub gh: answers come from STUB_* env vars; STUB_FAIL names a call that must fail.
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"/pulls"*) [ "${STUB_FAIL:-}" = pulls ] && exit 1; echo "$STUB_PR" ;;
  *"commits/tagsha "*|*"commits/tagsha") [ "${STUB_FAIL:-}" = tagtree ] && exit 1; echo "$STUB_TAG_TREE" ;;
  *"commits/headsha"*) [ "${STUB_FAIL:-}" = headtree ] && exit 1; echo "$STUB_HEAD_TREE" ;;
  "run list"*) [ "${STUB_FAIL:-}" = runs ] && exit 1; echo "$STUB_CI" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/gh"

# check <name> <want> [VAR=value ...]: run the script with the defaults plus overrides.
check() {
  local name="$1" want="$2"
  shift 2
  local output="$WORK/out" got
  : >"$output"
  got="$(env PATH="$WORK/bin:$PATH" SHA=tagsha REPO=on-par/x GITHUB_OUTPUT="$output" \
    STUB_PR="7 headsha" STUB_TAG_TREE=tree1 STUB_HEAD_TREE=tree1 STUB_CI=true STUB_FAIL= \
    "$@" bash "$ROOT/scripts/release-prior-ci.sh")" || fail "$name: script exited non-zero"
  grep -qx "verified=$want" <<<"$got" || fail "$name: want verified=$want, got: $got"
  grep -qx "verified=$want" "$output" || fail "$name: GITHUB_OUTPUT missing verified=$want"
  echo "PASS: $name"
}

check "same tree as a merged PR head with green CI" true
check "no merged PR" false STUB_PR="null null"
check "tree differs from the PR head" false STUB_HEAD_TREE=tree2
check "PR head CI not green" false STUB_CI=false
check "pulls API error" false STUB_FAIL=pulls
check "tag tree API error" false STUB_FAIL=tagtree
check "head tree API error" false STUB_FAIL=headtree
check "run list error" false STUB_FAIL=runs
check "missing SHA" false SHA=
