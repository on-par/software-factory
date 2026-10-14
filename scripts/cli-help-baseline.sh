#!/usr/bin/env bash
# Diffs the built CLI's top-level `factory --help` against the committed baseline.
# Usage: cli-help-baseline.sh [--update]
#   (no args)  check: exit 0 silently when identical, exit 1 with a unified diff on drift
#   --update   rewrite scripts/fixtures/factory-help.txt from the current build
# Exits 2 on usage errors, a missing build (run `npm run build`) or a missing baseline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${FACTORY_HELP_CLI:-$ROOT/packages/cli/dist/cli.js}"
BASELINE="${FACTORY_HELP_BASELINE:-$ROOT/scripts/fixtures/factory-help.txt}"

mode=check
case "${1:-}" in
  "") ;;
  --update) mode=update ;;
  *)
    echo "usage: $0 [--update]" >&2
    exit 2
    ;;
esac

if [ ! -f "$CLI" ]; then
  echo "cli-help-baseline: $CLI not found; run npm run build first" >&2
  exit 2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! COLUMNS=80 NO_COLOR=1 FORCE_COLOR=0 node "$CLI" --help >"$tmp"; then
  echo "cli-help-baseline: node $CLI --help failed" >&2
  exit 2
fi

if [ "$mode" = update ]; then
  cp "$tmp" "$BASELINE"
  echo "cli-help-baseline: wrote $BASELINE"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "cli-help-baseline: $BASELINE not found; run with --update to create it" >&2
  exit 2
fi

if diff -u "$BASELINE" "$tmp"; then
  exit 0
fi
echo "cli-help-baseline: factory --help drifted from $BASELINE (rerun with --update if the change is intended)" >&2
exit 1
