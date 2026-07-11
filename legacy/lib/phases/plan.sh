#!/usr/bin/env bash
# lib/phases/plan.sh — PLAN phase.
#
# The boss model reads the issue, explores the repo, loads the constitution,
# freezes a written spec, and picks a build route (codex or claude).
# This is judgment-and-spec work only — no implementation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source dependencies
[ -f "$FACTORY_ROOT/lib/router.sh" ] && . "$FACTORY_ROOT/lib/router.sh"
[ -f "$FACTORY_ROOT/lib/constitution.sh" ] && . "$FACTORY_ROOT/lib/constitution.sh"

# phase_plan <issue_number> <worktree> <spec_file> [product]
phase_plan() {
  local issue="$1" wt="$2" spec_file="$3" product="${4:-}"
  local constitution_ctx=""

  # Load constitution if product is specified
  if [ -n "$product" ]; then
    constitution_ctx="$(constitution_context "$product" 2>/dev/null || echo "")"
  fi

  local prompt
  prompt="You are the PLAN phase of a multi-agent software factory for issue #$issue.
Do NOT implement anything. You are already inside the isolated worktree (cwd).

$( [ -n "$constitution_ctx" ] && echo "$constitution_ctx" )

Steps:
1. Run: gh issue view $issue --repo ${GH_REPO:-} — read it fully.
2. Read CLAUDE.md / CONTEXT.md / docs/adr/ if present for terminology and conventions.
3. Explore the codebase (read/search only) enough to name the exact files, functions,
   and existing patterns/tests this issue touches, and any edge cases.
4. Decide the build route:
   - route: codex — when the implementation from a frozen spec is bounded and mechanical
     (known-repro fixes, well-scoped features, refactors, test writing, CI/tooling)
   - route: claude — when the work needs UX, design, or architecture judgment; naming/API
     design calls; is a tiny diff (<20 lines); or needs session tools
   Default to route: claude when genuinely unsure.
5. $( [ -n "$product" ] && echo "The constitution above defines the standards for this product. Your spec MUST satisfy every standard. If any standard would be violated by the approach, adjust the plan." || echo "No constitution loaded — use your best judgment for quality." )

Write EXACTLY ONE file, at $spec_file, in this shape:
---
route: codex
---
# Spec: <issue title> (#$issue)
## Goal
<what and why, one paragraph>
## Files / approach
<exact files, functions, and the concrete implementation plan — detailed enough
that a cheap worker model could build it without re-reading the issue>
## Tests
<what to add or change, and the exact command that proves it passes>
## Constitution compliance
$( [ -n "$product" ] && echo "For each standard in the constitution, note how the plan satisfies it. If a standard is N/A, say so explicitly." || echo "N/A — no constitution" )
## Non-goals
<explicitly out of scope, from the issue>

(Replace 'codex' in the frontmatter with 'claude' if that's the route you chose.)
Do not run tests, do not write or edit any other file, do not touch git.
If the issue is genuinely too vague to plan without a product decision only a human
can make, print a line starting exactly with 'ESCALATE:' followed by the question,
and do NOT write $spec_file."

  local output; output="$(mktemp)"
  local model
  model="$(router_run plan "$prompt" "$output" 2>&1)"

  if grep -q '^ESCALATE:' "$output"; then
    echo "ESCALATE:$(grep -m1 '^ESCALATE:' "$output" | sed 's/^ESCALATE://')"
    rm -f "$output"
    return 10
  fi

  if [ ! -s "$spec_file" ]; then
    echo "FAIL: plan phase produced no spec file" >&2
    cat "$output" >&2
    rm -f "$output"
    return 1
  fi

  echo "OK: plan completed with model $model, spec at $spec_file"
  rm -f "$output"
}