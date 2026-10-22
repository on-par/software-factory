#!/usr/bin/env bash
# Wrapper for .github/workflows/factory-run.yml (#3197). Runs one allowlisted
# factory command. Inputs come only from env (COMMAND, ISSUE, FACTORY_GITHUB_TOKEN)
# and are validated before use; factory is called with an argument list, never eval.
set -euo pipefail

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

export GITHUB_TOKEN="$FACTORY_GITHUB_TOKEN"
export GH_TOKEN="$FACTORY_GITHUB_TOKEN"
set +e
factory "${args[@]}" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
exit "$rc"
