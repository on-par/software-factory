#!/usr/bin/env bash
# Files or updates the single tracking issue for a failing nightly workflow (same
# find-by-title-and-label logic as nightly-integration.yml, but testable).
# Env: TITLE, BODY_FILE, RUN_URL (required); LABEL (default: ci).
set -euo pipefail

LABEL="${LABEL:-ci}"
if [ -z "${TITLE:-}" ] || [ -z "${BODY_FILE:-}" ] || [ -z "${RUN_URL:-}" ]; then
  echo "usage: TITLE=... BODY_FILE=... RUN_URL=... [LABEL=ci] $0" >&2
  exit 2
fi

existing=$(gh issue list --state open --label "$LABEL" --json number,title \
  --jq "[.[] | select(.title == \"$TITLE\")][0].number // empty")
if [ -n "$existing" ]; then
  gh issue edit "$existing" --body-file "$BODY_FILE"
  gh issue comment "$existing" --body "Still failing as of $RUN_URL"
  echo "updated existing issue #$existing"
else
  gh issue create --label "$LABEL" --title "$TITLE" --body-file "$BODY_FILE"
fi
