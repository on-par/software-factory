#!/usr/bin/env bash
# Decides whether a release tag can skip the full Verify in publish.yml.
#
# A tag commit is "already verified" when it was squash-merged from a pull request whose head
# has the exact same git tree AND whose CI workflow run on that head concluded success. Branch
# protection requires PR branches to be up to date, so the squash commit's tree normally equals
# the PR head's tree: same code, already gated. Anything else (no PR, tree differs, CI not green,
# any API error) prints verified=false and the caller runs the full Verify. It never fails the job.
#
# Env:
#   SHA            the tagged commit (github.sha)
#   REPO           owner/name (github.repository)
#   GH_TOKEN       token for gh
#   GITHUB_OUTPUT  set by Actions; `verified=true|false` is appended when set
set -uo pipefail

out() {
  echo "verified=$1"
  echo "release-prior-ci: $2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "verified=$1" >>"$GITHUB_OUTPUT"; fi
  exit 0
}

[ -n "${SHA:-}" ] && [ -n "${REPO:-}" ] || out false "SHA and REPO are required"

pr="$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '[.[] | select(.merged_at != null)][0] | "\(.number) \(.head.sha)"' 2>/dev/null)" ||
  out false "could not list pull requests for $SHA"
read -r number head <<<"$pr"
case "$number" in '' | null) out false "$SHA came from no merged pull request" ;; esac

tag_tree="$(gh api "repos/$REPO/commits/$SHA" --jq '.commit.tree.sha' 2>/dev/null)" ||
  out false "could not read the tree of $SHA"
head_tree="$(gh api "repos/$REPO/commits/$head" --jq '.commit.tree.sha' 2>/dev/null)" ||
  out false "could not read the tree of PR #$number head $head"
[ -n "$tag_tree" ] && [ "$tag_tree" = "$head_tree" ] ||
  out false "tree of $SHA differs from PR #$number head $head"

ci="$(gh run list --repo "$REPO" --workflow CI --commit "$head" --json conclusion --jq '[.[].conclusion] | index("success") != null' 2>/dev/null)" ||
  out false "could not list CI runs for $head"
[ "$ci" = "true" ] || out false "PR #$number head $head has no successful CI run"

out true "tree of $SHA equals PR #$number head $head, whose CI passed"
