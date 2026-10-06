#!/usr/bin/env bash
# Idempotent apply + verify for issue optics (issue #2159): the triage labels
# dogfood, oss-public and icebox, plus one short pinned visitor-facing issue that
# explains most open issues are factory dogfood backlog. This script never
# closes, deletes, transfers or bulk-labels any issue (it only touches its own
# visitor issue) and never deletes a label.
#
# Re-running creates no second issue and no second pin: the visitor issue is
# found by exact title, its body is refreshed, and the pin is skipped when
# already pinned. Run by a maintainer after merge; BUILD must not run it without
# DRY_RUN=1 (ADR-0138).
#
# Env overrides:
#   REPO      GitHub repo as owner/name (default: on-par/software-factory)
#   DRY_RUN   when "1", print the would-be mutating commands instead of running them
set -euo pipefail

REPO="${REPO:-on-par/software-factory}"
DRY_RUN="${DRY_RUN:-0}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

LABELS=(dogfood oss-public icebox)
LABEL_COLORS=(c5def5 0e8a16 d4c5f9)
LABEL_DESCS=(
  'Factory dogfood backlog: filed by the maintainer for the factory to ship'
  'Written for outside contributors and readers'
  'Parked idea: no current plan to work on it'
)

ISSUE_TITLE='Visitors: most open issues here are factory dogfood backlog'
ISSUE_LABELS=(oss-public documentation)
ISSUE_BODY="$(cat <<BODY
Software Factory ships its own development. The maintainer files most open issues as backlog for the factory pipeline (PLAN → BUILD → CHECK → SHIP), which picks them up and opens PRs. A large open count is that work queue, not neglect.

## Where to start

- [oss-public](https://github.com/$REPO/labels/oss-public): issues written for outside readers and contributors
- [good first issue](https://github.com/$REPO/labels/good%20first%20issue): small, approachable tasks

## What the labels mean

- \`dogfood\`: factory backlog, filed for the factory to ship
- \`icebox\`: a parked idea with no current plan

## Contributing and contact

- Contributing: see CONTRIBUTING.md
- Security reports: see SECURITY.md, do not file a public issue
- Questions: open an issue, since Discussions is not enabled
BODY
)"

ensure_labels() {
  local i
  for i in "${!LABELS[@]}"; do
    if [ "$DRY_RUN" = "1" ]; then
      echo "DRY_RUN: gh label create ${LABELS[$i]} --repo $REPO --color ${LABEL_COLORS[$i]} --description ${LABEL_DESCS[$i]} --force"
      continue
    fi
    gh label create "${LABELS[$i]}" --repo "$REPO" --color "${LABEL_COLORS[$i]}" \
      --description "${LABEL_DESCS[$i]}" --force >/dev/null
  done
}

# Read-only; exact title compare only (the search is a substring match).
find_issue_number() {
  gh issue list --repo "$REPO" --state open --search "\"$ISSUE_TITLE\" in:title" \
    --json number,title --jq ".[] | select(.title == \"$ISSUE_TITLE\") | .number" | head -n1
}

# Read-only; prints "<number><TAB><title>" per pinned issue.
pinned_titles() {
  gh api graphql -f query="query { repository(owner:\"$OWNER\", name:\"$NAME\") { pinnedIssues(first:10) { nodes { issue { number title } } } } }" \
    --jq '.data.repository.pinnedIssues.nodes[].issue | "\(.number)\t\(.title)"'
}

ensure_pinned_issue() {
  local number url
  number="$(find_issue_number)"

  if [ -z "$number" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "DRY_RUN: gh issue create --repo $REPO --title $ISSUE_TITLE --label ${ISSUE_LABELS[0]} --label ${ISSUE_LABELS[1]}"
      echo "DRY_RUN: gh issue pin <new> --repo $REPO"
      return 0
    fi
    url="$(printf '%s\n' "$ISSUE_BODY" | gh issue create --repo "$REPO" --title "$ISSUE_TITLE" \
      --body-file - --label "${ISSUE_LABELS[0]}" --label "${ISSUE_LABELS[1]}")"
    number="${url##*/}"
    if ! [[ "$number" =~ ^[0-9]+$ ]]; then
      echo "ERROR: could not parse issue number from: $url" >&2
      return 1
    fi
  elif [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: gh issue edit $number --repo $REPO --body-file - --add-label ${ISSUE_LABELS[0]} --add-label ${ISSUE_LABELS[1]}"
  else
    printf '%s\n' "$ISSUE_BODY" | gh issue edit "$number" --repo "$REPO" --body-file - \
      --add-label "${ISSUE_LABELS[0]}" --add-label "${ISSUE_LABELS[1]}" >/dev/null
  fi

  if pinned_titles | grep -q "^${number}"$'\t'; then
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: gh issue pin $number --repo $REPO"
    return 0
  fi
  gh issue pin "$number" --repo "$REPO" >/dev/null
}

apply() {
  ensure_labels
  ensure_pinned_issue
}

verify() {
  local live name mismatch=0
  live="$(gh label list --repo "$REPO" --limit 500 --json name --jq '.[].name')"
  for name in "${LABELS[@]}"; do
    if ! grep -qxF -- "$name" <<<"$live"; then
      echo "MISMATCH: label $name missing" >&2
      mismatch=1
    fi
  done

  local pinned number="" n t
  pinned="$(pinned_titles)"
  while IFS=$'\t' read -r n t; do
    if [ "$t" = "$ISSUE_TITLE" ]; then
      number="$n"
    fi
  done <<<"$pinned"
  if [ -z "$number" ]; then
    echo "MISMATCH: no pinned issue titled '$ISSUE_TITLE'" >&2
    mismatch=1
  fi
  if [ "$mismatch" -ne 0 ]; then
    return 1
  fi

  echo "PASS: $REPO issue optics confirmed — labels $(IFS=,; echo "${LABELS[*]}"); pinned issue #$number"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  apply
  if [ "$DRY_RUN" = "1" ]; then
    exit 0
  fi
  verify
fi
