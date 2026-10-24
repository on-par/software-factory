#!/usr/bin/env bash
# Test for the loopback-bind probe in scripts/verify.sh (#3332), using stub `node` and `npm`
# executables on PATH so no real install or bind happens.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MARKER='verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)'

mkdir -p "$TMP/bin"
cat >"$TMP/bin/npm" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >>"$TMP/npm-calls"
exit "${NPM_EXIT:-0}"
EOF2
chmod +x "$TMP/bin/npm"
export TMP

write_node() {
  cat >"$TMP/bin/node" <<EOF2
#!/usr/bin/env bash
case "\$1" in
  *verify-env-probe.mjs) exit $1 ;;
esac
exit 0
EOF2
  chmod +x "$TMP/bin/node"
}

# Case 1: the probe reports EPERM -> marker, exit 78, no npm step.
write_node 78
status=0
out="$(PATH="$TMP/bin:$PATH" bash "$ROOT/scripts/verify.sh" --no-e2e 2>&1)" || status=$?
[ "$status" = "78" ] || { echo "expected exit 78, got $status" >&2; exit 1; }
case "$out" in *"$MARKER"*) ;; *) echo "marker missing from output" >&2; exit 1 ;; esac
if [ -s "$TMP/npm-calls" ]; then echo "npm was called after the probe failed" >&2; exit 1; fi

# Case 2: the probe passes -> no marker, verify.sh falls through to npm.
write_node 0
status=0
out="$(NPM_EXIT=1 PATH="$TMP/bin:$PATH" bash "$ROOT/scripts/verify.sh" --no-e2e 2>&1)" || status=$?
[ "$status" != "0" ] || { echo "expected the stub npm failure to fail verify.sh" >&2; exit 1; }
case "$out" in *"$MARKER"*) echo "marker printed although the probe passed" >&2; exit 1 ;; esac
[ -s "$TMP/npm-calls" ] || { echo "npm was not called after the probe passed" >&2; exit 1; }

echo "verify-env-probe.test.sh: ok"
