#!/usr/bin/env bash
# Regression test for scripts/factory-run.sh, .github/workflows/factory-run.yml and the
# runbook's example caller (#3197). Uses a fake `factory` shim; needs no npm install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$(mktemp -d)"
cleanup() { rm -rf "$BINDIR"; }
trap cleanup EXIT

WF="$ROOT/.github/workflows/factory-run.yml"
RUNBOOK="$ROOT/docs/runbooks/github-actions-run.md"
SHIM_LOG="$BINDIR/shim.log"
RUN_LOG="$BINDIR/run.log"
SENTINELS=(sentinel-pat-XYZ sentinel-oauth-XYZ sentinel-anthropic-XYZ gh-actions-token)

fail() { echo "FAIL: $1" >&2; exit 1; }

cat >"$BINDIR/factory" <<'EOF2'
#!/usr/bin/env bash
for a in "$@"; do echo "arg=$a" >>"$FACTORY_SHIM_LOG"; done
if [ "${GITHUB_TOKEN:-}" = "${FACTORY_GITHUB_TOKEN:-}" ]; then echo "token_match=yes" >>"$FACTORY_SHIM_LOG"; else echo "token_match=no" >>"$FACTORY_SHIM_LOG"; fi
echo "shim ran"
exit "${FACTORY_SHIM_RC:-0}"
EOF2
chmod +x "$BINDIR/factory"

RC=0
ALL_OUT="$BINDIR/all-output.txt"
: >"$ALL_OUT"

run() {
  : >"$SHIM_LOG"
  rm -f "$RUN_LOG"
  RC=0
  env -i PATH="$BINDIR:$PATH" HOME="$BINDIR" FACTORY_SHIM_LOG="$SHIM_LOG" FACTORY_RUN_LOG="$RUN_LOG" "$@" \
    bash "$ROOT/scripts/factory-run.sh" >"$BINDIR/out.txt" 2>"$BINDIR/err.txt" || RC=$?
  cat "$BINDIR/out.txt" "$BINDIR/err.txt" >>"$ALL_OUT"
  [ ! -f "$RUN_LOG" ] || cat "$RUN_LOG" >>"$ALL_OUT"
}

expect_reject() {
  local msg="$1"; shift
  run "$@"
  [ "$RC" -eq 2 ] || fail "expected exit 2 for $*, got $RC"
  grep -qF -- "$msg" "$BINDIR/err.txt" || fail "missing message '$msg' for $*"
  [ ! -s "$SHIM_LOG" ] || fail "factory was called for $*"
}

TOK=FACTORY_GITHUB_TOKEN=sentinel-pat-XYZ

expect_reject "command not allowed: land" "$TOK" COMMAND=land ISSUE=42
expect_reject "command not allowed" "$TOK" COMMAND= ISSUE=42
expect_reject "issue must be a positive integer" "$TOK" COMMAND=run-issue "ISSUE=42; id"
for bad in 0 -1 042 '$(id)'; do
  expect_reject "issue must be a positive integer" "$TOK" COMMAND=run-issue "ISSUE=$bad"
done
expect_reject "issue is required for run-issue" "$TOK" COMMAND=run-issue
expect_reject "issue is required for ship" "$TOK" COMMAND=ship
expect_reject "issue is not accepted for doctor" "$TOK" COMMAND=doctor ISSUE=5
echo "PASS rejects disallowed command, malformed issue and missing issue without calling factory"

expect_reject "FACTORY_GITHUB_TOKEN is required" GITHUB_TOKEN=gh-actions-token COMMAND=run-issue ISSUE=42
expect_reject "FACTORY_GITHUB_TOKEN is required" GITHUB_TOKEN=gh-actions-token FACTORY_GITHUB_TOKEN= COMMAND=run-issue ISSUE=42
echo "PASS requires FACTORY_GITHUB_TOKEN"

run "$TOK" GITHUB_TOKEN=gh-actions-token CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ \
  ANTHROPIC_API_KEY=sentinel-anthropic-XYZ COMMAND=run-issue ISSUE=42
[ "$RC" -eq 0 ] || fail "run-issue 42 exited $RC"
[ "$(cat "$SHIM_LOG")" = "$(printf 'arg=run-issue\narg=42\ntoken_match=yes')" ] || fail "unexpected shim log: $(cat "$SHIM_LOG")"
grep -qF "shim ran" "$RUN_LOG" || fail "run log missing shim output"
echo "PASS runs factory run-issue 42 with GITHUB_TOKEN from FACTORY_GITHUB_TOKEN"

run "$TOK" COMMAND=ship ISSUE=7
[ "$RC" -eq 0 ] && [ "$(cat "$SHIM_LOG")" = "$(printf 'arg=ship\narg=7\ntoken_match=yes')" ] || fail "ship argv wrong"
run "$TOK" COMMAND=doctor
[ "$RC" -eq 0 ] && [ "$(cat "$SHIM_LOG")" = "$(printf 'arg=doctor\ntoken_match=yes')" ] || fail "doctor argv wrong"
echo "PASS doctor and ship argv"

run "$TOK" COMMAND=doctor FACTORY_SHIM_RC=3
[ "$RC" -eq 3 ] || fail "exit code not propagated, got $RC"
echo "PASS propagates factory exit code"

for s in "${SENTINELS[@]}"; do
  ! grep -qF -- "$s" "$ALL_OUT" || fail "secret $s leaked into output or log"
done
echo "PASS no sentinel secret in stdout, stderr or log"

for pat in 'eval' 'set -x' 'github.token' 'printenv'; do
  ! grep -qE -- "(^|[^a-z])${pat}([^a-z]|$)" <(grep -v '^#' "$ROOT/scripts/factory-run.sh") || fail "factory-run.sh contains '$pat'"
done
! grep -qE '^\s*env\s*$' "$ROOT/scripts/factory-run.sh" || fail "factory-run.sh dumps env"
echo "PASS wrapper static checks"

# --- workflow shape ---
[ "$(awk '/^on:/{f=1;next} f&&/^[^ #]/{f=0} f&&/^  [A-Za-z_-]+:/{print $1}' "$WF")" = "workflow_call:" ] || fail "on: must contain only workflow_call"
for t in workflow_dispatch schedule push pull_request issues issue_comment; do
  ! awk '/^on:/{f=1;next} f&&/^[^ #]/{f=0} f' "$WF" | grep -qE "^\s*${t}:" || fail "workflow has trigger $t"
done
[ "$(awk '/^    secrets:/{f=1;next} f&&/^      FACTORY_GITHUB_TOKEN:/{g=1;next} g&&NF{print $1,$2;exit}' "$WF")" = "required: true" ] || fail "FACTORY_GITHUB_TOKEN must be required"
TIMEOUTS="$(grep -E '^\s*timeout-minutes:' "$WF" | awk '{print $2}')"
[ -n "$TIMEOUTS" ] || fail "no timeout-minutes"
for t in $TIMEOUTS; do
  [[ "$t" =~ ^[0-9]+$ ]] && [ "$t" -le 350 ] || fail "bad timeout-minutes $t"
done
awk '/^      - /{blk=""} {blk=blk $0 "\n"} /uses: actions\/upload-artifact/{found=1; if (blk ~ /if: always\(\)/) ok=1; next} found&&!ok&&/if: always\(\)/{ok=1} END{exit !ok}' "$WF" \
  || fail "upload-artifact step needs if: always()"
# run values (single-line and block scalars) must not interpolate inputs
RUNS="$(awk '
  /^ *(- )?run: *[|>]/ {match($0,/^ */); ind=RLENGTH; blk=1; next}
  blk { match($0,/^ */); if (NF && RLENGTH<=ind) blk=0; else {print; next} }
  /^ *(- )?run:/ {print}
' "$WF")"
[ -n "$RUNS" ] || fail "no run blocks extracted"
! grep -qF '${{ inputs.' <<<"$RUNS" || fail "run block interpolates inputs"
! grep -qF 'github.token' "$WF" || fail "workflow references github.token"
[ "$(awk '/^  FACTORY_CLI_VERSION:/{print $2}' "$WF")" = "$(bash "$ROOT/scripts/set-release-version.sh" --current)" ] || fail "FACTORY_CLI_VERSION != lockstep version"
echo "PASS factory-run.yml shape"

lint() {
  if command -v actionlint >/dev/null 2>&1; then
    actionlint "$@"
  elif command -v docker >/dev/null 2>&1; then
    local f dir
    f="$1"; dir="$(dirname "$f")"
    docker run --rm -v "$dir:/repo" -w /repo rhysd/actionlint:latest "/repo/$(basename "$f")"
  elif [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    fail "actionlint not installed"
  else
    echo "SKIP: actionlint not installed"
    return 0
  fi
}

lint "$WF" || fail "actionlint rejected factory-run.yml"
echo "PASS actionlint factory-run.yml"

# --- runbook caller ---
CALLER="$BINDIR/.github/workflows/caller.yml"
mkdir -p "$(dirname "$CALLER")"
awk '/^```yaml/{if(!done){f=1;next}} f&&/^```/{f=0;done=1} f' "$RUNBOOK" >"$CALLER"
[ -s "$CALLER" ] || fail "no yaml block in runbook"
[ "$(awk '/^on:/{f=1;next} f&&/^[^ #]/{f=0} f&&/^  [A-Za-z_-]+:/{print $1}' "$CALLER")" = "workflow_dispatch:" ] || fail "caller on: must be only workflow_dispatch"
grep -qE 'uses: on-par/software-factory/\.github/workflows/factory-run\.yml@v[0-9]' "$CALLER" || fail "caller must pin uses to a @v tag"
grep -qE '^\s+FACTORY_GITHUB_TOKEN:' "$CALLER" || fail "caller must pass FACTORY_GITHUB_TOKEN"
lint "$CALLER" || fail "actionlint rejected runbook caller"
echo "PASS runbook example caller"

echo "PASS: factory-run"
