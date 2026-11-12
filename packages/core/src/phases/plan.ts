// src/phases/plan.ts — PLAN phase: boss model reads issue, explores repo, freezes spec, picks route

import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Octokit } from '@octokit/rest';
import { createFsReader } from '@on-par/repo-context';

import { loadAgentMemoryCtx } from '../agent-memory/index.js';
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
import type { PlanResult } from './plan-result.js';
import { settlePlanRoute } from './plan-route.js';
import { codexUnavailable, type RouteCapabilities } from './route-capabilities.js';
import { blockedNoChangeSpecReason, noBuildReason, planSummary, specWriteDeniedResult } from './plan-spec-guards.js';
import { renderChildIssueBody } from '../readiness/decompose.js';
import { resolveSliceGate } from '../readiness/slice-gate.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import { DEFAULT_MAX_SLICES } from '../readiness/slice-plan.js';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_TOKEN_BUDGET,
  estimatePlanSize,
  planOverBudget,
  type SizeBudget,
} from '../readiness/size.js';
import { scoreIssueReadiness } from '../readiness/index.js';
import type { ModelRouter, ProviderFailureInfo, RouterResult } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { failoversFrom } from '../router/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import { archiveSpec, readSpec, writeSpec } from '../spec/index.js';
import type { EscalateKind } from '../types/index.js';
import { classifyEscalation } from './plan-escalation.js';
import { buildPlanPrompt } from './plan-prompt.js';
import { routeStackSlice } from './plan-stack-slice.js';
import type { Constitution, FailoverReason, ReadinessInfo } from '../types/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import { GITHUB_ISSUE_SOURCE, type GithubIssueParams } from '../work/github-issue.js';
import { createDefaultWorkSourceRegistry, type WorkRequestSourceKind, type WorkSourceRegistry } from '../work/index.js';

import {
  buildDesignArtifactRetryPrompt,
  designArtifactInvalidMessage,
  MAX_DESIGN_ARTIFACT_RETRIES,
} from './plan-design-retry.js';
import { defaultBuildRoute, resolveRunnableBuildRoute, runnableBuildRoutes } from './plan-routes.js';

export type { PlanResult };
export { classifyEscalation };
export { buildDesignArtifactRetryPrompt, MAX_DESIGN_ARTIFACT_RETRIES };
export { buildPlanPrompt } from './plan-prompt.js';
export { defaultBuildRoute, resolveRunnableBuildRoute, runnableBuildRoutes };

/**
 * REST API version pinned on the readiness-enrichment issues.update call (#2385). GitHub serves 2022-11-28 when no
 * header is sent; it is deprecated (sunset 2028-03-10). Scoped to this call because 2026-03-10 has breaking changes
 * on other endpoints (e.g. merge_commit_sha, singular assignee).
 */
const GITHUB_ISSUE_UPDATE_API_VERSION = '2026-03-10';

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
  issue: WorkKey;
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
  /** Providers whose breaker is open at the stage boundary (#3226). */
  skipProviders?: ReadonlySet<string>;
  onProviderFailure?: (info: ProviderFailureInfo) => void | Promise<void>;
  branch?: string;
  approvalGate?: ApprovalGate;
  drainSteering?: () => ConsumedSteering;
  maxReplans?: number;
  routeCapabilities?: RouteCapabilities;
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
  /** sizeGate.mode. 'stack' (ADR-0161) records a slice plan and plans the lowest pending slice, or an explicit `sliceIndex`. Ignored when enforceSizeGate is false. */
  sizeGateMode?: SizeGateMode;
  parkOverBudget?: boolean;
  /** Slice-plan store for a non-issue source in stack mode (#3813); issue sources default to the issue comment. */
  slicePlanStore?: SlicePlanStore;
  /** Slice cap for sizeGate.mode 'stack' (ADR-0156, ADR-0161); default DEFAULT_MAX_SLICES. */
  maxSlices?: number;
  /** sizeGate.tokenBudget / maxFiles (#3350); default DEFAULT_TOKEN_BUDGET / DEFAULT_MAX_FILES. */
  sizeBudget?: SizeBudget;
  /** ADR-0161 stack mode: plan this 1-based slice of the trusted slice plan. Default: the lowest pending slice. Ignored outside stack mode. */
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
    skipProviders,
    onProviderFailure,
    branch,
    approvalGate,
    drainSteering,
  } = opts;
  const maxReplans = opts.maxReplans ?? 3;
  const enforceSizeGate = opts.enforceSizeGate ?? true;
  const localOnly = opts.localOnly ?? false;
  const routeCapabilities = opts.routeCapabilities ?? { codexDisabled: false, codexBreakerOpen: false, localOnly };

  const workSources = opts.workSources ?? createDefaultWorkSourceRegistry({ octokit });
  const source = opts.workSource ?? {
    kind: GITHUB_ISSUE_SOURCE,
    params: { repo, issue: issueNumberOf(issue) } satisfies GithubIssueParams,
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

  let readiness = scoreEnrichedIssueReadiness({ title: issueTitle, body: issueBody, labels: work.labels });
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
        const candidate = scoreIssueReadiness({ title: issueTitle, body: enrichment.output, labels: work.labels });
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

  // ADR-0161: stack mode records a slice plan and may plan an explicit slice.
  const sizeBudget = opts.sizeBudget ?? { tokenBudget: DEFAULT_TOKEN_BUDGET, maxFiles: DEFAULT_MAX_FILES };
  const stackMode = opts.sizeGateMode === 'stack';
  const sliceGateOn = source.kind === GITHUB_ISSUE_SOURCE || (stackMode && opts.slicePlanStore !== undefined);
  const sliceIssue =
    source.kind === GITHUB_ISSUE_SOURCE ? (source.params as GithubIssueParams).issue : issueNumberOf(issue);
  const sliceRepo = source.kind === GITHUB_ISSUE_SOURCE ? (source.params as GithubIssueParams).repo : repo;
  const sliceDeps = {
    issue: sliceIssue,
    repo: sliceRepo,
    maxSlices: opts.maxSlices ?? DEFAULT_MAX_SLICES,
    store: opts.slicePlanStore,
    worktree,
    router,
    octokit,
    log,
    timeoutSeconds: Math.min(timeoutSeconds ?? 1800, 300),
    onProviderFailure,
  };
  let planningSlice = false;
  let sliceLabel = '';
  let plannedSlice: PlanResult['slice'];
  if (enforceSizeGate && stackMode && sliceGateOn && !opts.parkOverBudget) {
    const gate = await resolveSliceGate({
      ...sliceDeps,
      title: issueTitle,
      body: issueBody,
      // #3350: issue prose never slices; only an existing trusted slice plan selects a slice here.
      oversized: false,
      ...(opts.sliceIndex !== undefined ? { sliceIndex: opts.sliceIndex } : {}),
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
    if (gate.kind === 'over-cap' || gate.kind === 'unsliceable') {
      log('size-gate-escalated', gate.reason);
      return park(gate.reason);
    }
    if (gate.kind === 'slice') {
      const { plan, slice } = gate;
      // A brief's slice number is a stand-in run number (#3813): keep it out of the body and label.
      const parentIssue = source.kind === GITHUB_ISSUE_SOURCE ? sliceIssue : undefined;
      issueTitle = `${issueTitle} — slice ${slice.index}/${plan.slices.length}: ${slice.title}`;
      issueBody = renderChildIssueBody(slice.story, parentIssue);
      readiness = scoreIssueReadiness({ title: issueTitle, body: issueBody });
      planningSlice = true;
      plannedSlice = { plan, index: slice.index };
      sliceLabel = `slice ${slice.index}/${plan.slices.length}${parentIssue === undefined ? '' : ` of #${parentIssue}`}`;
      log('plan', `planning ${sliceLabel}: ${slice.title}`);
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

  const stackSlice = (scope: string, sizeReason: string, fileReason: string) =>
    routeStackSlice({
      ...sliceDeps,
      title: issueTitle,
      body: issueBody,
      oversized: true,
      sizeReason,
      planningSlice,
      sliceLabel,
      scope,
      fileReason,
    });
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
    !codexUnavailable(routeCapabilities) &&
    fastPathRouteOk &&
    isFastPathEligible({ issueBody, readinessPassed: readiness.pass })
  ) {
    const fastPath = buildFastPathSpec({ issue: issueNumberOf(issue), title: issueTitle, issueBody });
    await writeSpec(specPath, {
      body: fastPath.markdown,
      data: fastPath.frontmatter,
      designJson: JSON.stringify(fastPath.frontmatter.design, null, 2),
      designMd: renderDesignArtifact(fastPath.frontmatter.design, issueNumberOf(issue)),
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

  const agentMemoryCtx = opts.laneId ? await loadAgentMemoryCtx(worktree, opts.laneId, log) : '';

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
        agentMemoryCtx,
        runnableRoutes,
        sizeGate,
        stackSizeGate: stackMode && enforceSizeGate && !opts.parkOverBudget,
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
        skipProviders,
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
        const outcome =
          escalateKind === 'split' && stackMode && enforceSizeGate && sliceGateOn && !opts.parkOverBudget
            ? await stackSlice(escalateLine ?? 'planner requested a split', escalateLine ?? '', escalateLine ?? '')
            : undefined;
        return {
          ok: false,
          route: failureRoute,
          specPath,
          model: result.model,
          escalate: outcome?.reason ?? escalateLine,
          designArtifact: null,
          ...(outcome?.sliceCount === undefined ? {} : { sliced: { sliceCount: outcome.sliceCount } }),
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
      capabilities: routeCapabilities,
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
        designMd: renderDesignArtifact(designArtifact, issueNumberOf(issue)),
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
      if (!designArtifact.outline) {
        log(
          'design_outline_missing',
          'design artifact has no vertical-slice outline — BUILD will run without per-step files and checks',
        );
      }
      if (designArtifact.openQuestions.length > 0) {
        const summary = designArtifact.openQuestions.join('; ');
        const truncated = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
        log('design_open_questions', `plan has ${designArtifact.openQuestions.length} open question(s): ${truncated}`);
      }

      // Build-scope gate (#3350): park or slice plans that exceed the bounded BUILD budget.
      const overBudget = planOverBudget(estimatePlanSize(designArtifact, { worktree }), sizeBudget);
      if (enforceSizeGate && sliceGateOn && overBudget !== null) {
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
        if (opts.parkOverBudget) {
          log('size-gate-escalated', fileReason);
          return park(fileReason);
        }
        // ADR-0147: in stack mode the post-plan gate slices a whole issue; a slice is never sliced again.
        if (stackMode) {
          const outcome = await stackSlice(scope, `plan scope exceeds the bounded-build budget: ${scope}`, fileReason);
          if (outcome)
            return {
              ...park(outcome.reason),
              ...(outcome.sliceCount === undefined ? {} : { sliced: { sliceCount: outcome.sliceCount } }),
            };
        } else {
          log('size-gate-escalated', fileReason);
          return park(fileReason);
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
      issue: issueNumberOf(issue),
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
