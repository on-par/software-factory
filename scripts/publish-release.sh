#!/usr/bin/env bash
# Runs the "Publish to npm" step of publish.yml (#2335). A skipped or failed publish
# can never show green: every path ends with exactly one job-summary line and a
# `published=true|false` step output.
#   PUBLISHED <name@version ...>   all packages in scripts/publish-workspaces.txt went out
#   NOT PUBLISHED: <reason>        anything else; the step fails unless it was a dry run
#
# Env:
#   PUBLISH_DRY_RUN=true   run `publish-workspaces.sh --dry-run` only (green, never publishes)
#   GITHUB_REF             must be refs/tags/v* for a real publish
#   PUBLISH_BLOCKERS       issue numbers that must be CLOSED before a real publish
#                          (default "195 151", the v1.0 blockers)
#   GITHUB_REPOSITORY      repo for the blocker lookups (gh issue view --repo)
#   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY   set by Actions; ignored when unset
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

set_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "published=$1" >>"$GITHUB_OUTPUT"; fi
}

# not_published <reason> <exit code>
not_published() {
  summary "NOT PUBLISHED: $1"
  set_output false
  exit "$2"
}

if [ "${PUBLISH_DRY_RUN:-}" = "true" ]; then
  bash scripts/publish-workspaces.sh --dry-run || not_published "dry-run failed" 1
  not_published "dry-run, not published" 0
fi

ref="${GITHUB_REF:-}"
case "$ref" in
  refs/tags/v*) ;;
  *) not_published "${ref:-no ref} is not a release tag (refs/tags/v*)" 1 ;;
esac

open=""
for n in ${PUBLISH_BLOCKERS-195 151}; do
  state="$(gh issue view "$n" --repo "${GITHUB_REPOSITORY:-}" --json state -q .state)" ||
    not_published "could not read the state of blocker #$n" 1
  echo "issue #$n: $state"
  [ "$state" = "CLOSED" ] || open="$open #$n"
done
[ -z "$open" ] || not_published "v1.0 blockers still open:$open" 1

bash scripts/publish-workspaces.sh ||
  not_published "npm publish failed; packages before the failing one in scripts/publish-workspaces.txt may already be on the registry" 1

# name@version for every package in the list, read from its packages/*/package.json.
published="$(node -e '
const fs = require("fs");
const path = require("path");
const versions = {};
for (const d of fs.readdirSync("packages")) {
  const f = path.join("packages", d, "package.json");
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  versions[j.name] = j.version;
}
const out = fs.readFileSync("scripts/publish-workspaces.txt", "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((n) => {
    if (!versions[n]) throw new Error("no package.json version for " + n);
    return n + "@" + versions[n];
  });
process.stdout.write(out.join(" "));
')" || not_published "npm publish succeeded but the package versions could not be read" 1

summary "PUBLISHED $published"
set_output true
