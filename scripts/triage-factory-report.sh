#!/usr/bin/env bash
# Labels a newly opened issue for triage when it is an upstream factory report (#1862).
# Adds only bug, factory:auto-filed and factory:needs-triage, never queue/lane/order
# labels, so the always-on factory cannot claim a report without human approval.
# The issue body is untrusted: it arrives only via the ISSUE_BODY env var.
set -euo pipefail

ISSUE_NUMBER="${ISSUE_NUMBER-}"
REPO="${REPO-}"

if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "invalid ISSUE_NUMBER" >&2
  exit 2
fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "invalid REPO" >&2
  exit 2
fi

TRIAGE_LABELS=(bug factory:auto-filed factory:needs-triage)

# Mirrors upstreamReportMarker in packages/core/src/filing/upstream.ts, which emits the
# marker on its own line.
if ! printf '%s\n' "${ISSUE_BODY-}" | tr -d '\r' |
  grep -Eq '^<!-- factory-upstream-report v1 fp:[A-Za-z0-9_-]{1,64} -->$'; then
  echo "no factory-upstream-report marker; no labels added"
  exit 0
fi

args=()
for label in "${TRIAGE_LABELS[@]}"; do
  args+=(-f "labels[]=$label")
done
gh api -X POST "repos/$REPO/issues/$ISSUE_NUMBER/labels" "${args[@]}" >/dev/null
echo "labeled #$ISSUE_NUMBER: ${TRIAGE_LABELS[*]}"
