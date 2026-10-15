#!/usr/bin/env bash
# Print the smoke-repo .factory/config.yaml for one agent: codex, opencode, pi or command.
set -euo pipefail

agent="${1:-}"
case "$agent" in
  codex | opencode | pi | command) ;;
  *)
    echo "usage: $0 <codex|opencode|pi|command>" >&2
    exit 2
    ;;
esac

sed "s/__SMOKE_AGENT__/$agent/g" "$(dirname "$0")/factory-config.template.yaml"
