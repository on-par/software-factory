#!/usr/bin/env bash
# Runs the real-CLI full-loop smoke for one agent, or skips cleanly (exit 0) when the
# agent's secret is not configured. Usage: real-cli-smoke.sh <codex|opencode>
set -euo pipefail

agent="${1:-}"
case "$agent" in
  codex) var=OPENAI_API_KEY ;;
  opencode) var=OPENCODE_API_KEY ;;
  *)
    echo "usage: $0 <codex|opencode>" >&2
    exit 2
    ;;
esac

if [ -z "${!var:-}" ]; then
  echo "::notice::$var is not configured — skipping the real $agent smoke"
  exit 0
fi

cd "$(dirname "$0")/.."
FACTORY_REAL_CLI="$agent" exec npx vitest run packages/core/src/phases/real-cli-loop.real-cli.test.ts
