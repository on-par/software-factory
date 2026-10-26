#!/usr/bin/env bash
# Wrapper for .github/workflows/factory-run.yml (#3197). Runs one allowlisted
# factory command. Inputs come only from env (COMMAND, ISSUE, FACTORY_GITHUB_TOKEN)
# and are validated before use; factory is called with an argument list, never eval.
# #3199: PROVIDER picks the agent provider; the wrapper owns the provider rules (allowlist,
# experimental gate, secret preflight and isolation, model defaults, CLI install).
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
exit "$rc"
