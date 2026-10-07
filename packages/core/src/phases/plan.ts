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
  type ReadinessEnrichmentRetryContext,
} from '../readiness/enrich.js';
import type { SizeGateMode } from '../config/index.js';
import { decomposeOversizedIssue, renderChildIssueBody } from '../readiness/decompose.js';
import { resolveSliceGate } from '../readiness/slice-gate.js';
import { DEFAULT_MAX_SLICES, type SlicePlan } from '../readiness/slice-plan.js';
import { MAX_BUILD_CALL_EDGES, MAX_BUILD_SIGNATURES, MAX_BUILD_TARGET_TYPES } from '../readiness/size.js';
import { scoreIssueReadiness } from '../readiness/index.js';
import type { ModelRouter } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import { archiveSpec, readSpec, updateSpecRoute, writeSpec } from '../spec/index.js';
import type { Constitution, DesignArtifact, FailoverReason, ReadinessInfo } from '../types/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE, wrapUntrustedIssueBody } from '../utils/untrusted-input.js';
import { GITHUB_ISSUE_SOURCE, type GithubIssueParams } from '../work/github-issue.js';
import { createDefaultWorkSourceRegistry, type WorkRequestSourceKind, type WorkSourceRegistry } from '../work/index.js';

export interface PlanResult {
  ok: boolean;
  route: 'codex' | 'claude' | 'opencode';
  specPath: string;
  model: string;
  escalate?: string;
  designArtifact: DesignArtifact | null;
  /** Set only by the pre-flight size gate when the oversized issue was decomposed into
   *  real filed sub-issues. `ok` stays false: this run is over, but the caller can
   *  continue the lane with these children instead of parking (#823). */
  decomposed?: { childIssues: number[] };
  /** Set only by the post-plan build-scope gate in sizeGate.mode 'slice' (ADR-0147) when the whole
   *  issue was sliced and its slice plan comment recorded. `ok` stays false: this run ends before
   *  BUILD, and the next run plans the current slice from the comment. */
  sliced?: { sliceCount: number };
  /** Set on an ok result when PLAN planned one slice of a sliced issue (ADR-0147). SHIP titles the PR
   *  from it, and runIssue records the PR in the slice plan comment. */
  slice?: { plan: SlicePlan; index: number };
}

export interface PlanPromptOpts {
  issue: number;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  constitutionCtx: string;
  adrCtx?: string;
}

export function buildPlanPrompt(opts: PlanPromptOpts): string {
  const { issue, issueTitle, issueBody, specPath, constitutionCtx, adrCtx } = opts;

  return `You are the PLAN phase of a multi-agent software factory for issue #${issue}.
Do NOT implement anything. You are already inside the isolated worktree (cwd).

${constitutionCtx}
${adrCtx ?? ''}
## Issue #${issue}: ${issueTitle}

${UNTRUSTED_ISSUE_BODY_NOTICE}

${wrapUntrustedIssueBody(issueBody)}

Steps:
1. Read the issue above fully. Read CONTEXT.md if present. Any Accepted ADRs in this checkout
   are already summarized above — treat them as binding constraints and open docs/adr/<file>
   only if you need the full text. (Any CLAUDE.md/AGENTS.md standards are already included
   above — do not re-read them.)
2. Explore the codebase (read/search only) enough to name the exact files, functions,
   and existing patterns/tests this issue touches, and any edge cases.
3. Decide the build route:
   - route: codex — when the implementation from a frozen spec is bounded and mechanical
     (known-repro fixes, well-scoped features, refactors, test writing, CI/tooling)
   - route: claude — when the work needs UX, design, or architecture judgment; naming/API
     design calls; is a tiny diff (<20 lines); needs session tools; or when the repo's
     pinned build worker is a claude-cli model (e.g. claude-sonnet-5 in .factory/config.json)
   - route: opencode — when the repo's pinned build worker is an opencode-harness model
     (e.g. opencode-deepseek-v4-flash in .factory/config.json); bounded mechanical work
   A pinned build worker's harness always wins over your judgment: the factory forces the
   route to match it after PLAN. Default to route: claude when genuinely unsure.
4. RIGHT-SIZE THE SLICE. A single BUILD pass must be bounded: aim for roughly
   5-15 minutes of agent work, a handful of files, at most ~6 target types /
   ~8 signatures / ~10 call edges in the design block. If the issue genuinely
   needs more surface than that, do NOT write a mega-spec — instead print a line
   starting with ESCALATE: asking to split the issue into smaller slices first,
   and do not write the spec file. A slice that takes 40 minutes to build is a
   planning failure, not a build problem.
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
   - command: claim, command, passWhen — an exact command and what a pass looks like.
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
route: codex
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

(Replace 'codex' in the frontmatter with 'claude' if that's the route you chose.)
The design: block is machine-validated — keys must match exactly as shown.
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
    (r) => (r.ok ? `plan complete (route ${r.route}, model ${r.model})` : `plan escalated: ${r.escalate ?? 'unknown'}`),
  );
}

function blockedNoChangeSpecReason(body: string): string | null {
  const looksBlocked = /^\s*Blocked(?::|\s+by\b)/im.test(body);
  if (!looksBlocked) return null;

  const saysNoChanges = /\bno files? (?:were )?changed\b/i.test(body) || /\bno changes? (?:were )?made\b/i.test(body);
  const pointsAtSandbox =
    /\bsandbox\b/i.test(body) || /\boutside (?:the )?(?:worktree|workspace|checkout)\b/i.test(body);
  if (!saysNoChanges && !pointsAtSandbox) return null;

  return 'PLAN returned a blocked/no-change note instead of a frozen spec';
}

/** The file-mode size-gate escalation: log it and build the parked (or decomposed) PlanResult. */
function fileModeEscalation(
  childIssues: number[],
  readiness: ReadinessInfo,
  specPath: string,
  log: (type: EventKind, msg: string, extra?: { readiness?: ReadinessInfo }) => void,
  prefix = '',
): PlanResult {
  const reason =
    prefix +
    (childIssues.length > 0
      ? `issue exceeds the size gate (${readiness.sizeReason ?? 'too big'}) — decomposed into ${childIssues.map((n) => `#${n}`).join(', ')}`
      : `issue exceeds the size gate (${readiness.sizeReason ?? 'too big'}) — parked for decomposition`);
  log('size-gate-escalated', reason, { readiness });
  return {
    ok: false,
    route: 'claude',
    specPath,
    model: '',
    escalate: reason,
    designArtifact: null,
    ...(childIssues.length > 0 ? { decomposed: { childIssues } } : {}),
  };
}

async function planPhaseImpl(opts: {
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  constitution: Constitution | null;
  router: ModelRouter;
  octokit: Octokit;
  log: (
    type: EventKind,
    msg: string,
    extra?: {
      failoverReason?: FailoverReason;
      model?: string;
      tokens?: { input: number; output: number };
      readiness?: ReadinessInfo;
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
  /** sizeGate.mode (ADR-0147). 'slice' records a slice plan and plans only the current slice. Ignored when enforceSizeGate is false. */
  sizeGateMode?: SizeGateMode;
  /** Slice cap for sizeGate.mode 'slice' (ADR-0156); default DEFAULT_MAX_SLICES. */
  maxSlices?: number;
  /** Stop PLAN before BUILD when a worse/unknown behaviorDelta row is not in openQuestions (#1819). Default false = log only. */
  blockUnresolvedRegressions?: boolean;
  /** Local-only mode: force the route to codex so builds use a local harness. */
  localOnly?: boolean;
  /** Repo config pins the build route (`.factory/config.json` → `route`). Forced
   *  after plan so the spec frontmatter stays the frozen truth. */
  preferredRoute?: 'codex' | 'claude' | 'opencode';
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
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

  let readiness = scoreIssueReadiness({ title: issueTitle, body: issueBody });
  if (
    opts.enforceReadiness &&
    source.kind === GITHUB_ISSUE_SOURCE &&
    readiness.template === 'factory-task' &&
    !readiness.pass
  ) {
    const params = source.params as GithubIssueParams;
    const [owner, name] = params.repo.split('/');
    const maxEnrichmentAttempts = 2; // one initial call + one retry with the missing headings named (#816)
    log('readiness_enrichment_started', `enriching incomplete factory-task issue #${params.issue}`);
    try {
      let previous: ReadinessEnrichmentRetryContext | null = null;
      let lastModel = '';
      let lastReason = '';
      let enriched = false;
      for (let attempt = 1; attempt <= maxEnrichmentAttempts; attempt++) {
        const input = { title: issueTitle, body: issueBody, missing: readiness.missing };
        const prompt =
          previous === null
            ? buildReadinessEnrichmentPrompt(input)
            : buildReadinessEnrichmentRetryPrompt(input, previous);
        const enrichment = await router.run('readiness_enrich', prompt, {
          worktree,
          timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
          onLog: (msg) => log('router', msg),
        });
        lastModel = enrichment.model;
        const candidate = scoreIssueReadiness({ title: issueTitle, body: enrichment.output });
        if (candidate.template === 'factory-task' && candidate.pass) {
          await octokit.rest.issues.update({ owner, repo: name, issue_number: params.issue, body: enrichment.output });
          issueBody = enrichment.output;
          readiness = candidate;
          log(
            'readiness_enrichment_succeeded',
            `enriched factory-task issue #${params.issue} with ${enrichment.model}`,
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
        return { ok: false, route: 'claude', specPath, model: lastModel, escalate: lastReason, designArtifact: null };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log('readiness_enrichment_failed', `enrichment failed: ${reason}`);
      return {
        ok: false,
        route: 'claude',
        specPath,
        model: '',
        escalate: `readiness enrichment failed: ${reason}`,
        designArtifact: null,
      };
    }
  }

  let planningSlice = false;
  let sliceLabel = '';
  let plannedSlice: PlanResult['slice'];
  if (enforceSizeGate && opts.sizeGateMode === 'slice' && source.kind === GITHUB_ISSUE_SOURCE) {
    const params = source.params as GithubIssueParams;
    const gate = await resolveSliceGate({
      issue: params.issue,
      repo: params.repo,
      title: issueTitle,
      body: issueBody,
      oversized: readiness.template === 'factory-task' && readiness.sizeOk === false,
      sizeReason: readiness.sizeReason,
      maxSlices: opts.maxSlices ?? DEFAULT_MAX_SLICES,
      worktree,
      router,
      octokit,
      log: (type, msg) => log(type, msg),
      timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
      onProviderFailure,
    });
    const park = (reason: string): PlanResult => ({
      ok: false,
      route: 'claude',
      specPath,
      model: '',
      escalate: reason,
      designArtifact: null,
    });
    if (gate.kind === 'park') {
      log('escalate', gate.reason);
      return park(gate.reason);
    }
    if (gate.kind === 'over-cap') {
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
        const reason = `slice ${slice.index}/${plan.slices.length} of #${params.issue} exceeds the size gate (${readiness.sizeReason ?? 'too big'}) — parked; a slice is never sliced again`;
        log('size-gate-escalated', reason);
        return park(reason);
      }
    }
  }

  if (
    enforceSizeGate &&
    opts.sizeGateMode !== 'slice' &&
    source.kind === GITHUB_ISSUE_SOURCE &&
    readiness.template === 'factory-task' &&
    readiness.sizeOk === false
  ) {
    const params = source.params as GithubIssueParams;
    const decomposeResult = await decomposeOversizedIssue({
      issue: params.issue,
      repo: params.repo,
      title: issueTitle,
      body: issueBody,
      worktree,
      router,
      octokit,
      log: (type, msg) => log(type, msg),
      timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
      onProviderFailure,
      fileSubIssues: true,
    });
    return fileModeEscalation(decomposeResult.childIssues, readiness, specPath, log);
  }

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
    const prompt = applySteering(
      buildPlanPrompt({ issue, issueTitle, issueBody, specPath, constitutionCtx, adrCtx }),
      steering,
    );

    if (replans > 0) {
      log('plan', `Re-planning after operator redirect (attempt ${replans + 1})`);
    }
    const archived = await archiveSpec(specPath);
    if (archived.length > 0) {
      log('plan', `Archived existing spec before planning: ${archived.join(', ')}`);
    }

    const result = await router.run('plan', prompt, {
      worktree,
      timeoutSeconds: timeoutSeconds ?? 1800,
      modelOverride,
      modelFallbacks,
      onProviderFailure,
      onLog: (msg) => log('router', msg),
    });

    for (const f of failoversFrom(result.attempts)) {
      log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
        failoverReason: f.reason,
      });
    }

    // Check for escalation
    if (isEscalation(result.output)) {
      const escalateLine = escalationLine(result.output);
      log('escalate', escalateLine ?? 'plan escalated');
      return {
        ok: false,
        route: 'claude',
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
    const parsed = await readSpec(specPath);
    let route: 'codex' | 'claude' | 'opencode' = parsed.route ?? 'claude';

    if (localOnly && route !== 'codex') {
      log('warn', 'local-only mode requires a local Codex harness — forcing route to codex');
      route = 'codex';
      await updateSpecRoute(specPath, 'codex', 'local-only');
    }

    if (route === 'codex' && isCodexDisabled) {
      log('warn', 'codex unavailable — falling back to claude');
      route = 'claude';
      // Keep the persisted spec's frontmatter in sync with the actual route,
      // since it's the frozen artifact downstream consumers (eval scoring, PR review) read.
      await updateSpecRoute(specPath, 'claude', 'codex-disabled');
    }

    if (opts.preferredRoute && route !== opts.preferredRoute) {
      log('model-override', `pinned build route ${opts.preferredRoute} — overriding plan's ${route}`);
      route = opts.preferredRoute;
      await updateSpecRoute(specPath, opts.preferredRoute, 'repo-config-pin');
    }

    const { artifact: designArtifact, errors: designErrors, coerced: designCoerced } = parseDesignArtifact(parsed.data);
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

      // Build-scope gate: a plan whose declared surface is large enough to take
      // ~40 min of agent churn is a planning failure, not a build problem.
      // Decompose the issue instead of handing a mega-slice to BUILD (Patrick,
      // 2026-08-15: "40 minutes is too long... fix the planning part to detect
      // complexity and reduce the time the build needs to work").
      if (
        enforceSizeGate &&
        source.kind === GITHUB_ISSUE_SOURCE &&
        (designArtifact.targetTypes.length > MAX_BUILD_TARGET_TYPES ||
          designArtifact.signatures.length > MAX_BUILD_SIGNATURES ||
          designArtifact.callGraph.length > MAX_BUILD_CALL_EDGES)
      ) {
        const params = source.params as GithubIssueParams;
        const scope =
          `${designArtifact.targetTypes.length} target types, ${designArtifact.signatures.length} signatures, ` +
          `${designArtifact.callGraph.length} call edges`;
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
        if (opts.sizeGateMode === 'slice') {
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
          if (gate.kind === 'slice') {
            const reason = `plan scope exceeds the bounded-build budget (${scope}) — sliced into ${gate.plan.slices.length} slice(s); the next run plans slice ${gate.slice.index}`;
            return { ...park(reason), sliced: { sliceCount: gate.plan.slices.length } };
          }
          if (gate.kind === 'over-cap') {
            log('size-gate-escalated', gate.reason);
            return park(gate.reason);
          }
          const reason = gate.kind === 'park' ? gate.reason : fileReason;
          log('escalate', reason);
          return park(reason);
        }
        await decomposeOversizedIssue({
          issue: params.issue,
          repo: params.repo,
          title: issueTitle,
          body: issueBody,
          worktree,
          router,
          octokit,
          log: (type, msg) => log(type, msg),
          timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
          onProviderFailure,
        });
        log('size-gate-escalated', fileReason);
        return park(fileReason);
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
      const blockedReason = blockedNoChangeSpecReason(parsed.body);
      if (blockedReason) {
        log('escalate', blockedReason);
        return { ok: false, route, specPath, model: result.model, escalate: blockedReason, designArtifact: null };
      }
      log('design_artifact_invalid', `spec frontmatter has no valid design artifact: ${designErrors.join('; ')}`);
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
