#!/usr/bin/env bash
# lib/constitution.sh — Constitution loading and enforcement.
#
# Loads a product constitution, makes it available to each phase, and
# provides functions to extract standards, checkers, and dispute rules.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(dirname "$SCRIPT_DIR")"
CONSTITUTIONS_DIR="${FACTORY_CONSTITUTIONS_DIR:-$FACTORY_ROOT/constitutions}"

# Load a constitution by product name: constitution_load <product>
# Echoes the full constitution markdown on stdout.
constitution_load() {
  local product="$1" file="$CONSTITUTIONS_DIR/$1.md"
  [ ! -f "$file" ] && { echo "ERROR: no constitution for '$product' at $file" >&2; return 1; }
  cat "$file"
}

# Extract the frontmatter as JSON: constitution_frontmatter <product>
constitution_frontmatter() {
  local file="$CONSTITUTIONS_DIR/$1.md"
  [ ! -f "$file" ] && return 1
  # Extract YAML frontmatter between --- markers and convert key: value to JSON
  awk '/^---$/{n++; next} n==1{print}' "$file" | \
    jq -R -s 'split("\n") | map(select(length > 0)) | map(
      capture("^(?<k>[a-zA-Z_]+):\\s*(?<v>.*)$") // empty
    ) | from_entries // {}' 2>/dev/null || echo '{}'
}

# List checkers for a product: constitution_checkers <product>
constitution_checkers() {
  local file="$CONSTITUTIONS_DIR/$1.md"
  [ ! -f "$file" ] && return 1
  # Extract checkers from frontmatter (may be inline list or array)
  awk '/^---$/{n++; next} n==1 && /^checkers:/{p=1; sub(/^checkers:/, "", $0); gsub(/^[[:space:]]+/, "", $0); if($0!=""){print $0}; next} n==1 && p && /^[[:space:]]+- /{gsub(/^[[:space:]]+- /, "", $0); print; next} n==1 && p && /^[a-zA-Z]/{p=0} n>=2{exit}' "$file"
}

# Get the enforced phases: constitution_phases <product>
constitution_phases() {
  local file="$CONSTITUTIONS_DIR/$1.md"
  [ ! -f "$file" ] && return 1
  awk '/^---$/{n++; next} n==1 && /^enforced_on:/{gsub(/^enforced_on:[[:space:]]*/, "", $0); gsub(/[\[\]]/, "", $0); gsub(/,[[:space:]]*/, "\n", $0); print; exit}' "$file"
}

# Check if a phase should use this constitution: constitution_enforced_in <product> <phase>
constitution_enforced_in() {
  local product="$1" phase="$2"
  constitution_phases "$product" | grep -q "$phase"
}

# Extract the body (standards + rules) without frontmatter: constitution_body <product>
constitution_body() {
  local file="$CONSTITUTIONS_DIR/$1.md"
  [ ! -f "$file" ] && return 1
  # Skip frontmatter, print everything after the second ---
  awk '/^---$/{n++; if(n==2){p=1; next}} p{print}' "$file"
}

# Build the constitution context for a prompt.
# Includes the standards and dispute rules, formatted for injection into
# PLAN/BUILD/CHECK prompts: constitution_context <product>
constitution_context() {
  local product="$1"
  local body
  body="$(constitution_body "$product")"
  [ -z "$body" ] && return 1

  cat <<EOF
<constitution product="$product">

$body

</constitution>

IMPORTANT: The constitution above is the written standard for "$product".
Every piece of work must satisfy these standards. Checkers will verify
your output against them — not against your self-report. If a checker
flags your work, refer to the Dispute Rules section to understand how
to escalate.

EOF
}

# List available products (constitutions): constitution_products
constitution_products() {
  ls "$CONSTITUTIONS_DIR"/*.md 2>/dev/null | xargs -I{} basename {} .md | grep -v '^_'
}