#!/usr/bin/env bash
# lib/phases/build.sh — BUILD phase.
#
# The worker model implements the frozen spec. Routes to either Codex CLI
# (bounded/mechanical) or Claude (design/UX) based on the plan's route decision.
# The worker does NOT verify its own work — that's the CHECK phase.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

[ -f "$FACTORY_ROOT/lib/router.sh" ] && . "$FACTORY_ROOT/lib/router.sh"
[ -f "$FACTORY_ROOT/lib/constitution.sh" ] && . "$FACTORY_ROOT/lib/constitution.sh"

# phase_build <issue_number> <worktree> <spec_file> <branch> [product]
phase_build() {
  local issue="$1" wt="$2" spec="$3" br="$4" product="${5:-}"
  local route constitution_ctx=""

  # Read route from spec frontmatter
  route="$(grep -m1 -E '^route:[[:space:]]*(codex|claude)[[:space:]]*$' "$spec" \
    | awk '{print $2}')"
  route="${route:-claude}"  # default to claude

  # Load constitution for the worker
  if [ -n "$product" ]; then
    constitution_ctx="$(constitution_context "$product" 2>/dev/null || echo "")"
  fi

  local prompt
  if [ "$route" = "codex" ]; then
    # Codex route: implement from spec, commit, no push/PR
    prompt="Implement issue #$issue exactly per the frozen spec at $spec in this repository.
Read the full spec before writing any code — it is the approved plan; do not deviate.

$( [ -n "$constitution_ctx" ] && echo "$constitution_ctx" )

Match surrounding code style and idioms. Add or update the tests described in the
spec's Tests section and actually run them — report the exact command and its output.
If the repo has a fast verify path (scripts/verify.sh, npm test), run it and fix
failures before finishing.

When everything passes, create exactly ONE git commit with a clear, conventional
message describing the change. Do NOT push, do NOT open a pull request, do NOT
merge — a separate checker and ship phase handles that next.

Stay strictly within the spec's scope: no unrelated refactors, no drive-by changes.
If you get genuinely stuck on something the spec doesn't resolve, commit whatever
safely builds/passes so far with a message that explains exactly what's blocked,
and stop there."
  else
    # Claude route: implement + verify + ship PR in one session
    prompt="/ship-it $issue — Run fully autonomously in headless mode, BUILD phase.
You are ALREADY inside the isolated git worktree for issue $issue (branch $br,
cwd is this worktree), so SKIP ship-it's worktree-creation step.

$( [ -n "$constitution_ctx" ] && echo "$constitution_ctx" )

A frozen, already-approved spec exists at $spec (written by a separate planning pass)
— read it and treat it as your go/no-go plan; do NOT re-derive your own plan from the
issue or block on any plan gate. Auto-fix only high-confidence review findings; for
uncertain findings apply the conservative default and note the deferral in the PR body.
Never pause for permission or input — nobody is watching this session.

Stop at a green, ready-for-review PR — do NOT merge (the factory handles merging).
CRITICAL: your session terminates the moment you end your turn, so NEVER end your
turn after an intermediate step. Before ending, run this checklist and keep working
until every item is true: (1) branch $br is pushed, (2) open PR exists with 'Closes #$issue'
in its body, (3) CI is green, (4) PR is ready for review.

If and ONLY IF you hit something genuinely ambiguous that the spec doesn't resolve
and is unsafe to default, print a line starting exactly with 'ESCALATE:' followed by
the question, then STOP."
  fi

  local output; output="$(mktemp)"
  local model task_type
  if [ "$route" = "codex" ]; then
    task_type="build_codex"
  else
    task_type="build_claude"
  fi

  model="$(router_run "$task_type" "$prompt" "$output" 2>&1)" || {
    echo "FAIL: build phase failed for $task_type" >&2
    cat "$output" >&2
    rm -f "$output"
    return 1
  }

  if grep -q '^ESCALATE:' "$output"; then
    echo "ESCALATE:$(grep -m1 '^ESCALATE:' "$output" | sed 's/^ESCALATE://')"
    rm -f "$output"
    return 10
  fi

  echo "OK: build completed with model $model (route: $route)"
  rm -f "$output"
}