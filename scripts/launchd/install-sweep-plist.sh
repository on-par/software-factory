#!/usr/bin/env bash
# Renders scripts/launchd/com.on-par.auto-merge-sweep.plist.template into a
# working, machine-specific LaunchAgent plist and writes it to
# ~/Library/LaunchAgents, so an operator doesn't have to hand-edit the
# template's placeholder paths (issue #1290).
#
# Substitutes:
#   __SF_ROOT__  the repo root, resolved via `git rev-parse --show-toplevel`
#   __SF_HOME__  the current user's home directory ($HOME)
#
# Does NOT run `launchctl load`/`bootstrap` — installing the rendered file
# into ~/Library/LaunchAgents is a separate, explicit step for the operator.
#
# Usage: scripts/launchd/install-sweep-plist.sh (run from within the repo)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/com.on-par.auto-merge-sweep.plist.template"

SF_ROOT="$(git rev-parse --show-toplevel)"
SF_HOME="$HOME"

DEST_DIR="$HOME/Library/LaunchAgents"
DEST_FILE="$DEST_DIR/com.on-par.auto-merge-sweep.plist"

mkdir -p "$DEST_DIR"

sed \
  -e "s#__SF_ROOT__#$SF_ROOT#g" \
  -e "s#__SF_HOME__#$SF_HOME#g" \
  "$TEMPLATE" >"$DEST_FILE"

echo "$DEST_FILE"
