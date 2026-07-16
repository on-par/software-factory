#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm ci
npm run build
npm run typecheck
npm run lint
npm run test
npm run coverage-ratchet
npm run eval -- --stub
