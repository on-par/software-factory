#!/usr/bin/env bash
# Lockstep release version for the published @on-par packages (#2244).
#
#   set-release-version.sh <version>   set `version` in every package listed in
#                                      scripts/publish-workspaces.txt and pin each
#                                      @on-par/* dependency between them to exactly
#                                      <version> (no caret, so pre-releases resolve)
#   set-release-version.sh --current   print the version the listed packages share
#
# Both fail, naming the odd package(s) out, when the listed packages do not share one
# version (lockstep check). The set form only edits package.json files in the working
# tree. publish.yml runs it in CI from the tag name; pre-release versions are never
# committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: set-release-version.sh <version> | --current" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  --current) ;;
  -*) usage ;;
  *)
    [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
      echo "set-release-version: '$1' is not a semver version (X.Y.Z or X.Y.Z-pre)" >&2
      exit 2
    }
    ;;
esac

node - "$1" <<'JS'
const fs = require("fs");
const path = require("path");
const arg = process.argv[2];
const files = {};
for (const d of fs.readdirSync("packages")) {
  const f = path.join("packages", d, "package.json");
  if (fs.existsSync(f)) files[JSON.parse(fs.readFileSync(f, "utf8")).name] = f;
}
const names = fs.readFileSync("scripts/publish-workspaces.txt", "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);
const pkgs = names.map((name) => {
  if (!files[name]) {
    console.error(`set-release-version: no package.json for ${name}`);
    process.exit(1);
  }
  return { name, file: files[name], json: JSON.parse(fs.readFileSync(files[name], "utf8")) };
});

// Lockstep: the most common version is the baseline; every other package is named.
const counts = {};
for (const p of pkgs) counts[p.json.version] = (counts[p.json.version] || 0) + 1;
const current = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
const drift = pkgs.filter((p) => p.json.version !== current);
if (drift.length) {
  const list = drift.map((p) => `${p.name}@${p.json.version}`).join(", ");
  console.error(`set-release-version: packages are not in lockstep at ${current}: ${list}`);
  process.exit(1);
}
if (arg === "--current") {
  console.log(current);
  process.exit(0);
}

const published = new Set(names);
for (const p of pkgs) {
  p.json.version = arg;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(p.json[field] || {})) {
      if (published.has(dep)) p.json[field][dep] = arg;
    }
  }
  fs.writeFileSync(p.file, JSON.stringify(p.json, null, 2) + "\n");
  console.log(`${p.name}@${arg}`);
}
JS
