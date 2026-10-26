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
SENTINELS=(sentinel-pat-XYZ sentinel-oauth-XYZ sentinel-anthropic-XYZ gh-actions-token
  sentinel-openai-XYZ sentinel-codex-XYZ sentinel-opencode-XYZ sentinel-openrouter-XYZ)
INSTALL_LOG="$BINDIR/install.log"

fail() { echo "FAIL: $1" >&2; exit 1; }

cat >"$BINDIR/factory" <<'EOF2'
#!/usr/bin/env bash
for a in "$@"; do echo "arg=$a" >>"$FACTORY_SHIM_LOG"; done
if [ "${GITHUB_TOKEN:-}" = "${FACTORY_GITHUB_TOKEN:-}" ]; then echo "token_match=yes" >>"$FACTORY_SHIM_LOG"; else echo "token_match=no" >>"$FACTORY_SHIM_LOG"; fi
for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY OPENCODE_API_KEY OPENROUTER_API_KEY; do
  [ -z "${!n:-}" ] || echo "has=$n" >>"$FACTORY_SHIM_LOG"
done
echo "plan=${FACTORY_PLAN_MODEL:-}" >>"$FACTORY_SHIM_LOG"
echo "build=${FACTORY_BUILD_MODEL:-}" >>"$FACTORY_SHIM_LOG"
echo "experimental=${FACTORY_EXPERIMENTAL:-unset}" >>"$FACTORY_SHIM_LOG"
echo "git_name=$(git config user.name 2>/dev/null)" >>"$FACTORY_SHIM_LOG"
echo "git_email=$(git config user.email 2>/dev/null)" >>"$FACTORY_SHIM_LOG"
if [ -n "${CODEX_API_KEY:-}" ]; then echo "codex_sum=$(printf %s "$CODEX_API_KEY" | cksum)" >>"$FACTORY_SHIM_LOG"; fi
# an empty value resets git's header list, so only the entries after the last one are sent
hdr="$(git config --get-all "http.https://github.com/.extraheader" 2>/dev/null | awk '!NF{n=0;next}{a[n++]=$0}END{for(i=0;i<n;i++)print a[i]}' || true)"
echo "header_count=$(printf '%s' "$hdr" | grep -c '^')" >>"$FACTORY_SHIM_LOG"
if [ "$(printf '%s\n' "$hdr" | tail -n1)" = "AUTHORIZATION: basic $(printf 'x-access-token:%s' "${FACTORY_GITHUB_TOKEN:-}" | base64 | tr -d '\n')" ]; then
  echo "push_auth=pat" >>"$FACTORY_SHIM_LOG"
else echo "push_auth=other" >>"$FACTORY_SHIM_LOG"; fi
echo "pager=$(git config core.pager 2>/dev/null)" >>"$FACTORY_SHIM_LOG"
[ -z "${FACTORY_SHIM_SAY:-}" ] || echo "$FACTORY_SHIM_SAY"
echo "shim ran"
exit "${FACTORY_SHIM_RC:-0}"
EOF2
cat >"$BINDIR/npm" <<'EOF2'
#!/usr/bin/env bash
echo "npm $*" >>"$FACTORY_INSTALL_LOG"
EOF2
cat >"$BINDIR/codex" <<'EOF2'
#!/usr/bin/env bash
echo "codex $* stdin_sum=$(cat | cksum)" >>"$FACTORY_INSTALL_LOG"
EOF2
chmod +x "$BINDIR/factory" "$BINDIR/npm" "$BINDIR/codex"

RC=0
ALL_OUT="$BINDIR/all-output.txt"
: >"$ALL_OUT"

# The wrapper writes git identity into the checkout it runs in, so run it in scratch repos.
new_repo() { git init -q "$1"; }
WORKREPO="$BINDIR/repo"
new_repo "$WORKREPO"

run() {
  : >"$SHIM_LOG"
  : >"$INSTALL_LOG"
  rm -f "$RUN_LOG"
  RC=0
  (cd "${RUN_CWD:-$WORKREPO}" && env -i PATH="$BINDIR:$PATH" HOME="$BINDIR" GIT_CONFIG_NOSYSTEM=1 \
    FACTORY_SHIM_LOG="$SHIM_LOG" FACTORY_INSTALL_LOG="$INSTALL_LOG" FACTORY_RUN_LOG="$RUN_LOG" "$@" \
    bash "$ROOT/scripts/factory-run.sh") >"$BINDIR/out.txt" 2>"$BINDIR/err.txt" || RC=$?
  [ -z "${NO_ALL_OUT:-}" ] || return 0
  cat "$BINDIR/out.txt" "$BINDIR/err.txt" >>"$ALL_OUT"
  [ ! -f "$RUN_LOG" ] || cat "$RUN_LOG" >>"$ALL_OUT"
}

expect_reject() {
  local msg="$1"; shift
  run "$@"
  [ "$RC" -eq 2 ] || fail "expected exit 2 for $*, got $RC"
  grep -qF -- "$msg" "$BINDIR/err.txt" || fail "missing message '$msg' for $*"
  [ ! -s "$SHIM_LOG" ] || fail "factory was called for $*"
  [ ! -s "$INSTALL_LOG" ] || fail "something was installed for $*"
}

shimargs() { grep -E '^(arg|token_match)=' "$SHIM_LOG"; }

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
[ "$(shimargs)" = "$(printf 'arg=run-issue\narg=42\ntoken_match=yes')" ] || fail "unexpected shim log: $(cat "$SHIM_LOG")"
grep -qF "shim ran" "$RUN_LOG" || fail "run log missing shim output"
echo "PASS runs factory run-issue 42 with GITHUB_TOKEN from FACTORY_GITHUB_TOKEN"

run "$TOK" CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ COMMAND=ship ISSUE=7
[ "$RC" -eq 0 ] && [ "$(shimargs)" = "$(printf 'arg=ship\narg=7\ntoken_match=yes')" ] || fail "ship argv wrong"
run "$TOK" CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ COMMAND=doctor
[ "$RC" -eq 0 ] && [ "$(shimargs)" = "$(printf 'arg=doctor\ntoken_match=yes')" ] || fail "doctor argv wrong"
echo "PASS doctor and ship argv"

run "$TOK" CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ COMMAND=doctor FACTORY_SHIM_RC=3
[ "$RC" -eq 3 ] || fail "exit code not propagated, got $RC"
echo "PASS propagates factory exit code"

OAUTH=CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ

# --- git identity ---
BOT_NAME="Software Factory Actions"
BOT_EMAIL="factory-actions[bot]@users.noreply.github.com"
localcfg() { git -C "$1" config --local "$2" || true; }
R="$BINDIR/id-unset"; new_repo "$R"
RUN_CWD="$R" run "$TOK" "$OAUTH" COMMAND=doctor
[ "$RC" -eq 0 ] || fail "identity-unset run exited $RC"
[ "$(localcfg "$R" user.name)" = "$BOT_NAME" ] && [ "$(localcfg "$R" user.email)" = "$BOT_EMAIL" ] || fail "bot identity not set locally"
grep -qxF "git_name=$BOT_NAME" "$SHIM_LOG" && grep -qxF "git_email=$BOT_EMAIL" "$SHIM_LOG" || fail "factory ran before identity was set"
R="$BINDIR/id-set"; new_repo "$R"
git -C "$R" config user.name "Jane Dev"; git -C "$R" config user.email "jane@example.com"
RUN_CWD="$R" run "$TOK" "$OAUTH" COMMAND=doctor
[ "$(localcfg "$R" user.name)" = "Jane Dev" ] && [ "$(localcfg "$R" user.email)" = "jane@example.com" ] || fail "existing local identity overwritten"
R="$BINDIR/id-half"; new_repo "$R"
git -C "$R" config user.name "Jane Dev"
RUN_CWD="$R" run "$TOK" "$OAUTH" COMMAND=doctor
[ "$(localcfg "$R" user.name)" = "Jane Dev" ] && [ "$(localcfg "$R" user.email)" = "$BOT_EMAIL" ] || fail "only the missing field should be set"
R="$BINDIR/id-global"; new_repo "$R"
printf '[user]\n\tname = Global Dev\n\temail = global@example.com\n' >"$BINDIR/global.gitconfig"
RUN_CWD="$R" run "$TOK" "$OAUTH" COMMAND=doctor GIT_CONFIG_GLOBAL="$BINDIR/global.gitconfig"
[ -z "$(localcfg "$R" user.name)" ] && [ -z "$(localcfg "$R" user.email)" ] || fail "effective global identity overridden locally"
grep -qxF "git_name=Global Dev" "$SHIM_LOG" || fail "factory did not see the global identity"
mkdir -p "$BINDIR/not-a-repo"
RUN_CWD="$BINDIR/not-a-repo" run "$TOK" "$OAUTH" COMMAND=doctor GIT_CEILING_DIRECTORIES="$BINDIR"
[ "$RC" -eq 0 ] || fail "run outside a git checkout exited $RC"
echo "PASS sets the Actions bot git identity only for missing fields"

# --- git push auth (#3707) ---
R="$BINDIR/push-auth"; new_repo "$R"
git -C "$R" config --local http.https://github.com/.extraheader "AUTHORIZATION: basic $(printf 'x-access-token:gh-actions-token' | base64)"
for cmd in "run-issue 42" "ship 7"; do
  RUN_CWD="$R" run "$TOK" "$OAUTH" GITHUB_TOKEN=gh-actions-token COMMAND="${cmd% *}" ISSUE="${cmd#* }"
  [ "$RC" -eq 0 ] || fail "push-auth $cmd exited $RC"
  grep -qxF push_auth=pat "$SHIM_LOG" && grep -qxF header_count=1 "$SHIM_LOG" || fail "push auth not PAT-only for $cmd: $(cat "$SHIM_LOG")"
done
RUN_CWD="$R" run "$TOK" "$OAUTH" GITHUB_TOKEN=gh-actions-token COMMAND=ship ISSUE=7 \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat
grep -qxF push_auth=pat "$SHIM_LOG" && grep -qxF pager=cat "$SHIM_LOG" || fail "existing GIT_CONFIG entries not preserved"
echo "PASS git push auth uses FACTORY_GITHUB_TOKEN"

# --- CI-pending ship (#3707) ---
SUMMARY="$BINDIR/summary.md"; : >"$SUMMARY"
run "$TOK" "$OAUTH" COMMAND=ship ISSUE=7 "FACTORY_SHIM_SAY=PR #9 left as draft (CI pending)" GITHUB_STEP_SUMMARY="$SUMMARY"
[ "$RC" -eq 1 ] || fail "CI-pending ship exited $RC, want 1"
grep -F '::error::' "$BINDIR/err.txt" | grep -qF 'not landed' || fail "missing ::error:: not landed"
grep -qF 'not landed' "$SUMMARY" || fail "step summary missing note"
run "$TOK" "$OAUTH" COMMAND=ship ISSUE=7 "FACTORY_SHIM_SAY=PR #9 left as draft"
[ "$RC" -eq 0 ] || fail "plain draft ship exited $RC"
run "$TOK" "$OAUTH" COMMAND=ship ISSUE=7 "FACTORY_SHIM_SAY=PR #9 left as draft (CI pending)" FACTORY_SHIM_RC=3
[ "$RC" -eq 3 ] || fail "non-zero exit not propagated for CI-pending, got $RC"
echo "PASS CI-pending ship exits 1 with ::error::"

CODEX_SUM() { printf %s "$1" | cksum; }

# --- providers ---
expect_reject "provider codex-cli needs repo secret OPENAI_API_KEY (or CODEX_API_KEY)" "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli
expect_reject "provider codex-cli needs repo secret" "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY= CODEX_API_KEY=
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli CODEX_API_KEY=sentinel-codex-XYZ
[ "$RC" -eq 0 ] || fail "codex alias run exited $RC"
grep -qxF "codex_sum=$(CODEX_SUM sentinel-codex-XYZ)" "$SHIM_LOG" || fail "codex alias key not exported"
grep -qF "codex login --with-api-key stdin_sum=$(CODEX_SUM sentinel-codex-XYZ)" "$INSTALL_LOG" || fail "codex login stdin wrong"
grep -qxF "npm install -g @openai/codex" "$INSTALL_LOG" || fail "codex not installed"
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY=sentinel-openai-XYZ CODEX_API_KEY=sentinel-codex-XYZ
[ "$RC" -eq 0 ] || fail "codex precedence run exited $RC"
grep -qE '::warning::.*OPENAI_API_KEY.*CODEX_API_KEY' "$BINDIR/out.txt" "$BINDIR/err.txt" || fail "missing codex warning"
grep -qxF "codex_sum=$(CODEX_SUM sentinel-openai-XYZ)" "$SHIM_LOG" || fail "OPENAI_API_KEY did not win"
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY=sentinel-openai-XYZ CODEX_API_KEY=sentinel-openai-XYZ
! grep -qF '::warning::' "$BINDIR/out.txt" || fail "warned for equal codex keys"
echo "PASS codex-cli secret preflight, alias and precedence"

run "$TOK" "$OAUTH" COMMAND=run-issue ISSUE=42
[ "$RC" -eq 0 ] && [ "$(shimargs)" = "$(printf 'arg=run-issue\narg=42\ntoken_match=yes')" ] || fail "claude oauth run failed"
run "$TOK" ANTHROPIC_API_KEY=sentinel-anthropic-XYZ COMMAND=run-issue ISSUE=42 PROVIDER=claude-cli
[ "$RC" -eq 0 ] && grep -qxF 'arg=42' "$SHIM_LOG" || fail "claude anthropic run failed"
grep -qxF "npm install -g @anthropic-ai/claude-code@2.1.308" "$INSTALL_LOG" || fail "claude-code not installed"
expect_reject "provider claude-cli needs repo secret" "$TOK" COMMAND=run-issue ISSUE=42
for bad in copilot ollama-http command Codex-CLI 'pi ' '$(id)'; do
  expect_reject "provider not allowed" "$TOK" "$OAUTH" COMMAND=run-issue ISSUE=42 "PROVIDER=$bad"
done
echo "PASS claude-cli secrets and provider allowlist"

run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY=sentinel-openai-XYZ
grep -qxF 'plan=gpt-5.6-terra-high' "$SHIM_LOG" && grep -qxF 'build=gpt-5.6-sol' "$SHIM_LOG" || fail "codex model defaults wrong"
run "$TOK" "$OAUTH" COMMAND=run-issue ISSUE=42 FACTORY_PLAN_MODEL=claude-opus-5 FACTORY_BUILD_MODEL=
grep -qxF 'plan=claude-opus-5' "$SHIM_LOG" && grep -qxF 'build=claude-sonnet-5' "$SHIM_LOG" || fail "empty model not defaulted"
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY=sentinel-openai-XYZ FACTORY_BUILD_MODEL=gpt-5.6-luna-high
grep -qxF 'plan=gpt-5.6-terra-high' "$SHIM_LOG" && grep -qxF 'build=gpt-5.6-luna-high' "$SHIM_LOG" || fail "explicit build model not kept"
echo "PASS provider model defaults and explicit overrides"

for p in opencode pi; do
  expect_reject "is experimental: set experimental: true" "$TOK" COMMAND=run-issue ISSUE=42 "PROVIDER=$p" OPENCODE_API_KEY=sentinel-opencode-XYZ OPENROUTER_API_KEY=sentinel-openrouter-XYZ
  expect_reject "is experimental: set experimental: true" "$TOK" COMMAND=run-issue ISSUE=42 "PROVIDER=$p" EXPERIMENTAL=false OPENCODE_API_KEY=sentinel-opencode-XYZ OPENROUTER_API_KEY=sentinel-openrouter-XYZ
done
expect_reject "experimental must be true or false" "$TOK" "$OAUTH" COMMAND=run-issue ISSUE=42 EXPERIMENTAL=yes
expect_reject "provider opencode needs repo secret OPENCODE_API_KEY" "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=opencode EXPERIMENTAL=true
run "$TOK" "$OAUTH" COMMAND=run-issue ISSUE=42 FACTORY_EXPERIMENTAL=1
grep -qxF 'experimental=unset' "$SHIM_LOG" || fail "inherited FACTORY_EXPERIMENTAL leaked"
ALLSEC=(CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-XYZ ANTHROPIC_API_KEY=sentinel-anthropic-XYZ OPENAI_API_KEY=sentinel-openai-XYZ
  CODEX_API_KEY=sentinel-codex-XYZ OPENCODE_API_KEY=sentinel-opencode-XYZ OPENROUTER_API_KEY=sentinel-openrouter-XYZ)
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=pi EXPERIMENTAL=true "${ALLSEC[@]}"
[ "$RC" -eq 0 ] || fail "pi run exited $RC"
grep -qxF 'experimental=1' "$SHIM_LOG" || fail "experimental not exported"
[ "$(grep '^has=' "$SHIM_LOG")" = "has=OPENROUTER_API_KEY" ] || fail "pi saw other secrets: $(grep '^has=' "$SHIM_LOG")"
grep -qF "@earendil-works/pi-coding-agent@1.2.0" "$INSTALL_LOG" || fail "pi not installed"
run "$TOK" COMMAND=run-issue ISSUE=42 PROVIDER=opencode EXPERIMENTAL=true "${ALLSEC[@]}"
[ "$(grep '^has=' "$SHIM_LOG")" = "has=OPENCODE_API_KEY" ] || fail "opencode saw other secrets"
grep -qF "npm install -g opencode-ai@1.18.28" "$INSTALL_LOG" || fail "opencode not installed"
echo "PASS experimental gate and per-provider secret isolation"

NO_ALL_OUT=1 run "$TOK" GITHUB_ACTIONS=true COMMAND=run-issue ISSUE=42 PROVIDER=codex-cli OPENAI_API_KEY=sentinel-openai-XYZ
[ "$RC" -eq 0 ] || fail "mask run exited $RC"
grep -qxF '::add-mask::sentinel-openai-XYZ' "$BINDIR/out.txt" || fail "secret not masked"
! grep -F 'sentinel-' "$BINDIR/out.txt" | grep -qv '^::add-mask::' || fail "unmasked sentinel in stdout"
echo "PASS add-mask under GITHUB_ACTIONS"

# model ids in the wrapper table exist in defaults.ts with the matching harness
DEFAULTS="$ROOT/packages/config/src/defaults.ts"
for pair in claude-opus-5:claude-cli claude-sonnet-5:claude-cli gpt-5.6-terra-high:codex-cli gpt-5.6-sol:codex-cli \
  opencode-deepseek-v4-flash:opencode pi-openrouter-deepseek-v4-flash:pi; do
  id="${pair%%:*}"; h="${pair##*:}"
  [ "$(awk -v id="'$id': {" 'index($0,id){f=1} f&&/harness:/{print $2; exit}' "$DEFAULTS")" = "'$h'," ] || fail "model $id is not harness $h in defaults.ts"
  grep -qF "$id" "$ROOT/scripts/factory-run.sh" || fail "wrapper lacks default $id"
done
echo "PASS wrapper model defaults match defaults.ts"

for s in "${SENTINELS[@]}"; do
  ! grep -qF -- "$s" "$ALL_OUT" || fail "secret $s leaked into output or log"
done
! grep -qF -- "$(printf 'x-access-token:sentinel-pat-XYZ' | base64)" "$ALL_OUT" || fail "PAT auth header leaked into output or log"
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
for i in provider experimental plan_model build_model; do
  grep -qE "^      $i:" "$WF" || fail "workflow lacks input $i"
done
for sec in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY OPENCODE_API_KEY OPENROUTER_API_KEY; do
  [ "$(awk -v k="      $sec:" '/^    secrets:/{f=1} f&&$0==k{g=1;next} g&&NF{print $1,$2;exit}' "$WF")" = "required: false" ] || fail "$sec must be required: false"
done
for pair in CLAUDE_CODE_OAUTH_TOKEN:claude-cli ANTHROPIC_API_KEY:claude-cli OPENAI_API_KEY:codex-cli CODEX_API_KEY:codex-cli \
  OPENCODE_API_KEY:opencode OPENROUTER_API_KEY:pi; do
  grep -F "inputs.provider == '${pair##*:}' && secrets.${pair%%:*}" "$WF" | grep -qF "          ${pair%%:*}:" || fail "run step must map ${pair%%:*} only for ${pair##*:}"
done
awk '/uses: actions\/checkout/{n++; if(n==1){f=1;next}} f&&/^      - /{exit} f' "$WF" | grep -qF 'token: ${{ secrets.FACTORY_GITHUB_TOKEN }}' \
  || fail "caller checkout must use FACTORY_GITHUB_TOKEN"
echo "PASS caller checkout uses FACTORY_GITHUB_TOKEN"
! grep -qF '@anthropic-ai/claude-code' "$WF" || fail "workflow still installs claude-code"
echo "PASS factory-run.yml shape"

lint() {
  if command -v actionlint >/dev/null 2>&1; then
    actionlint "$@"
  elif command -v docker >/dev/null 2>&1; then
    local f dir
    f="$1"
    # mount the repo root for in-repo files so local `uses: ./...` resolves
    case "$f" in "$ROOT"/*) dir="$ROOT" ;; *) dir="$(dirname "$f")" ;; esac
    docker run --rm -v "$dir:/repo" -w /repo rhysd/actionlint:latest "/repo/${f#"$dir"/}"
  elif [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    fail "actionlint not installed"
  else
    echo "SKIP: actionlint not installed"
    return 0
  fi
}

lint "$WF" || fail "actionlint rejected factory-run.yml"
echo "PASS actionlint factory-run.yml"

# --- dogfood caller (.github/workflows/factory.yml) ---
DOGFOOD="$ROOT/.github/workflows/factory.yml"
[ "$(awk '/^on:/{f=1;next} f&&/^[^ #]/{f=0} f&&/^  [A-Za-z_-]+:/{print $1}' "$DOGFOOD")" = "workflow_dispatch:" ] || fail "dogfood on: must be only workflow_dispatch"
grep -qxF '    uses: ./.github/workflows/factory-run.yml' "$DOGFOOD" || fail "dogfood must call factory-run.yml by relative path"
inputs_block() { awk '/^    inputs:/{f=1;next} f&&NF&&!/^     /{f=0} f' "$1"; }
[ "$(inputs_block "$DOGFOOD")" = "$(inputs_block "$WF")" ] || fail "dogfood inputs differ from factory-run.yml workflow_call inputs"
for i in $(inputs_block "$WF" | awk '/^      [a-z_]+:$/{sub(":","",$1); print $1}'); do
  grep -qxF "      $i: \${{ inputs.$i }}" "$DOGFOOD" || fail "dogfood does not pass input $i"
done
for sec in $(awk '/^    secrets:/{f=1;next} f&&NF&&!/^     /{f=0} f&&/^      [A-Z_]+:$/{sub(":","",$1); print $1}' "$WF"); do
  grep -qxF "      $sec: \${{ secrets.$sec }}" "$DOGFOOD" || fail "dogfood does not pass secret $sec"
done
for perm in 'contents: write' 'pull-requests: write' 'issues: write'; do
  grep -qxF "      $perm" "$DOGFOOD" || fail "dogfood lacks permission $perm"
done
grep -qxF '.factory-action/' "$ROOT/.gitignore" || fail ".gitignore lacks .factory-action/"
lint "$DOGFOOD" || fail "actionlint rejected factory.yml"
echo "PASS dogfood caller factory.yml"

# --- runbook caller ---
CALLER="$BINDIR/.github/workflows/caller.yml"
mkdir -p "$(dirname "$CALLER")"
awk '/^```yaml/{if(!done){f=1;next}} f&&/^```/{f=0;done=1} f' "$RUNBOOK" >"$CALLER"
[ -s "$CALLER" ] || fail "no yaml block in runbook"
[ "$(awk '/^on:/{f=1;next} f&&/^[^ #]/{f=0} f&&/^  [A-Za-z_-]+:/{print $1}' "$CALLER")" = "workflow_dispatch:" ] || fail "caller on: must be only workflow_dispatch"
grep -qxF "    uses: on-par/software-factory/.github/workflows/factory-run.yml@v$(awk '/^  FACTORY_CLI_VERSION:/{print $2}' "$WF")" "$CALLER" \
  || fail "caller must pin uses to @v<FACTORY_CLI_VERSION>"
grep -qE '^\s+FACTORY_GITHUB_TOKEN:' "$CALLER" || fail "caller must pass FACTORY_GITHUB_TOKEN"
lint "$CALLER" || fail "actionlint rejected runbook caller"
echo "PASS runbook example caller"

echo "PASS: factory-run"
