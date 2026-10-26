#!/usr/bin/env bash
# Wrapper for .github/workflows/factory-run.yml (#3197). Runs one allowlisted
# factory command. Inputs come only from env (COMMAND, ISSUE, FACTORY_GITHUB_TOKEN)
# and are validated before use; factory is called with an argument list, never eval.
# #3199: PROVIDER picks the agent provider; the wrapper owns the provider rules (allowlist,
# experimental gate, secret preflight and isolation, model defaults, CLI install).
# #3707: git pushes authenticate as FACTORY_GITHUB_TOKEN (not the checkout's Actions token), and a
# ship that ends "left as draft (CI pending)" exits 1 so it never counts as a land.
# #3727: ship and run-issue stop at a ready PR (#978), so with FACTORY_MERGE=1 the wrapper runs
# `factory land <issue>` after them in the same job. land is still not an allowed COMMAND.
set -euo pipefail

CLAUDE_CODE_VERSION=2.1.308

COMMAND="${COMMAND:-}"
ISSUE="${ISSUE:-}"
LOG="${FACTORY_RUN_LOG:-factory-run.log}"

die() { echo "factory-run: $1" >&2; exit 2; }

[ -n "${FACTORY_GITHUB_TOKEN:-}" ] || die "FACTORY_GITHUB_TOKEN is required: PRs opened with GITHUB_TOKEN never trigger the required ci check"
case "$COMMAND" in
  run-issue|ship|doctor) ;;
  *) die "command not allowed: ${COMMAND:-<empty>}" ;;
esac
if [ -n "$ISSUE" ] && ! [[ "$ISSUE" =~ ^[1-9][0-9]*$ ]]; then
  die "issue must be a positive integer: $ISSUE"
fi
args=("$COMMAND")
case "$COMMAND" in
  run-issue|ship) [ -n "$ISSUE" ] || die "issue is required for $COMMAND"; args+=("$ISSUE") ;;
  doctor) [ -z "$ISSUE" ] || die "issue is not accepted for doctor" ;;
esac

PROVIDER="${PROVIDER:-claude-cli}"
case "$PROVIDER" in
  claude-cli|codex-cli|opencode|pi) ;;
  *) die "provider not allowed: $PROVIDER" ;;
esac

case "${EXPERIMENTAL:-false}" in
  true) experimental=1 ;;
  false) experimental=0 ;;
  *) die "experimental must be true or false: $EXPERIMENTAL" ;;
esac
case "$PROVIDER" in
  opencode|pi) [ "$experimental" -eq 1 ] || die "provider $PROVIDER is experimental: set experimental: true to run it" ;;
esac
if [ "$experimental" -eq 1 ]; then export FACTORY_EXPERIMENTAL=1; else unset FACTORY_EXPERIMENTAL; fi

codex_key=""
case "$PROVIDER" in
  claude-cli)
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] \
      || die "provider claude-cli needs repo secret CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)"
    keep="CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY"
    default_plan=claude-opus-5; default_build=claude-sonnet-5 ;;
  codex-cli)
    [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] \
      || die "provider codex-cli needs repo secret OPENAI_API_KEY (or CODEX_API_KEY)"
    if [ -n "${OPENAI_API_KEY:-}" ] && [ -n "${CODEX_API_KEY:-}" ] && [ "$OPENAI_API_KEY" != "$CODEX_API_KEY" ]; then
      echo "::warning::OPENAI_API_KEY and CODEX_API_KEY are both set and differ; using OPENAI_API_KEY"
    fi
    codex_key="${OPENAI_API_KEY:-$CODEX_API_KEY}"
    export OPENAI_API_KEY="$codex_key" CODEX_API_KEY="$codex_key"
    keep="OPENAI_API_KEY CODEX_API_KEY"
    default_plan=gpt-5.6-terra-high; default_build=gpt-5.6-sol ;;
  opencode)
    [ -n "${OPENCODE_API_KEY:-}" ] || die "provider opencode needs repo secret OPENCODE_API_KEY"
    keep="OPENCODE_API_KEY"
    default_plan=opencode-deepseek-v4-flash; default_build=opencode-deepseek-v4-flash ;;
  pi)
    [ -n "${OPENROUTER_API_KEY:-}" ] || die "provider pi needs repo secret OPENROUTER_API_KEY"
    keep="OPENROUTER_API_KEY"
    default_plan=pi-openrouter-deepseek-v4-flash; default_build=pi-openrouter-deepseek-v4-flash ;;
esac

for v in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY OPENCODE_API_KEY OPENROUTER_API_KEY; do
  case " $keep " in
    *" $v "*)
      if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${!v:-}" ]; then printf '::add-mask::%s\n' "${!v}"; fi ;;
    *) unset "$v" ;;
  esac
done

export FACTORY_PLAN_MODEL="${FACTORY_PLAN_MODEL:-$default_plan}"
export FACTORY_BUILD_MODEL="${FACTORY_BUILD_MODEL:-$default_build}"

case "$PROVIDER" in
  claude-cli) npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" ;;
  codex-cli)
    npm install -g @openai/codex
    printf '%s' "$codex_key" | codex login --with-api-key >/dev/null ;;
  opencode)
    export OPENCODE_DISABLE_AUTOUPDATE=1
    npm install -g opencode-ai@1.18.28 ;;
  pi) npm install -g @earendil-works/pi-coding-agent@1.2.0 ;;
esac

export GITHUB_TOKEN="$FACTORY_GITHUB_TOKEN"
export GH_TOKEN="$FACTORY_GITHUB_TOKEN"

# actions/checkout persists its token as git's github.com extraheader, so pushes would go out as
# github-actions[bot] and leave follow-up CI at action_required (#3707). Force the PAT header via
# command-scope config: an empty value resets any inherited header, then ours is added.
server="${GITHUB_SERVER_URL:-https://github.com}"
auth_b64="$(printf 'x-access-token:%s' "$FACTORY_GITHUB_TOKEN" | base64 | tr -d '\n')"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::add-mask::%s\n' "$auth_b64"; fi
n="${GIT_CONFIG_COUNT:-0}"
[[ "$n" =~ ^[0-9]+$ ]] || n=0
export "GIT_CONFIG_KEY_${n}=http.${server}/.extraheader" "GIT_CONFIG_VALUE_${n}="
export "GIT_CONFIG_KEY_$((n + 1))=http.${server}/.extraheader" "GIT_CONFIG_VALUE_$((n + 1))=AUTHORIZATION: basic ${auth_b64}"
export GIT_CONFIG_COUNT=$((n + 2))

# A fresh runner checkout has no git identity and factory doctor fails without one.
# Set only the missing fields, in the repo's local config; an existing identity wins.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [ -n "$(git config user.name || true)" ] || git config --local user.name "Software Factory Actions"
  [ -n "$(git config user.email || true)" ] || git config --local user.email "factory-actions[bot]@users.noreply.github.com"
fi

set +e
factory "${args[@]}" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e

if [ "$rc" -eq 0 ] && { [ "$COMMAND" = run-issue ] || [ "$COMMAND" = ship ]; } \
  && grep -qF 'left as draft (CI pending)' "$LOG" 2>/dev/null; then
  msg="factory-run: PR left as draft (CI pending): CI did not report, so the PR was not landed"
  echo "::error::$msg" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$msg" >>"$GITHUB_STEP_SUMMARY"; fi
  rc=1
fi

if [ "$rc" -eq 0 ] && [ "${FACTORY_MERGE:-}" = 1 ] && { [ "$COMMAND" = run-issue ] || [ "$COMMAND" = ship ]; }; then
  if grep -qF 'left as draft' "$LOG" 2>/dev/null; then
    echo "factory-run: PR left as draft, so it is not landed (draft wins over FACTORY_MERGE=1)"
  else
    set +e
    factory land "$ISSUE" 2>&1 | tee -a "$LOG"
    rc=${PIPESTATUS[0]}
    set -e
    if [ "$rc" -ne 0 ]; then
      msg="factory-run: factory land $ISSUE exited $rc after $COMMAND succeeded; see the land output above"
      echo "::error::$msg" >&2
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$msg" >>"$GITHUB_STEP_SUMMARY"; fi
    fi
  fi
fi
exit "$rc"
