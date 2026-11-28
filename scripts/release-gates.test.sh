#!/usr/bin/env bash
# Tests the release gates: factory-core publishes first and must resolve on the registry
# before the other six publish (publish-workspaces.sh), everything goes out under the
# `staging` dist-tag and promote-release.sh moves latest/next only after a fresh-container
# install, and release-drift-check.sh checks every package in publish-workspaces.txt.
# Each case runs in a subshell against a scratch copy of the scripts with stub `npm`,
# `docker`, `gh` and `sleep` on PATH; the file ends with a pass/fail tally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

CASE=""
fail() {
  echo "FAIL: ${CASE}: $*" >&2
  exit 1
}

REPO="$WORK/repo"
STATE="$WORK/state"
BINDIR="$WORK/bin"
export STATE
mkdir -p "$BINDIR"

fresh_repo() {
  rm -rf "$REPO" "$STATE"
  mkdir -p "$REPO/scripts" "$STATE/published"
  local f d
  for f in publish-release.sh publish-workspaces.sh set-release-version.sh publish-workspaces.txt \
    promote-release.sh release-drift-check.sh; do
    [ ! -f "$ROOT/scripts/$f" ] || cp "$ROOT/scripts/$f" "$REPO/scripts/"
  done
  for f in "$ROOT"/packages/*/package.json; do
    d="$(basename "$(dirname "$f")")"
    mkdir -p "$REPO/packages/$d"
    cp "$f" "$REPO/packages/$d/package.json"
  done
  printf '# Changelog\n\n## 0.9.0 - 2026-10-11\n' >"$REPO/CHANGELOG.md"
  : >"$STATE/npm.log"
  : >"$STATE/docker.log"
  : >"$STATE/sleep.log"
  : >"$STATE/summary"
  : >"$STATE/output"
}

# Stub npm. `view <pkg>@<v> version` resolves once <pkg> was really published (not
# --dry-run); CORE_NEVER_VISIBLE=1 keeps factory-core missing, CORE_VISIBLE_AFTER=<k>
# makes factory-core resolve on its k-th read. A republish with NPM_E403=1 answers
# "cannot publish over". `view <pkg> dist-tags.latest` prints NPM_LATEST, or NPM_OLD for
# the package named in NPM_BEHIND. NPM_FAIL_ON fails any call containing it.
cat >"$BINDIR/npm" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STATE/npm.log"
[ -z "${NPM_FAIL_ON:-}" ] || case "$*" in *"$NPM_FAIL_ON"*) echo "npm error code E500" >&2; exit 1 ;; esac
key() { echo "$STATE/published/${1//\//__}"; }
case "$1" in
  --version) echo 11.21.3 ;;
  view)
    if [ "$3" = version ]; then
      name="${2%@*}"
      v="${2##*@}"
      if [ "$name" = @on-par/factory-core ]; then
        [ "${CORE_NEVER_VISIBLE:-}" != 1 ] || exit 1
        if [ -n "${CORE_VISIBLE_AFTER:-}" ]; then
          n=$(($(cat "$STATE/core-reads" 2>/dev/null || echo 0) + 1))
          echo "$n" >"$STATE/core-reads"
          [ "$n" -ge "$CORE_VISIBLE_AFTER" ] || exit 1
          echo "$v"
          exit 0
        fi
      fi
      [ -f "$(key "$name")" ] || exit 1
      echo "$v"
    elif [ "$3" = dist-tags.latest ]; then
      if [ "$2" = "${NPM_BEHIND:-}" ]; then echo "${NPM_OLD:-0.9.47}"; exit 0; fi
      [ -n "${NPM_LATEST:-}" ] || exit 1
      echo "$NPM_LATEST"
    else
      exit 1
    fi
    ;;
  publish)
    case " $* " in *" --dry-run "*) exit 0 ;; esac
    if [ -f "$(key "$3")" ] && [ "${NPM_E403:-}" = 1 ]; then
      printf 'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/%s - You cannot publish over the previously published versions: 0.9.0.\n' "$3" >&2
      exit 1
    fi
    touch "$(key "$3")"
    ;;
esac
exit 0
STUB
# Stub docker: fails while DOCKER_FAIL=1 or before run DOCKER_OK_AFTER, else prints DOCKER_PRINTS.
cat >"$BINDIR/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STATE/docker.log"
n=$(($(cat "$STATE/docker-runs" 2>/dev/null || echo 0) + 1))
echo "$n" >"$STATE/docker-runs"
if [ "${DOCKER_FAIL:-}" = 1 ] || [ "$n" -lt "${DOCKER_OK_AFTER:-1}" ]; then
  echo "npm error code ETARGET" >&2
  exit 1
fi
echo "${DOCKER_PRINTS:-}"
STUB
cat >"$BINDIR/gh" <<'STUB'
#!/usr/bin/env bash
[ -n "${GH_LATEST:-}" ] || exit 1
echo "$GH_LATEST"
STUB
cat >"$BINDIR/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >>"$STATE/sleep.log"
STUB
chmod +x "$BINDIR/npm" "$BINDIR/docker" "$BINDIR/gh" "$BINDIR/sleep"
export PATH="$BINDIR:$PATH"

NAMES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line//$'\r'/}"
  [ -n "${line// /}" ] && NAMES+=("$line")
done <"$ROOT/scripts/publish-workspaces.txt"
CORE=@on-par/factory-core
OTHERS=()
for n in "${NAMES[@]}"; do [ "$n" = "$CORE" ] || OTHERS+=("$n"); done

GOT=0
# run <script> [VAR=value | arg ...]: runs a scratch-repo script with the VAR=value env and
# the other words as its args; the exit code lands in GOT.
run() {
  local script="$1" vars=() args=() a
  shift
  for a in "$@"; do
    if [[ "$a" =~ ^[A-Z_]+= ]]; then vars+=("$a"); else args+=("$a"); fi
  done
  GOT=0
  env -u PUBLISH_DRY_RUN -u PUBLISH_PRERELEASE -u PUBLISH_BLOCKERS -u DRIFT_ATTEMPTS -u DRIFT_SLEEP \
    GITHUB_STEP_SUMMARY="$STATE/summary" GITHUB_OUTPUT="$STATE/output" GITHUB_REPOSITORY=on-par/software-factory \
    PUBLISH_BLOCKERS= ${vars[@]+"${vars[@]}"} bash "$REPO/scripts/$script" ${args[@]+"${args[@]}"} >"$STATE/stdout" 2>&1 || GOT=$?
}
expect_exit() {
  [ "$GOT" = "$1" ] || { cat "$STATE/stdout" >&2; fail "exit $GOT, want $1"; }
}
real_publishes() {
  grep '^publish ' "$STATE/npm.log" | grep -v -- '--dry-run' || true
}
dist_tags() {
  grep '^dist-tag ' "$STATE/npm.log" || true
}

PASSED=0
FAILED=0
spec() {
  CASE="$1"
  if ("$2"); then
    PASSED=$((PASSED + 1))
    echo "PASS: $1"
  else
    FAILED=$((FAILED + 1))
  fi
}

core_missing_blocks_the_rest() {
  fresh_repo
  run publish-release.sh GITHUB_REF=refs/tags/v0.9.0 CORE_NEVER_VISIBLE=1 PUBLISH_CORE_TIMEOUT=0
  expect_exit 1
  [ "$(real_publishes | grep -vc -- "--workspace $CORE " || true)" = 0 ] || fail "published past core: $(real_publishes)"
  [ "$(real_publishes | grep -c -- "--workspace $CORE ")" -ge 1 ] || fail "core was never published"
  grep -q "NOT PUBLISHED: $CORE@0.9.0 never resolved on the registry" "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
  grep -qx 'published=false' "$STATE/output" || fail "output: $(cat "$STATE/output")"
  [ ! -s "$STATE/docker.log" ] && [ -z "$(dist_tags)" ] || fail "promoted after a failed publish"
}

core_resolves_after_polls() {
  fresh_repo
  run publish-workspaces.sh --tag staging CORE_VISIBLE_AFTER=4 PUBLISH_CORE_TIMEOUT=600 PUBLISH_CORE_INTERVAL=20
  expect_exit 0
  local want="publish --workspace $CORE --tag staging --provenance" n
  for n in "${OTHERS[@]}"; do want="$want"$'\n'"publish --workspace $n --tag staging --provenance"; done
  [ "$(real_publishes)" = "$want" ] || fail "publishes: $(real_publishes)"
  [ "$(cat "$STATE/core-reads")" = 4 ] || fail "core reads: $(cat "$STATE/core-reads")"
  [ "$(cat "$STATE/sleep.log")" = $'20\n20' ] || fail "sleeps: $(cat "$STATE/sleep.log")"
  local core_view first_other
  core_view="$(grep -n "^view $CORE@" "$STATE/npm.log" | tail -n 1 | cut -d: -f1)"
  first_other="$(grep -n "^publish --workspace ${OTHERS[0]} " "$STATE/npm.log" | cut -d: -f1)"
  [ "$core_view" -lt "$first_other" ] || fail "an other package published before core resolved"
}

republish_stops_at_n() {
  fresh_repo
  run publish-workspaces.sh --tag staging CORE_NEVER_VISIBLE=1 NPM_E403=1 \
    PUBLISH_CORE_TIMEOUT=40 PUBLISH_CORE_INTERVAL=20 PUBLISH_CORE_REPUBLISH=2
  [ "$GOT" != 0 ] || fail "exited 0 with core missing"
  [ "$(real_publishes | grep -c -- "--workspace $CORE ")" = 3 ] || fail "core publishes: $(real_publishes)"
  [ "$(real_publishes | grep -vc -- "--workspace $CORE " || true)" = 0 ] || fail "published past core"
  [ "$(grep -c . "$STATE/sleep.log")" = 6 ] || fail "sleeps: $(grep -c . "$STATE/sleep.log")"
}

e403_counts_as_published() {
  fresh_repo
  run publish-workspaces.sh --tag staging CORE_VISIBLE_AFTER=5 NPM_E403=1 \
    PUBLISH_CORE_TIMEOUT=20 PUBLISH_CORE_INTERVAL=20 PUBLISH_CORE_REPUBLISH=3
  expect_exit 0
  [ "$(real_publishes | grep -c -- "--workspace $CORE ")" = 2 ] || fail "core publishes: $(real_publishes)"
  [ "$(real_publishes | grep -c .)" = 8 ] || fail "publishes: $(real_publishes)"
}

dry_run_exercises_the_order() {
  fresh_repo
  run publish-release.sh PUBLISH_DRY_RUN=true GITHUB_REF=refs/heads/main
  expect_exit 0
  grep -qx 'NOT PUBLISHED: dry-run, not published' "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
  local want="publish --workspace $CORE --tag staging --provenance --dry-run" n
  for n in "${OTHERS[@]}"; do want="$want"$'\n'"publish --workspace $n --tag staging --provenance --dry-run"; done
  [ "$(grep '^publish ' "$STATE/npm.log")" = "$want" ] || fail "publishes: $(grep '^publish ' "$STATE/npm.log")"
  [ ! -s "$STATE/sleep.log" ] || fail "a dry run waited on the registry"
}

tag_publishes_to_staging_only() {
  fresh_repo
  run publish-release.sh GITHUB_REF=refs/tags/v0.9.0
  expect_exit 0
  [ "$(real_publishes | grep -c -- '--tag staging --provenance$')" = 7 ] || fail "publishes: $(real_publishes)"
  [ "$(real_publishes | head -n 1)" = "publish --workspace $CORE --tag staging --provenance" ] || fail "core was not first"
  [ -z "$(dist_tags)" ] || fail "publish moved a dist-tag"
  grep -qx 'published=true' "$STATE/output" && grep -qx 'version=0.9.0' "$STATE/output" || fail "output: $(cat "$STATE/output")"
}

failed_install_keeps_the_final_tag() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_FAIL=1 PROMOTE_INSTALL_ATTEMPTS=2 PROMOTE_INSTALL_SLEEP=5
  expect_exit 1
  [ -z "$(dist_tags)" ] || fail "moved a dist-tag: $(dist_tags)"
  [ "$(cat "$STATE/docker-runs")" = 2 ] || fail "docker runs: $(cat "$STATE/docker-runs")"
  grep -q '^NOT PROMOTED: .*@on-par/factory-cli@0.9.0' "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
}

wrong_version_keeps_the_final_tag() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_PRINTS=0.8.9 PROMOTE_INSTALL_ATTEMPTS=1
  expect_exit 1
  [ -z "$(dist_tags)" ] || fail "moved a dist-tag: $(dist_tags)"
  grep -q '^NOT PROMOTED: ' "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
}

install_runs_in_a_fresh_container() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_PRINTS=0.9.0
  expect_exit 0
  grep -qE '^run --rm node:[0-9]+' "$STATE/docker.log" || fail "docker: $(cat "$STATE/docker.log")"
  grep -q 'npm install -g' "$STATE/docker.log" && grep -q '@on-par/factory-cli@0.9.0' "$STATE/docker.log" &&
    grep -q 'factory --version' "$STATE/docker.log" || fail "docker: $(cat "$STATE/docker.log")"
}

success_moves_latest_for_all() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_PRINTS=0.9.0
  expect_exit 0
  local want="" n
  for n in "${NAMES[@]}"; do want="${want}dist-tag add $n@0.9.0 latest"$'\n'; done
  [ "$(dist_tags)" = "${want%$'\n'}" ] || fail "dist-tags: $(dist_tags)"
  grep -q '^PROMOTED .* to latest$' "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
}

prerelease_moves_next() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.1-next.2 DOCKER_PRINTS=0.9.1-next.2
  expect_exit 0
  [ "$(dist_tags | grep -c ' next$')" = 7 ] || fail "dist-tags: $(dist_tags)"
}

install_retries_until_visible() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_PRINTS=0.9.0 DOCKER_OK_AFTER=3 PROMOTE_INSTALL_SLEEP=7
  expect_exit 0
  [ "$(cat "$STATE/sleep.log")" = $'7\n7' ] || fail "sleeps: $(cat "$STATE/sleep.log")"
  [ "$(dist_tags | grep -c .)" = 7 ] || fail "dist-tags: $(dist_tags)"
}

dist_tag_failure_fails() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=0.9.0 DOCKER_PRINTS=0.9.0 NPM_FAIL_ON="dist-tag add $CORE@"
  expect_exit 1
  grep -q "^NOT PROMOTED: .*$CORE" "$STATE/summary" || fail "summary: $(cat "$STATE/summary")"
}

promote_needs_a_version() {
  fresh_repo
  run promote-release.sh PROMOTE_VERSION=
  expect_exit 1
  [ ! -s "$STATE/docker.log" ] || fail "ran docker"
}

drift_in_sync_reads_all() {
  fresh_repo
  run release-drift-check.sh NPM_LATEST=0.9.0 GH_LATEST=v0.9.0 DRIFT_ATTEMPTS=1
  expect_exit 0
  local n
  for n in "${NAMES[@]}"; do grep -qx "view $n dist-tags.latest" "$STATE/npm.log" || fail "did not read $n"; done
}

drift_any_one_behind() {
  local n
  for n in "${NAMES[@]}"; do
    fresh_repo
    run release-drift-check.sh NPM_LATEST=0.9.0 NPM_BEHIND="$n" GH_LATEST=v0.9.0 DRIFT_ATTEMPTS=1
    expect_exit 1
    grep -q "RELEASE DRIFT" "$STATE/summary" && grep -q "$n" "$STATE/summary" || fail "$n behind: $(cat "$STATE/summary")"
  done
}

drift_reads_the_list() {
  fresh_repo
  printf '%s\n' @on-par/contracts @on-par/factory-cli >"$REPO/scripts/publish-workspaces.txt"
  run release-drift-check.sh NPM_LATEST=0.9.0 GH_LATEST=v0.9.0 DRIFT_ATTEMPTS=1
  expect_exit 0
  [ "$(grep -c 'dist-tags.latest' "$STATE/npm.log")" = 2 ] || fail "reads: $(cat "$STATE/npm.log")"
}

drift_waits_minutes_by_default() {
  fresh_repo
  run release-drift-check.sh NPM_LATEST=0.9.0 NPM_BEHIND="$CORE" GH_LATEST=v0.9.0
  expect_exit 1
  local total=0 s
  while IFS= read -r s; do total=$((total + s)); done <"$STATE/sleep.log"
  [ "$total" -ge 480 ] && [ "$total" -le 720 ] || fail "waited ${total}s in total"
  [ "$(grep -c . "$STATE/sleep.log")" -ge 10 ] || fail "only $(grep -c . "$STATE/sleep.log") retries"
}

spec "missing factory-core blocks the other six and exits 1" core_missing_blocks_the_rest
spec "factory-core resolving after N polls lets the rest publish" core_resolves_after_polls
spec "republish on missing core stops at N" republish_stops_at_n
spec "a cannot-publish-over answer counts as published" e403_counts_as_published
spec "a dry run exercises core-first under staging without waiting" dry_run_exercises_the_order
spec "a tag publishes all seven to staging and moves no dist-tag" tag_publishes_to_staging_only
spec "a failed fresh-container install leaves the final tag and exits 1" failed_install_keeps_the_final_tag
spec "an install printing the wrong version leaves the final tag" wrong_version_keeps_the_final_tag
spec "the install check runs npm install -g and factory --version in a clean node container" install_runs_in_a_fresh_container
spec "a successful install moves latest for all seven" success_moves_latest_for_all
spec "a prerelease moves next for all seven" prerelease_moves_next
spec "the install check retries until the CLI is visible" install_retries_until_visible
spec "a failed dist-tag move fails the run" dist_tag_failure_fails
spec "promote needs a version" promote_needs_a_version
spec "drift check passes when all seven match" drift_in_sync_reads_all
spec "drift check fails when any one of the seven is behind" drift_any_one_behind
spec "drift check reads publish-workspaces.txt" drift_reads_the_list
spec "drift check waits several minutes by default" drift_waits_minutes_by_default

echo "release-gates: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
