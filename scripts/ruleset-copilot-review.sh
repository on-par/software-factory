#!/usr/bin/env bash
# Idempotent apply + verify for enabling automatic Copilot code review on the
# protect-main branch ruleset (issue #150), following the settings-as-code
# pattern of scripts/repo-merge-settings.sh: an env-overridable config block,
# a read-modify-write apply(), and a verify() that fails loudly naming the
# drifted field.
#
# A ruleset PUT replaces the whole `rules` array, so apply() first GETs the
# full ruleset and preserves every rule and bypass_actors entry untouched,
# flipping on only automatic_copilot_code_review_enabled inside the
# pull_request rule's parameters.
#
# Automatic Copilot code review requires an active Copilot subscription. On
# an org with no Copilot seats, GitHub may reject the PUT or silently drop
# the parameter — verify() reports that as a MISMATCH naming the likely
# cause, which is the documented unavailability signal for #150.
#
# All config below is env-overridable, each defined exactly once:
#   REPO           GitHub repo as owner/name (default: on-par/software-factory)
#   RULESET_NAME   name of the branch ruleset to modify (default: protect-main)
#   DRY_RUN        when "1", print the would-be PUT command instead of executing it
set -euo pipefail

REPO="${REPO:-on-par/software-factory}"
RULESET_NAME="${RULESET_NAME:-protect-main}"
DRY_RUN="${DRY_RUN:-0}"

resolve_ruleset_id() {
  local id
  id="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="'"$RULESET_NAME"'") | .id')"
  if [ -z "$id" ]; then
    echo "ERROR: no ruleset named '$RULESET_NAME' found on $REPO" >&2
    return 1
  fi
  echo "$id"
}

build_body() {
  local id="$1"
  gh api "repos/$REPO/rulesets/$id" --jq '{
    name, target, enforcement,
    conditions,
    bypass_actors: (.bypass_actors // []),
    rules: (.rules | map(
      if .type == "pull_request"
      then .parameters.automatic_copilot_code_review_enabled = true
      else . end))
  }'
}

apply() {
  local id body
  id="$(resolve_ruleset_id)"
  body="$(build_body "$id")"

  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN: gh api -X PUT repos/$REPO/rulesets/$id --input -"
    echo "$body"
    return 0
  fi

  printf '%s' "$body" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null
}

verify() {
  local id actual
  id="$(resolve_ruleset_id)"
  actual="$(gh api "repos/$REPO/rulesets/$id" --jq \
    '.rules[] | select(.type=="pull_request") | .parameters.automatic_copilot_code_review_enabled | if . == null then "" else (.|tostring) end')"

  if [ "$actual" != "true" ]; then
    echo "MISMATCH: automatic_copilot_code_review_enabled expected=true actual=${actual:-}" >&2
    echo "Likely cause: automatic Copilot code review requires an active Copilot" >&2
    echo "subscription; GitHub can silently drop or reject this parameter when the" >&2
    echo "org has no Copilot seats (free plan / 0 seats)." >&2
    return 1
  fi

  echo "PASS: $REPO ruleset $RULESET_NAME requests Copilot code review automatically"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  apply
  if [ "$DRY_RUN" = "1" ]; then
    exit 0
  fi
  verify
fi
