#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ -z "$1" ]; }; then
  echo "usage: bash scripts/check-cli-json-schemas.sh [reference-directory]" >&2
  exit 2
fi

reference_dir="${1:-packages/cli/schemas}"
if [ ! -d "$reference_dir" ]; then
  echo "check-cli-json-schemas: reference directory does not exist: $reference_dir" >&2
  exit 2
fi

generated_dir=$(mktemp -d)
trap 'rm -rf "$generated_dir"' EXIT
node --import tsx scripts/gen-cli-json-schemas.ts "$generated_dir"
echo "check-cli-json-schemas: comparing regenerated output from: node --import tsx scripts/gen-cli-json-schemas.ts <temporary-directory>"
diff -ru "$reference_dir" "$generated_dir"
echo "check-cli-json-schemas: OK — committed schemas match generated output"
