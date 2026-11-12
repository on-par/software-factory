// src/phases/plan-prompt.ts — builds the PLAN phase prompt (split out of plan.ts to stay under its max-lines ceiling)

import type { WorkKey } from '../work/work-key.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE, wrapUntrustedIssueBody } from '../utils/untrusted-input.js';
import {
  OUTLINE_STEP,
  OUTLINE_TEMPLATE,
  RIGHT_SIZE_STEP,
  RIGHT_SIZE_STEP_GATE_PASSED,
  RIGHT_SIZE_STEP_STACK,
} from './plan-steps.js';
import { type BuildRouteName, CLI_BUILD_ROUTES, defaultBuildRoute, ROUTE_BULLETS } from './plan-routes.js';

export interface PlanPromptOpts {
  issue: WorkKey;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  constitutionCtx: string;
  adrCtx?: string;
  /** Rendered "## Lane memory" section (#3624); empty or absent = no lane memory. */
  agentMemoryCtx?: string;
  /** Build routes with at least one runnable model on this machine. Empty or omitted = the CLI routes; command only when listed. */
  runnableRoutes?: readonly BuildRouteName[];
  /** Pre-flight size-gate verdict (#3275). passed && enforced drops step 4's size ESCALATE. */
  sizeGate?: { passed: boolean; reason?: string; enforced: boolean };
  stackSizeGate?: boolean;
  /** Rendered "## Previous attempt" note (#3373); empty or absent = first run. */
  previousAttempt?: string;
}

export function buildPlanPrompt(opts: PlanPromptOpts): string {
  const { issue, issueTitle, issueBody, specPath, constitutionCtx, adrCtx } = opts;
  const runnable = opts.runnableRoutes ?? [];
  const fallbackRoute = defaultBuildRoute(runnable);
  const offered = runnable.length > 0 ? runnable : CLI_BUILD_ROUTES;
  const routeBullets = (['codex', 'claude', 'opencode', 'command'] as const)
    .filter((r) => offered.includes(r))
    .map((r) => ROUTE_BULLETS[r])
    .join('\n');
  const exampleRoute = offered.includes('codex') ? 'codex' : fallbackRoute;
  const replaceNote =
    offered.includes('codex') && offered.includes('claude')
      ? `(Replace 'codex' in the frontmatter with 'claude' if that's the route you chose.)\n`
      : offered.length > 1
        ? `(Set route: in the frontmatter to the route you chose.)\n`
        : '';
  const runnableNote =
    runnable.length > 0 && CLI_BUILD_ROUTES.some((r) => !runnable.includes(r))
      ? `\n   Only these routes can run on this machine: ${runnable.join(', ')}. Choose one of them.`
      : '';

  return `You are the PLAN phase of a multi-agent software factory for issue #${issue}.
Do NOT implement anything. You are already inside the isolated worktree (cwd).

${constitutionCtx}
${adrCtx ?? ''}
${opts.agentMemoryCtx ? `${opts.agentMemoryCtx}\n` : ''}## Issue #${issue}: ${issueTitle}

${UNTRUSTED_ISSUE_BODY_NOTICE}

${wrapUntrustedIssueBody(issueBody)}

${opts.previousAttempt ? `${opts.previousAttempt}\n\n` : ''}Steps:
1. Read the issue above fully. Read CONTEXT.md if present. Any Accepted ADRs in this checkout
   are already summarized above — treat them as binding constraints and open docs/adr/<file>
   only if you need the full text. (Any CLAUDE.md/AGENTS.md standards are already included
   above — do not re-read them.)
2. Explore the codebase (read/search only) enough to name the exact files, functions,
   and existing patterns/tests this issue touches, and any edge cases.
3. Decide the build route:
${routeBullets}
   A pinned build worker's harness always wins over your judgment: the factory forces the
   route to match it after PLAN. Default to route: ${fallbackRoute} when genuinely unsure.${runnableNote}
${opts.stackSizeGate ? RIGHT_SIZE_STEP_STACK : opts.sizeGate?.passed && opts.sizeGate.enforced ? RIGHT_SIZE_STEP_GATE_PASSED : RIGHT_SIZE_STEP}
${constitutionCtx ? '5. The constitution above defines the standards for this product. Your spec MUST satisfy every standard.' : '5. No constitution loaded — use your best judgment.'}
6. RISKY-CHANGE FIELDS. If the plan changes a dispatch, switch, or match; a default branch
   or fallthrough; or the flags passed to an external tool, you MUST fill the design fields
   edgeInputs, behaviorDelta, and externalLists:
   - edgeInputs: every input that reaches the default/fallthrough branch, including empty,
     unknown, and malformed values.
   - behaviorDelta: one row per input/branch with its behavior before and after the change,
     and a verdict of same, better, worse, or unknown.
   - externalLists: every closed list the change depends on (enum, allow-list, supported
     values), checked against the upstream docs (read them, do not run the tool), with the
     source and any gaps.
   When replacing a tool's default call with explicit flags, list what each new explicit
   flag turns off (defaults, config files, or behavior the implicit call had) as behaviorDelta rows.
   Any behaviorDelta row with verdict worse or unknown must be fixed in the approach or
   also listed in openQuestions. For any other change, omit these three keys.
7. EVIDENCE PLAN. Decide what evidence will prove each acceptance criterion in the issue.
   Write one evidencePlan entry per acceptance criterion. Its claim names the criterion it
   proves, then states the concrete behaviour its test or command checks. When a criterion is a
   high-level business outcome, translate it into that concrete, testable behaviour; do not just
   restate a sentence no test can check, and do not drop a criterion because of its wording.
   Each entry has a kind, and each kind has required fields:
   - fail-to-pass-test: claim, test — the test file path followed by each test name in double
     quotes, e.g. src/foo.test.ts "does x" (pytest: tests/test_foo.py::test_x); no prose, flags
     or shell syntax, or the proof SKIPs. It must fail before the change and pass after it.
   - command: claim, command, passWhen — exact command and human explanation; passWhen alone is not machine-checked. Add optional expect when output matters: exitCode defaults to 0; stdoutContains requires every case-sensitive literal substring in stdout.
   - screenshot: claim, route — the concrete app route or page to capture.
   - none: claim, reason — why no evidence can honestly prove this criterion.
   Choosing a kind:
   - Prefer fail-to-pass-test for any behavior change.
   - Use screenshot only for a user-visible UI change with a concrete route to capture.
   - Use none with a reason instead of weak proof. A command that only shows the code
     compiles, or a test that would pass without the change, is weak proof.
   If the issue lists no acceptance criteria, write one entry per behaviorContract item.
${OUTLINE_STEP}

Write EXACTLY ONE file, at ${specPath}, in this shape:
---
route: ${exampleRoute}
design:
  restatedProblem: >-
    <one paragraph, the problem in your own words — if this is wrong, stop>
  approach:
    chosen: <the chosen approach, briefly>
    rejected:
      - option: <rejected alternative>
        reason: <why>
  interfacesTouched:
    - <file / exported function / type added or changed>
  targetTypes:
    - name: <exported type/interface/class this change centers on>
      file: <path that exists in this checkout, or one you are creating>
      kind: added|changed|read
  signatures:
    - symbol: <exported function/method name>
      file: <path in this checkout>
      signature: '<exact TypeScript signature after the change>'
  callGraph:
    - from: <caller symbol>
      to: <callee symbol>
      note: <what flows across this edge>
  behaviorContract:
    - <what is true after this change that was not true before>
  verificationPlan:
    - command: <exact command>
      passWhen: <what a pass looks like>
  riskBlastRadius: <what breaks if this is wrong>
  openQuestions: []   # anything you could not resolve; empty list if none
  evidencePlan:   # one entry per acceptance criterion — see step 7
    - kind: fail-to-pass-test
      claim: <acceptance criterion this proves>
      test: <test file path then each test name in double quotes, e.g. src/foo.test.ts "does x">
    - kind: command
      claim: <acceptance criterion>
      command: <exact command>
      passWhen: <what a pass looks like>
      expect:
        exitCode: 0
        stdoutContains: [<literal output required when relevant>]
    - kind: screenshot
      claim: <user-visible acceptance criterion>
      route: <concrete route, e.g. /settings>
    - kind: none
      claim: <acceptance criterion>
      reason: <why no honest evidence exists>
${OUTLINE_TEMPLATE}
  edgeInputs:     # OPTIONAL — required by step 6 for dispatch/default-branch/external-flag changes
    - <input that reaches the default/fallthrough branch>
  behaviorDelta:  # OPTIONAL — required by step 6
    - input: <input>
      branch: <branch it takes>
      before: <behavior before>
      after: <behavior after>
      verdict: same|better|worse|unknown
  externalLists:  # OPTIONAL — required by step 6
    - name: <closed list>
      location: <file/symbol where it lives>
      source: <upstream doc checked>
      gaps: []    # entries missing vs upstream; empty list if none
---
# Spec: ${issueTitle} (#${issue})
## Goal
<what and why, one paragraph>
## Files / approach
<exact files, functions, and the concrete implementation plan — detailed enough
that a cheap worker model could build it without re-reading the issue>
## Tests
<what to add or change, and the exact command that proves it passes>
${constitutionCtx ? `## Constitution compliance\nFor each standard in the constitution, note how the plan satisfies it.` : '## Constitution compliance\nN/A — no constitution'}
## Non-goals
<explicitly out of scope, from the issue>

${replaceNote}The design: block is machine-validated — keys must match exactly as shown.
targetTypes / signatures / callGraph must be grounded in the real checkout: every
file must be one that exists (or one you are creating), and every name/symbol must
be one you actually read or are adding — omit an entry rather than guess. Quote
signature values in single quotes; unquoted YAML breaks on the colons in a
TypeScript signature.
Single-quote any list item that contains ': ' (for example a backticked \`uses: x@main\`) — unquoted, YAML reads the item as a map.
Do not record new ADRs. Recording an architecture decision is a separate process from this
change: plan no ADR and no \`docs/adr/\` file, unless the issue itself asks for one.
Do not run tests, do not write or edit any other file, do not touch git.
If the issue is genuinely too vague to plan without a product decision only a human
can make, print a line starting exactly with "ESCALATE:" followed by the question,
and do NOT write ${specPath}.`;
}
