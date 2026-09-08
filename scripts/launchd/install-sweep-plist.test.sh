#!/usr/bin/env bash
# Regression test for install-sweep-plist.sh: proves the rendered plist has
# every __SF_ROOT__/__SF_HOME__ placeholder substituted and never carries a
# hardcoded /Users/ path, by running the real script against a throwaway
# HOME and repo checkout outside /Users/ (issue #1292).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/install-sweep-plist.sh"

FAKE_HOME="$(mktemp -d)"
FAKE_REPO="$(mktemp -d)"

cleanup() {
  rm -rf "$FAKE_HOME" "$FAKE_REPO"
}
trap cleanup EXIT

git init -q "$FAKE_REPO"

rendered_path="$(cd "$FAKE_REPO" && HOME="$FAKE_HOME" bash "$SCRIPT")"

if [ ! -f "$rendered_path" ]; then
  echo "FAIL: expected install-sweep-plist.sh to print the rendered file's path, got: $rendered_path" >&2
  exit 1
fi

case "$rendered_path" in
"$FAKE_HOME"/*) ;;
*)
  echo "FAIL: expected rendered plist under fake HOME ($FAKE_HOME), got: $rendered_path" >&2
  exit 1
  ;;
esac

if grep -q "__SF_ROOT__" "$rendered_path"; then
  echo "FAIL: rendered plist still contains an unsubstituted __SF_ROOT__ placeholder" >&2
  cat "$rendered_path" >&2
  exit 1
fi

if grep -q "__SF_HOME__" "$rendered_path"; then
  echo "FAIL: rendered plist still contains an unsubstituted __SF_HOME__ placeholder" >&2
  cat "$rendered_path" >&2
  exit 1
fi

if grep -q "/Users/" "$rendered_path"; then
  echo "FAIL: rendered plist contains a hardcoded /Users/ path" >&2
  grep "/Users/" "$rendered_path" >&2
  exit 1
fi

if ! grep -qF "$FAKE_REPO/scripts/auto-merge-sweep.sh" "$rendered_path"; then
  echo "FAIL: expected rendered plist to contain the fake repo root ($FAKE_REPO), got:" >&2
  cat "$rendered_path" >&2
  exit 1
fi

if ! grep -qF "$FAKE_HOME/Library/Logs/auto-merge-sweep.log" "$rendered_path"; then
  echo "FAIL: expected rendered plist to contain the fake HOME ($FAKE_HOME), got:" >&2
  cat "$rendered_path" >&2
  exit 1
fi

echo "PASS: install-sweep-plist.sh substitutes __SF_ROOT__/__SF_HOME__ fully and never leaks a /Users/ path"
