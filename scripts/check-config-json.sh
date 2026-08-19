#!/usr/bin/env bash
# Guard (#716): the shipped defaults live in packages/config/src/defaults.ts as typed TS.
# No config JSON may exist under packages/config/src or be emitted into packages/config/dist.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

offenders=""
for dir in packages/config/src packages/config/dist; do
  [ -d "$dir" ] || continue
  found=$(find "$dir" -type f \( -name '*.json' -o -name '*.bak' \) -print)
  if [ -n "$found" ]; then
    offenders="${offenders}${found}"$'\n'
  fi
done

if [ -n "${offenders//[$'\n' ]/}" ]; then
  echo "check-config-json: config JSON must not exist under packages/config/src or dist (#716):" >&2
  echo "$offenders" >&2
  echo "The shipped defaults are typed TypeScript in packages/config/src/defaults.ts." >&2
  exit 1
fi
echo "check-config-json: OK — no config JSON under packages/config/{src,dist}"
