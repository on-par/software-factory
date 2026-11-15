#!/usr/bin/env bash
# Creates or updates the GitHub release for a stable tag (#4123), run by the `release` job
# of publish.yml after npm published. Every path writes one job-summary line:
#   RELEASE CREATED <tag> (latest|not latest)
#   RELEASE UPDATED <tag> (latest|not latest)
#   NO RELEASE: <tag> is a prerelease      (vX.Y.Z-next.N never gets a release)
#   NOT RELEASED: <reason>                 anything else; the step fails
# The body is the CHANGELOG.md section for the version, the CLI JSON contract notes
# between the previous stable tag and this one, and a compare link. Only the highest
# stable tag is marked Latest. Re-running for the same tag edits the release.
#
# Env:
#   RELEASE_TAG         the tag, from github.ref_name
#   GITHUB_REPOSITORY   owner/name
#   GH_TOKEN            token with contents: write
#   GITHUB_SERVER_URL   default https://github.com
#   GITHUB_STEP_SUMMARY job summary file (optional)
#   GITHUB_OUTPUT       step output file (optional); gets released=true
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${RELEASE_TAG:-}"
server="${GITHUB_SERVER_URL:-https://github.com}"
repo="${GITHUB_REPOSITORY:-}"
reported=false
body=""

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

cleanup() {
  local code=$?
  [ -z "$body" ] || rm -f "$body"
  if [ "$code" -ne 0 ] && [ "$reported" != true ]; then
    summary "NOT RELEASED: the release step failed"
  fi
}
trap cleanup EXIT

not_released() {
  reported=true
  summary "NOT RELEASED: $1"
  exit 1
}

[ -n "$tag" ] || not_released "RELEASE_TAG is empty"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]] || not_released "$tag is not a vX.Y.Z tag"
[ -n "$repo" ] || not_released "GITHUB_REPOSITORY is empty"
case "$tag" in
  *-*)
    reported=true
    summary "NO RELEASE: $tag is a prerelease"
    exit 0
    ;;
esac

version="${tag#v}"
escaped="${version//./\\.}"
body="$(mktemp)"
awk -v re="^## (\\\\[$escaped\\\\]|$escaped)([[:space:]]|\$)" '
  found && /^## / { exit }
  found { print }
  $0 ~ re { found = 1; seen = 1 }
  END { exit seen ? 0 : 3 }
' CHANGELOG.md >"$body.section" || { rm -f "$body.section"; not_released "CHANGELOG.md has no section for $version"; }
awk 'NF { if (!started) started = 1; for (i = 0; i < blanks; i++) print ""; blanks = 0; print; next } started { blanks++ }' \
  "$body.section" >"$body"
rm -f "$body.section"

stable="$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
highest="$(printf '%s\n' "$stable" | head -n 1)"
prev=""
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  [ "$candidate" != "$tag" ] || continue
  if [ "$(printf '%s\n%s\n' "$candidate" "$tag" | sort -V | head -n 1)" = "$candidate" ]; then
    prev="$candidate"
    break
  fi
done <<<"$stable"

latest_flag=--latest=false
latest_text="not latest"
if [ "$highest" = "$tag" ]; then
  latest_flag=--latest
  latest_text=latest
fi

if [ -n "$prev" ]; then
  notes="$(npx tsx scripts/cli-json-contract-notes.ts --from "$prev" --to "$tag")" ||
    not_released "cli-json-contract-notes failed for $prev..$tag"
  {
    echo
    echo "## CLI JSON contract"
    echo
    echo "$notes"
    echo
    echo "**Full changelog**: $server/$repo/compare/$prev...$tag"
  } >>"$body"
else
  {
    echo
    echo "$server/$repo/commits/$tag"
  } >>"$body"
fi

if gh release view "$tag" --repo "$repo" --json tagName >/dev/null 2>&1; then
  gh release edit "$tag" --repo "$repo" --title "$version" --notes-file "$body" \
    "$latest_flag" --prerelease=false
  verb=UPDATED
else
  gh release create "$tag" --repo "$repo" --verify-tag --title "$version" \
    --notes-file "$body" "$latest_flag"
  verb=CREATED
fi

reported=true
summary "RELEASE $verb $tag ($latest_text)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "released=true" >>"$GITHUB_OUTPUT"
fi
