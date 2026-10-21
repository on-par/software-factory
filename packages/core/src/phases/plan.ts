// src/phases/plan.ts — PLAN phase: boss model reads issue, explores repo, freezes spec, picks route

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Octokit } from '@octokit/rest';
import { createFsReader } from '@on-par/repo-context';

import { adrLabel, readAdrContext, renderAdrConstraints } from '../adr/index.js';
import type { ApprovalGate } from '../approvals/index.js';
import { PLAN_SPEC_PREVIEW_BYTES } from '../approvals/index.js';
import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { findUnresolvedRegressions, parseDesignArtifact, renderDesignArtifact } from '../design/index.js';
import { buildFastPathSpec, isFastPathEligible } from '../efficiency/fast-path.js';
import type { EventKind } from '../events/kinds.js';
import {
  buildReadinessEnrichmentPrompt,
  buildReadinessEnrichmentRetryPrompt,
  composeEnrichedIssueBody,
  scoreEnrichedIssueReadiness,
  stripEnrichedBlock,
  type ReadinessEnrichmentRetryContext,
} from '../readiness/enrich.js';
import type { SizeGateMode } from '../config/index.js';
import type { BuildRoutePin } from '../config/repo.js';
import { settlePlanRoute } from './plan-route.js';
import { blockedNoChangeSpecReason, noBuildReason, planSummary, specWriteDeniedResult } from './plan-spec-guards.js';
import { decomposeOversizedIssue, renderChildIssueBody } from '../readiness/decompose.js';
import { resolveSliceGate } from '../readiness/slice-gate.js';
import { octokitStackSliceGateReader } from './stack-approval.js';
import { DEFAULT_MAX_SLICES, type SlicePlan } from '../readiness/slice-plan.js';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_TOKEN_BUDGET,
  estimatePlanSize,
  planOverBudget,
  type SizeBudget,
} from '../readiness/size.js';
import { scoreIssueReadiness } from '../readiness/index.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { failoversFrom } from '../router/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import { archiveSpec, readSpec, writeSpec } from '../spec/index.js';
import type { EscalateKind } from '../types/index.js';
import type { Constitution, DesignArtifact, FailoverReason, ReadinessInfo } from '../types/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE, wrapUntrustedIssueBody } from '../utils/untrusted-input.js';
import { RIGHT_SIZE_STEP, RIGHT_SIZE_STEP_GATE_PASSED } from './plan-steps.js';
import { GITHUB_ISSUE_SOURCE, type GithubIssueParams } from '../work/github-issue.js';
import { createDefaultWorkSourceRegistry, type WorkRequestSourceKind, type WorkSourceRegistry } from '../work/index.js';

import {
  buildDesignArtifactRetryPrompt,
  designArtifactInvalidMessage,
  MAX_DESIGN_ARTIFACT_RETRIES,
} from './plan-design-retry.js';
import {
  type BuildRouteName,
  CLI_BUILD_ROUTES,
  defaultBuildRoute,
  ROUTE_BULLETS,
  resolveRunnableBuildRoute,
  runnableBuildRoutes,
} from './plan-routes.js';

export { buildDesignArtifactRetryPrompt, MAX_DESIGN_ARTIFACT_RETRIES };
export { type BuildRouteName, defaultBuildRoute, resolveRunnableBuildRoute, runnableBuildRoutes };

/**
 * REST API version pinned on the readiness-enrichment issues.update call (#2385). GitHub serves 2022-11-28 when no
 * header is sent; it is deprecated (sunset 2028-03-10). Scoped to this call because 2026-03-10 has breaking changes
 * on other endpoints (e.g. merge_commit_sha, singular assignee).
 */
const GITHUB_ISSUE_UPDATE_API_VERSION = '2026-03-10';

export interface PlanResult {
  ok: boolean;
  route: BuildRoutePin;
  specPath: string;
  model: string;
  escalate?: string;
  /** Set when the planner could not write its spec (#3269): `ok` is false and the caller parks `config`. */
  parkReason?: 'config';
  designArtifact: DesignArtifact | null;
  /** Set by either file-mode size gate (pre-flight or post-plan build-scope) when the oversized
   *  issue was decomposed into real filed sub-issues. `ok` stays false: this run is over, but the caller can
   *  continue the lane with these children instead of parking (#823). */
  decomposed?: { childIssues: number[] };
  /** Set only by the post-plan build-scope gate in sizeGate.mode 'slice' (ADR-0147) when the whole
   *  issue was sliced and its slice plan comment recorded. `ok` stays false: this run ends before
   *  BUILD, and the next run plans the current slice from the comment. */
  sliced?: { sliceCount: number };
  /** Set on an ok result when PLAN planned one slice of a sliced issue (ADR-0147). SHIP titles the PR
   *  from it, and runIssue records the PR in the slice plan comment. */
  slice?: { plan: SlicePlan; index: number };
  /** ADR-0161: set with `ok: false` when the stack slice below is not yet approved or merged. */
  stackWait?: { index: number; count: number; prNumber: number };
}

export interface PlanPromptOpts {
  issue: number;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  constitutionCtx: string;
  adrCtx?: string;
  /** Build routes with at least one runnable model on this machine. Empty or omitted = the CLI routes; command only when listed. */
  runnableRoutes?: readonly BuildRouteName[];
  /** Pre-flight size-gate verdict (#3275). passed && enforced drops step 4's size ESCALATE. */
  sizeGate?: { passed: boolean; reason?: string; enforced: boolean };
  /** Rendered "## Previous attempt" note (#3373); empty or absent = first run. */
  previousAttempt?: string;
}

/** Classify a planner ESCALATE line for the escalate event (#3275). */
export function classifyEscalation(line: string | undefined): EscalateKind | undefined {
  if (!line) return undefined;
  const rest = line.replace(/^\s*ESCALATE:\s*/i, '');
  if (/^missing-info:/i.test(rest)) return 'missing-info';
  if (/^contradiction:/i.test(rest)) return 'contradiction';
  if (/\b(split|slices?|smaller|too (big|large)|size)\b/i.test(rest)) return 'split';
  return undefined;
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
## Issue #${issue}: ${issueTitle}

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
${opts.sizeGate?.passed && opts.sizeGate.enforced ? RIGHT_SIZE_STEP_GATE_PASSED : RIGHT_SIZE_STEP}
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
   Write one evidencePlan entry per acceptance criterion. Its claim restates that criterion.
   Each entry has a kind, and each kind has required fields:
   - fail-to-pass-test: claim, test — a test (file path plus test name) that fails before
     the change and passes after it.
   - command: claim, command, passWhen — exact command and human explanation; passWhen alone is not machine-checked. Add optional expect when output matters: exitCode defaults to 0; stdoutContains requires every case-sensitive literal substring in stdout.
   - screenshot: claim, route — the concrete app route or page to capture.
   - none: claim, reason — why no evidence can honestly prove this criterion.
   Choosing a kind:
   - Prefer fail-to-pass-test for any behavior change.
   - Use screenshot only for a user-visible UI change with a concrete route to capture.
   - Use none with a reason instead of weak proof. A command that only shows the code
     compiles, or a test that would pass without the change, is weak proof.
   If the issue lists no acceptance criteria, write one entry per behaviorContract item.

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
      test: <test file path and test name that fails before and passes after>
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

export async function planPhase(opts: Parameters<typeof planPhaseImpl>[0]): Promise<PlanResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'plan',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    () => planPhaseImpl(opts),
    (r) => r.ok,
    planSummary,
  );
}

async function planPhaseImpl(opts: {
  /** Rendered "## Previous attempt" note (#3373); empty or absent = first run. */
  previousAttempt?: string;
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  constitution: Constitution | null;
  router: ModelRouter;
  sandbox?: SandboxPolicy;
  octokit: Octokit;
  log: (
    type: EventKind,
    msg: string,
    extra?: {
      failoverReason?: FailoverReason;
      model?: string;
      tokens?: { input: number; output: number };
      readiness?: ReadinessInfo;
      escalateKind?: EscalateKind;
      durationMs?: number;
    },
  ) => void;
  timeoutSeconds?: number;
  modelOverride?: string;
  modelFallbacks?: string[];
  onProviderFailure?: (info: { provider: string; reason: FailoverReason; detail?: string }) => void | Promise<void>;
  branch?: string;
  approvalGate?: ApprovalGate;
  drainSteering?: () => ConsumedSteering;
  maxReplans?: number;
  codexDisabled?: boolean;
  /** Input source to resolve before PLAN. Defaults to this run's GitHub issue. */
  workSource?: { kind: WorkRequestSourceKind; params: unknown };
  /** Source registry. Defaults to the built-in registry (GitHub issue adapter only). */
  workSources?: WorkSourceRegistry;
  /** Enrich incomplete GitHub factory-task issues before calling the boss PLAN task. */
  enforceReadiness?: boolean;
  /** Skip the model PLAN call only for a complete, explicitly bounded issue. */
  fastPath?: boolean;
  /** Park oversized factory-task issues (sizeOk: false) instead of proceeding. Default true. */
  enforceSizeGate?: boolean;
  /** sizeGate.mode (ADR-0147). 'slice' records a slice plan and plans only the current slice; 'stack' (ADR-0161) uses the slice-mode gates and may plan an explicit `sliceIndex`. Ignored when enforceSizeGate is false. */
  sizeGateMode?: SizeGateMode;
  /** Slice cap for sizeGate.mode 'slice' (ADR-0156); default DEFAULT_MAX_SLICES. */
  maxSlices?: number;
  /** sizeGate.tokenBudget / maxFiles (#3350); default DEFAULT_TOKEN_BUDGET / DEFAULT_MAX_FILES. */
  sizeBudget?: SizeBudget;
  /** ADR-0161 stack mode: plan this 1-based slice of the trusted slice plan. Default: the current slice. Ignored outside stack mode. */
  sliceIndex?: number;
  /** Stop PLAN before BUILD when a worse/unknown behaviorDelta row is not in openQuestions (#1819). Default false = log only. */
  blockUnresolvedRegressions?: boolean;
  /** readiness.updateIssueBody resolved (#2385); false = enrich in memory only, never write the issue body. Default true. */
  updateIssueBodyOnEnrich?: boolean;
  /** Local-only mode: force the route to codex so builds use a local harness. */
  localOnly?: boolean;
  /** Repo config pins the build route (`.factory/config.json` → `route`). Forced
   *  after plan so the spec frontmatter stays the frozen truth. */
  preferredRoute?: BuildRoutePin;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  onWorkerResult?: (result: RouterResult) => Promise<void>;
}): Promise<PlanResult> {
  const {
    issue,
    repo,
    worktree,
    specPath,
    constitution,
    router,
    octokit,
    log,
    timeoutSeconds,
    modelOverride,
    modelFallbacks,
    onProviderFailure,
    branch,
    approvalGate,
    drainSteering,
  } = opts;
  const maxReplans = opts.maxReplans ?? 3;
  const enforceSizeGate = opts.enforceSizeGate ?? true;
  const localOnly = opts.localOnly ?? false;
  const isCodexDisabled = opts.codexDisabled ?? false;

  const workSources = opts.workSources ?? createDefaultWorkSourceRegistry({ octokit });
  const source = opts.workSource ?? {
    kind: GITHUB_ISSUE_SOURCE,
    params: { repo, issue } satisfies GithubIssueParams,
  };
  const work = await workSources.resolve(source.kind, source.params);
  let issueTitle = work.title;
  let issueBody = work.brief;
  log(
    'work_request',
    `resolved work request ${work.id} (${work.kind}, ${work.acceptanceCriteria.length} acceptance criteria)`,
  );

  const constitutionCtx = buildConstitutionContext(constitution);
  const runnableRoutes = runnableBuildRoutes(router);
  const failureRoute = defaultBuildRoute(runnableRoutes);

  let readiness = scoreEnrichedIssueReadiness({ title: issueTitle, body: issueBody });
  if (
    opts.enforceReadiness &&
    source.kind === GITHUB_ISSUE_SOURCE &&
    readiness.template === 'factory-task' &&
    !readiness.pass
  ) {
    const params = source.params as GithubIssueParams;
    const [owner, name] = params.repo.split('/');
    const updateIssueBody = opts.updateIssueBodyOnEnrich ?? true;
    const maxEnrichmentAttempts = 2; // one initial call + one retry with the missing headings named (#816)
    log('readiness_enrichment_started', `enriching incomplete factory-task issue #${params.issue}`);
    try {
      let previous: ReadinessEnrichmentRetryContext | null = null;
      let lastModel = '';
      let lastReason = '';
      let enriched = false;
      for (let attempt = 1; attempt <= maxEnrichmentAttempts; attempt++) {
        const input = { title: issueTitle, body: stripEnrichedBlock(issueBody), missing: readiness.missing };
        const prompt =
          previous === null
            ? buildReadinessEnrichmentPrompt(input)
            : buildReadinessEnrichmentRetryPrompt(input, previous);
        const enrichment = await router.run('readiness_enrich', prompt, {
          worktree,
          sandbox: opts.sandbox,
          timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
          onLog: (msg) => log('router', msg),
        });
        lastModel = enrichment.model;
        const candidate = scoreIssueReadiness({ title: issueTitle, body: enrichment.output });
        if (candidate.template === 'factory-task' && candidate.pass) {
          const composed = composeEnrichedIssueBody(issueBody, enrichment.output);
          if (updateIssueBody) {
            await octokit.rest.issues.update({
              owner,
              repo: name,
              issue_number: params.issue,
              body: composed,
              headers: { 'X-GitHub-Api-Version': GITHUB_ISSUE_UPDATE_API_VERSION },
            });
          }
          issueBody = composed;
          readiness = candidate;
          log(
            'readiness_enrichment_succeeded',
            updateIssueBody
              ? `enriched factory-task issue #${params.issue} with ${enrichment.model}; updated the GitHub issue body (original text kept, enriched sections added under <!-- factory:enriched -->). To keep enrichment in memory only, set readiness.updateIssueBody: false in .factory/config.yaml or FACTORY_READINESS_UPDATE_BODY=0`
              : `enriched factory-task issue #${params.issue} with ${enrichment.model} in memory only; GitHub issue body left unchanged (readiness.updateIssueBody: false / FACTORY_READINESS_UPDATE_BODY=0)`,
            {
              model: enrichment.model,
            },
          );
          enriched = true;
          break;
        }
        lastReason = `enrichment output failed readiness (${candidate.template}; missing: ${candidate.missing.join(', ') || 'none'})`;
        log(
          'readiness_enrichment_failed',
          attempt < maxEnrichmentAttempts
            ? `${lastReason} — retrying with the missing heading(s) named (attempt ${attempt}/${maxEnrichmentAttempts})`
            : `${lastReason} — after ${maxEnrichmentAttempts} attempt(s)`,
        );
        previous = { previousOutput: enrichment.output, template: candidate.template, stillMissing: candidate.missing };
      }
      if (!enriched) {
        return {
          ok: false,
          route: failureRoute,
          specPath,
          model: lastModel,
          escalate: lastReason,
          designArtifact: null,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log('readiness_enrichment_failed', `enrichment failed: ${reason}`);
      return {
        ok: false,
        route: failureRoute,
        specPath,
        model: '',
        escalate: `readiness enrichment failed: ${reason}`,
        designArtifact: null,
      };
    }
  }

  // ADR-0161: stack uses the slice-mode gates; it may plan an explicit slice.
  const sizeBudget = opts.sizeBudget ?? { tokenBudget: DEFAULT_TOKEN_BUDGET, maxFiles: DEFAULT_MAX_FILES };
  const sliceMode = opts.sizeGateMode === 'slice' || opts.sizeGateMode === 'stack';
  let planningSlice = false;
  let sliceLabel = '';
  let plannedSlice: PlanResult['slice'];
  if (enforceSizeGate && sliceMode && source.kind === GITHUB_ISSUE_SOURCE) {
    const params = source.params as GithubIssueParams;
    const gate = await resolveSliceGate({
      issue: params.issue,
      repo: params.repo,
      title: issueTitle,
      body: issueBody,
      // #3350: issue prose never slices; only an existing trusted slice plan selects a slice here.
      oversized: false,
      maxSlices: opts.maxSlices ?? DEFAULT_MAX_SLICES,
      ...(opts.sizeGateMode === 'stack' && opts.sliceIndex !== undefined ? { sliceIndex: opts.sliceIndex } : {}),
      ...(opts.sizeGateMode === 'stack' ? { stackReader: octokitStackSliceGateReader(octokit, params.repo) } : {}),
      worktree,
      router,
      octokit,
      log: (type, msg) => log(type, msg),
      timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
      onProviderFailure,
    });
    const park = (reason: string): PlanResult => ({
      ok: false,
      route: failureRoute,
      specPath,
      model: '',
      escalate: reason,
      designArtifact: null,
    });
    if (gate.kind === 'park') {
      log('escalate', gate.reason);
      return park(gate.reason);
    }
    if (gate.kind === 'wait') {
      log('plan', gate.reason);
      const { index, prNumber } = gate;
      return { ...park(gate.reason), stackWait: { index, count: gate.plan.slices.length, prNumber } };
    }
    if (gate.kind === 'over-cap' || gate.kind === 'unsliceable') {
      log('size-gate-escalated', gate.reason);
      return park(gate.reason);
    }
    if (gate.kind === 'slice') {
      const { plan, slice } = gate;
      issueTitle = `${issueTitle} — slice ${slice.index}/${plan.slices.length}: ${slice.title}`;
      issueBody = renderChildIssueBody(slice.story, params.issue);
      readiness = scoreIssueReadiness({ title: issueTitle, body: issueBody });
      planningSlice = true;
      plannedSlice = { plan, index: slice.index };
      sliceLabel = `slice ${slice.index}/${plan.slices.length} of #${params.issue}`;
      log('plan', `planning slice ${slice.index}/${plan.slices.length} of #${params.issue}: ${slice.title}`);
      if (readiness.sizeOk === false) {
        log(
          'size_hint',
          `slice reads as large (${readiness.sizeReason ?? 'too big'}) — not parked; the post-plan size estimate decides (#3350)`,
          {
            readiness,
          },
        );
      }
    }
  }

  if (enforceSizeGate && readiness.template === 'factory-task' && readiness.sizeOk === false) {
    log(
      'size_hint',
      `issue reads as large (${readiness.sizeReason ?? 'too big'}) — not split; the post-plan size estimate decides (#3350)`,
      {
        readiness,
      },
    );
  }

  const sizeGate =
    readiness.template === 'factory-task'
      ? {
          passed: readiness.sizeOk !== false,
          ...(readiness.sizeReason ? { reason: readiness.sizeReason } : {}),
          enforced: enforceSizeGate,
        }
      : undefined;

  // The fast path emits a compact Codex spec, so it is only valid when the route may be codex:
  // a pinned claude/opencode build route (#1367) must go through model PLAN like any other issue.
  const fastPathRouteOk = !opts.preferredRoute || opts.preferredRoute === 'codex';
  if (
    opts.fastPath &&
    !isCodexDisabled &&
    fastPathRouteOk &&
    isFastPathEligible({ issueBody, readinessPassed: readiness.pass })
  ) {
    const fastPath = buildFastPathSpec({ issue, title: issueTitle, issueBody });
    await writeSpec(specPath, {
      body: fastPath.markdown,
      data: fastPath.frontmatter,
      designJson: JSON.stringify(fastPath.frontmatter.design, null, 2),
      designMd: renderDesignArtifact(fastPath.frontmatter.design, issue),
    });
    log('fast_path', 'complete bounded issue bypassed model PLAN and emitted a compact Codex spec');
    return {
      ok: true,
      route: 'codex',
      specPath,
      model: 'fast-path',
      designArtifact: fastPath.frontmatter.design,
      ...(plannedSlice ? { slice: plannedSlice } : {}),
    };
  }

  log('plan', `Starting plan phase`);

  log(
    'readiness',
    `issue readiness ${Math.round(readiness.score * 100)}% (${readiness.template})${readiness.pass ? '' : ` — missing: ${readiness.missing.join(', ')}`}`,
    { readiness },
  );

  log('adr_inject_started', 'reading accepted ADRs for design-constraint injection');
  const adrInjectStartedAt = Date.now();
  const adrReader = createFsReader({
    root: worktree,
    onDegrade: (event) => {
      if (event.reason === 'not-found') return; // a repo with no docs/adr is normal
      log('adr_read_degraded', `adr read degraded: ${event.operation} ${event.path} (${event.reason})`);
    },
  });
  const adrContext = await readAdrContext(adrReader);
  const adrCtx = renderAdrConstraints(adrContext);
  if (adrContext.active.length > 0) {
    const names = adrContext.active
      .map((adr) => (adr.statusless ? `${adrLabel(adr)} (no status, treated as Accepted)` : adrLabel(adr)))
      .join(', ');
    log(
      'adr_context',
      `${adrContext.active.length} accepted ADR(s) injected as design constraints: ${names}` +
        (adrContext.truncated > 0 ? ` (${adrContext.truncated} more omitted by the injection cap)` : ''),
    );
  } else {
    log('adr_context_empty', `no accepted ADRs found in ${adrContext.dir} — planning without ADR constraints`);
  }
  if (adrContext.skipped.length > 0) {
    const skippedList = adrContext.skipped.map((s) => `${s.path} (${s.reason})`).join(', ');
    log('adr_skipped', `${adrContext.skipped.length} ADR file(s) skipped: ${skippedList}`);
  }
  log('adr_inject_completed', `ADR injection complete (${adrContext.active.length} active)`, {
    durationMs: Date.now() - adrInjectStartedAt,
  });

  let steering: ConsumedSteering | undefined;
  let replans = 0;
  while (true) {
    const basePrompt = applySteering(
      buildPlanPrompt({
        issue,
        issueTitle,
        issueBody,
        specPath,
        constitutionCtx,
        adrCtx,
        runnableRoutes,
        sizeGate,
        previousAttempt: opts.previousAttempt,
      }),
      steering,
    );

    if (replans > 0) {
      log('plan', `Re-planning after operator redirect (attempt ${replans + 1})`);
    }

    let prompt = basePrompt;
    let designRetries = 0;
    let result: Awaited<ReturnType<ModelRouter['run']>>;
    let parsed: Awaited<ReturnType<typeof readSpec>>;
    let designParse: ReturnType<typeof parseDesignArtifact>;
    while (true) {
      const archived = await archiveSpec(specPath);
      if (archived.length > 0) {
        log('plan', `Archived existing spec before planning: ${archived.join(', ')}`);
      }

      result = await router.run('plan', prompt, {
        worktree,
        sandbox: opts.sandbox,
        timeoutSeconds: timeoutSeconds ?? 1800,
        modelOverride,
        modelFallbacks,
        onProviderFailure,
        onLog: (msg) => log('router', msg),
      });
      await opts.onWorkerResult?.(result);

      for (const f of failoversFrom(result.attempts)) {
        log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
          failoverReason: f.reason,
        });
      }

      const denied = specWriteDeniedResult(result, specPath, failureRoute, log);
      if (denied) return denied;

      // Check for escalation
      if (isEscalation(result.output)) {
        const escalateLine = escalationLine(result.output);
        const escalateKind = classifyEscalation(escalateLine);
        log('escalate', escalateLine ?? 'plan escalated', escalateKind ? { escalateKind } : undefined);
        return {
          ok: false,
          route: failureRoute,
          specPath,
          model: result.model,
          escalate: escalateLine,
          designArtifact: null,
        };
      }

      // Check spec file was created. If the model is chat-only, the output is the
      // spec content; if it has file tools, it may have written specPath directly.
      if (!existsSync(specPath)) {
        await writeSpec(specPath, { body: result.output });
      }

      // Read route from spec frontmatter (single normalization site: parseSpec)
      parsed = await readSpec(specPath);
      designParse = parseDesignArtifact(parsed.data);
      if (
        !designParse.artifact &&
        blockedNoChangeSpecReason(parsed.body) === null &&
        designRetries < MAX_DESIGN_ARTIFACT_RETRIES
      ) {
        designRetries++;
        log(
          'plan',
          `design artifact invalid — re-prompting planner with ${designParse.errors.length} validation error(s) (retry ${designRetries}/${MAX_DESIGN_ARTIFACT_RETRIES}): ${designParse.errors.join('; ')}`,
        );
        prompt = buildDesignArtifactRetryPrompt(basePrompt, designParse.errors);
        continue;
      }
      break;
    }
    // Re-read after the PLAN call: a CLI that failed sign-in during PLAN is no longer runnable (#2495).
    const runnableNow = runnableBuildRoutes(router);
    const route = await settlePlanRoute({
      parsedRoute: parsed.route,
      runnableNow,
      localOnly,
      isCodexDisabled,
      preferredRoute: opts.preferredRoute,
      specPath,
      log,
    });

    const { artifact: designArtifact, errors: designErrors, coerced: designCoerced } = designParse;
    if (designCoerced.length > 0) {
      log(
        'design_artifact_coerced',
        `coerced ${designCoerced.length} non-string design list item(s) to text: ${designCoerced.join(', ')}`,
      );
    }
    if (designArtifact) {
      await writeSpec(specPath, {
        designJson: JSON.stringify(designArtifact, null, 2),
        designMd: renderDesignArtifact(designArtifact, issue),
      });
      log(
        'design_artifact_emitted',
        `design artifact validated and written (open questions: ${designArtifact.openQuestions.length}, ` +
          `target types: ${designArtifact.targetTypes.length}, ` +
          `signatures: ${designArtifact.signatures.length}, ` +
          `call edges: ${designArtifact.callGraph.length})`,
      );
      if (
        designArtifact.targetTypes.length === 0 &&
        designArtifact.signatures.length === 0 &&
        designArtifact.callGraph.length === 0
      ) {
        log(
          'design_shallow',
          'design artifact has no targetTypes, signatures, or callGraph — BUILD will run without design grounding',
        );
      }
      if (designArtifact.openQuestions.length > 0) {
        const summary = designArtifact.openQuestions.join('; ');
        const truncated = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
        log('design_open_questions', `plan has ${designArtifact.openQuestions.length} open question(s): ${truncated}`);
      }

      // Build-scope gate (#3350): a plan whose estimated size (changed files, and tokens from the
      // bytes of the files it names) is over sizeGate.tokenBudget / maxFiles is too big for one
      // bounded BUILD pass; a plan changing 3 files or fewer never splits. Decompose the issue
      // instead of handing a mega-slice to BUILD. File mode files the decomposition as sub-issues
      // and re-queues them (#2662).
      const overBudget = planOverBudget(estimatePlanSize(designArtifact, { worktree }), sizeBudget);
      if (enforceSizeGate && source.kind === GITHUB_ISSUE_SOURCE && overBudget !== null) {
        const params = source.params as GithubIssueParams;
        const scope = overBudget;
        const fileReason = `plan scope exceeds the bounded-build budget (${scope}) — parked for decomposition`;
        const park = (reason: string): PlanResult => ({
          ok: false,
          route,
          specPath,
          model: result.model,
          escalate: reason,
          designArtifact: null,
        });
        // ADR-0147: in slice mode the post-plan gate slices a whole issue; a slice is never sliced again.
        if (sliceMode) {
          if (planningSlice) {
            const reason = `${sliceLabel} exceeds the bounded-build budget (${scope}) — parked; a slice is never sliced again`;
            log('size-gate-escalated', reason);
            return park(reason);
          }
          const gate = await resolveSliceGate({
            issue: params.issue,
            repo: params.repo,
            title: issueTitle,
            body: issueBody,
            oversized: true,
            sizeReason: `plan scope exceeds the bounded-build budget: ${scope}`,
            maxSlices: opts.maxSlices ?? DEFAULT_MAX_SLICES,
            worktree,
            router,
            octokit,
            log: (type, msg) => log(type, msg),
            timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
            onProviderFailure,
          });
          // #3351: slices that mostly edit the same files keep the issue whole; PLAN continues.
          if (gate.kind !== 'cohesive') {
            if (gate.kind === 'slice') {
              const reason = `plan scope exceeds the bounded-build budget (${scope}) — sliced into ${gate.plan.slices.length} slice(s); the next run plans slice ${gate.slice.index}`;
              return { ...park(reason), sliced: { sliceCount: gate.plan.slices.length } };
            }
            if (gate.kind === 'over-cap' || gate.kind === 'unsliceable') {
              log('size-gate-escalated', gate.reason);
              return park(gate.reason);
            }
            const reason = gate.kind === 'park' ? gate.reason : fileReason;
            log('escalate', reason);
            return park(reason);
          }
        } else {
          // File mode (#2662): file the decomposition as sub-issues and re-queue them instead of parking.
          const decomposeResult = await decomposeOversizedIssue({
            issue: params.issue,
            repo: params.repo,
            title: issueTitle,
            body: issueBody,
            worktree,
            router,
            sandbox: opts.sandbox,
            octokit,
            log: (type, msg) => log(type, msg),
            timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
            onProviderFailure,
            fileSubIssues: true,
          });
          // #3351: slices that mostly edit the same files keep the issue whole; PLAN continues.
          if (decomposeResult.cohesive === undefined) {
            const { childIssues } = decomposeResult;
            if (childIssues.length > 0) {
              const reason = `plan scope exceeds the bounded-build budget (${scope}) — decomposed into ${childIssues.map((n) => `#${n}`).join(', ')}`;
              log('size-gate-decomposed', reason);
              return { ...park(reason), decomposed: { childIssues } };
            }
            log('size-gate-escalated', fileReason);
            return park(fileReason);
          }
        }
      }
      const unresolved = findUnresolvedRegressions(designArtifact);
      for (const row of unresolved) {
        log(
          'design_regression_unresolved',
          `behaviorDelta row "${row.input}" (${row.branch}) has verdict ${row.verdict} and is not listed in openQuestions`,
        );
      }
      if (unresolved.length > 0 && opts.blockUnresolvedRegressions) {
        const reason = `plan has ${unresolved.length} unresolved behaviorDelta regression row(s) (verdict worse/unknown, not in openQuestions) — design.blockUnresolvedRegressions is on`;
        log('escalate', reason);
        return { ok: false, route, specPath, model: result.model, escalate: reason, designArtifact: null };
      }
    } else {
      const blockedReason = noBuildReason(parsed.body, designErrors, designRetries + 1);
      if (blockedReason) {
        log('escalate', blockedReason);
        return { ok: false, route, specPath, model: result.model, escalate: blockedReason, designArtifact: null };
      }
      log('design_artifact_invalid', designArtifactInvalidMessage(designErrors, designRetries + 1));
    }

    log('plan', `Plan complete with model ${result.model}, route: ${route}`, { model: result.model });

    const planResult: PlanResult = {
      ok: true,
      route,
      specPath,
      model: result.model,
      designArtifact,
      ...(plannedSlice ? { slice: plannedSlice } : {}),
    };

    if (!approvalGate) return planResult;

    const specForApproval = await readFile(specPath, 'utf-8');
    const specPreview =
      specForApproval.length > PLAN_SPEC_PREVIEW_BYTES
        ? specForApproval.slice(0, PLAN_SPEC_PREVIEW_BYTES)
        : specForApproval;

    log('plan_approval_requested', `awaiting plan approval for issue #${issue} (route: ${route})`);
    const response = await approvalGate({
      issue,
      branch: branch ?? '',
      worktree,
      diffStat: '',
      kind: 'plan',
      specPreview,
    });

    if (response.approved) {
      log('plan_approval_granted', `plan approved for issue #${issue}`);
      return planResult;
    }

    const redirect = drainSteering?.();
    if (redirect && redirect.messages.length > 0) {
      if (replans >= maxReplans) {
        const reason = `plan re-plan limit exceeded (${maxReplans} redirects)`;
        log('plan_rejected', reason);
        return { ok: false, route, specPath, model: result.model, escalate: reason, designArtifact: null };
      }
      replans++;
      steering = redirect;
      log('plan_redirect', describeSteering(redirect));
      continue; // re-plan with the redirect applied to the prompt
    }

    const reason = response.reason ?? 'plan rejected by operator';
    log('plan_rejected', reason);
    return {
      ok: false,
      route,
      specPath,
      model: result.model,
      escalate: `plan rejected: ${reason}`,
      designArtifact: null,
    };
  }
}
