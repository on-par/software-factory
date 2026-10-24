// src/phases/build.ts — BUILD phase: worker model implements the frozen spec

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { captureDiffBase, collectDesignDiff } from '../checkers/design-smells.js';
import { resolveLintCommands, VERIFY_PS1_ARGV } from '../checkers/index.js';
import { fileExists } from '../checkers/probe.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { readDesignArtifact, renderDesignGrounding } from '../design/index.js';
import { laneEnv } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import { type BudgetGuard, isBudgetStopError } from '../router/budget-guard.js';
import { routerFailureOf } from '../router/executor-error.js';
import { type ContextCeilingNotice, formatContextCeilingNotice } from '../router/context-ceiling.js';
import { failoversFrom, type ModelRouter, type ProviderFailureInfo, type RouterResult } from '../router/index.js';
import { isEgressEnforced, type SandboxEventType, type SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { Constitution, FailoverReason } from '../types/index.js';
import { envErrorLine, sandboxEnvParkMessage } from '../environment/sandbox-env.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import type { BuildRoutePin } from '../config/repo.js';
import { classifyNoDiff, renderNoDiffDetail, workerOutputTail, type NoDiffCause } from './build-no-diff.js';
import { loadAffectedConfig } from './check-affected.js';
import { renderLintRulesInForce } from './build-lint-rules.js';
import { failOverOpencodeBuild } from './build-opencode-failover.js';
import {
  buildClaudePrompt,
  buildCommitOnlyPrompt,
  buildLocalSmallPrompt,
  buildOpencodePrompt,
} from './build-prompts.js';

export { buildClaudePrompt, buildCommitOnlyPrompt, buildLocalSmallPrompt, buildOpencodePrompt };

export interface BuildResult {
  ok: boolean;
  model: string;
  route: BuildRoutePin;
  escalate?: string;
  /** Set on a non-escalation build failure; 'no_diff' = worker produced no diff,
   *  'junk_only_diff' = worker changed only generated/cache files, 'budget_exceeded' = the
   *  budget guard stopped the worker mid-session (#3320). */
  reason?: 'no_diff' | 'junk_only_diff' | 'budget_exceeded' | 'sandbox_env';
  /** Park message when the worker printed an ENV-ERROR: line (#3332). */
  sandboxEnv?: string;
  /** Why an empty-diff build produced nothing (#3273); set only with reason 'no_diff'. */
  noDiffCause?: NoDiffCause;
  /** Rendered cause, open questions and redacted worker tail for the fail event and park message (#3273). */
  noDiffDetail?: string;
  /** Run-start HEAD SHA captured before the worker ran (#1162) — checkPhase's
   *  fallback diff base for remote-less checkouts (#1211). */
  diffBase?: string;
  /** Why the build ran on a model other than the one first tried (cross-harness or in-tier
   *  failover), so a summary can say a pin was not used (#2511). */
  failoverReason?: FailoverReason;
}

function netLabel(sandbox: SandboxPolicy): string {
  if (sandbox.allowHosts.length === 0) return 'deny-all';
  return isEgressEnforced(sandbox) ? 'allowlist enforced' : 'open (report-only)';
}

export async function buildPhase(opts: Parameters<typeof buildPhaseImpl>[0]): Promise<BuildResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'build',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    async () => {
      try {
        return await buildPhaseImpl(opts);
      } catch (err) {
        if (!isBudgetStopError(err)) throw err;
        return { ok: false, model: err.model, route: opts.route, reason: 'budget_exceeded' };
      }
    },
    (r) => r.ok,
    (r) =>
      r.ok
        ? `build complete (model ${r.model})`
        : r.reason === 'budget_exceeded'
          ? 'build stopped: per-issue budget exceeded'
          : r.reason === 'sandbox_env'
            ? 'build stopped: sandbox environment error'
            : r.reason === 'junk_only_diff'
              ? 'build failed: worker changed only generated/cache files'
              : r.reason === 'no_diff'
                ? 'build failed: worker produced no diff'
                : `build escalated: ${r.escalate ?? 'unknown'}`,
  );
}

async function buildPhaseImpl(opts: {
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  branch: string;
  constitution: Constitution | null;
  route: BuildRoutePin;
  router: ModelRouter;
  log: (
    type: EventKind,
    msg: string,
    extra?: {
      failoverReason?: FailoverReason;
      model?: string;
      tokens?: { input: number; output: number };
      durationMs?: number;
    },
  ) => void;
  timeoutSeconds?: number;
  skipCI?: boolean;
  /** Local-only workspace runs (#508): use the commit-only prompt on every
   *  route — never instruct the worker to push, open a PR, or watch CI.
   *  Forces commit-only even when publishFromBuild is set. */
  disablePublish?: boolean;
  /** Opt-in (#1867, build.publishFromBuild): the claude route sends the publishing prompt (push, open PR, wait for CI). Default false = commit-only on every route. Ignored when disablePublish is set. */
  publishFromBuild?: boolean;
  /** false when runIssue drives provider failover from models.providerOrder (#3338): a usage cap rethrows to the phase boundary instead of entering the cross-harness ladder. Default true. */
  crossProviderLadder?: boolean;
  modelOverride?: string;
  /** modelOverride is the user's build pin (#367, #2510). A pinned build crosses harnesses only on
   *  usage_cap or rate_limit; any other failure (local_auth included) parks like a pinned plan. */
  pinnedModel?: boolean;
  /** The repo pinned the build route in .factory/config.json (ADR-0092); the opencode route never crosses harnesses then (#2885). */
  routePinned?: boolean;
  /** Cross-provider Codex fallback used when a Claude worker is capped or unavailable. */
  codexFallbackModel?: string;
  onProviderFailure?: (info: ProviderFailureInfo) => void | Promise<void>;
  sandbox?: SandboxPolicy;
  steering?: ConsumedSteering;
  appPort?: number;
  /** Stable lane URL from the factory proxy (e.g. http://<lane>.factory.localhost), when running. */
  appBaseUrl?: string;
  codexDisabled?: boolean;
  autoFailover?: {
    enabled: boolean;
    fallbackModel?: string;
    onQuotaExhausted?: (info: { provider: string; reason: FailoverReason }) => void | Promise<void>;
  };
  onPgid?: (pgid: number) => void;
  /** Per-issue budget guard (#3320); passed to every BUILD router call. */
  budgetGuard?: BudgetGuard;
  /** Local-only mode: use the compact local-small prompt on the codex route. */
  localOnly?: boolean;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** The plan's open questions (#3273); a no-diff build with any is classed open-questions. */
  openQuestions?: readonly string[];
  /** Rendered "## Previous attempt" note (#3373); empty or absent = first run. */
  previousAttempt?: string;
  /** Per-run id minted by runIssue; becomes SharedCompilationId=factory-<runId> for .NET lanes (#1910). */
  runId?: string;
  /** Parent ref of a stacked slice (#2717); the no-diff check diffs against it instead of origin/main. Absent = default base. */
  parentBaseRef?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** Injectable for tests; defaults to collectDesignDiff. */
  collectDiff?: typeof collectDesignDiff;
  /** Injectable for tests; defaults to captureDiffBase. */
  captureBase?: typeof captureDiffBase;
  onWorkerResult?: (result: RouterResult) => Promise<void>;
}): Promise<BuildResult> {
  const {
    issue,
    worktree,
    specPath,
    branch,
    constitution,
    router,
    log,
    timeoutSeconds,
    skipCI,
    disablePublish,
    publishFromBuild,
    modelOverride: modelOverrideOpt,
    codexFallbackModel,
    onProviderFailure,
    sandbox,
    steering,
    appPort,
    appBaseUrl,
    onPgid,
    runId,
    parentBaseRef,
    previousAttempt,
  } = opts;
  let route = opts.route;

  const constitutionCtx = buildConstitutionContext(constitution) + (await renderLintRulesInForce(worktree));
  const spec = await readFile(specPath, 'utf-8').catch(() => '');
  const designArtifact = await readDesignArtifact(specPath);
  const designGrounding = designArtifact ? renderDesignGrounding(designArtifact) : '';
  // BUILD names the lint checker's commands only when verify.sh does not already cover them (#2829).
  const hasVerifySh = await fileExists(join(worktree, 'scripts/verify.sh'));
  // A verify.ps1-only repo is verified with the pwsh command CHECK runs (#3471).
  const verifyCommand =
    !hasVerifySh && (await fileExists(join(worktree, 'scripts/verify.ps1'))) ? VERIFY_PS1_ARGV.join(' ') : undefined;
  const lintCommands = hasVerifySh ? [] : await resolveLintCommands({ worktree }).catch(() => []);
  const affectedTestsCommand = loadAffectedConfig(worktree)?.command;
  const promptOpts = {
    issue,
    specPath,
    constitutionCtx,
    spec,
    appPort,
    appBaseUrl,
    designGrounding,
    lintCommands,
    verifyCommand,
    affectedTestsCommand,
    previousAttempt,
  };
  if (designArtifact) {
    log(
      'design_artifact_received',
      `design artifact received (open questions: ${designArtifact.openQuestions.length}, ` +
        `target types: ${designArtifact.targetTypes.length}, ` +
        `signatures: ${designArtifact.signatures.length}, ` +
        `call edges: ${designArtifact.callGraph.length})`,
    );
  }
  const localOnly = opts.localOnly ?? false;
  const isCodexDisabled = opts.codexDisabled ?? false;

  // Commit-only unless the repo opts in (#1867); local-only always stays commit-only (#508).
  const claudeRoutePrompt = (): string =>
    publishFromBuild && !disablePublish
      ? buildClaudePrompt({
          issue,
          branch,
          specPath,
          constitutionCtx,
          skipCI,
          appPort,
          appBaseUrl,
          designGrounding,
          lintCommands,
          verifyCommand,
          affectedTestsCommand,
          previousAttempt,
        })
      : buildCommitOnlyPrompt(promptOpts);
  let prompt: string;
  let taskType: 'build_codex' | 'build_claude' | 'build_opencode' | 'build_command';

  let modelOverride = modelOverrideOpt;
  if (route === 'codex' && isCodexDisabled) {
    log('warn', 'codex unavailable — falling back to claude');
    route = 'claude';
    // A Codex-harness override would put that model first in the claude route's chain and run it
    // anyway (an override skips the tier's provider filter), so a pinned or fallback codex model
    // cannot ride the flip. Drop it and let the claude route pick its own worker (#1367).
    if (modelOverride && router.registryRef.isCodexModel(modelOverride)) {
      log(
        'model_override_ignored',
        `build model ${modelOverride} needs the codex route, which is unavailable — using the claude route's default worker`,
      );
      modelOverride = undefined;
    }
  }

  if (route === 'codex') {
    taskType = 'build_codex';
    prompt = localOnly ? buildLocalSmallPrompt({ issue, branch, spec }) : buildCommitOnlyPrompt(promptOpts);
  } else if (route === 'opencode') {
    taskType = 'build_opencode';
    prompt = buildOpencodePrompt(promptOpts);
  } else if (route === 'command') {
    taskType = 'build_command';
    prompt = buildCommitOnlyPrompt(promptOpts);
  } else {
    taskType = 'build_claude';
    prompt = claudeRoutePrompt();
  }

  prompt = applySteering(prompt, steering);

  log('build', `Starting build phase (route: ${route})`);
  if (sandbox) {
    log('sandbox', `containment active (runtime ${sandbox.runtime}, net ${netLabel(sandbox)})`);
  }

  const runOpts = {
    worktree,
    timeoutSeconds: timeoutSeconds ?? 7200,
    modelOverride,
    sandbox,
    onSandboxEvent: (type: SandboxEventType, detail: string) => log(type, detail),
    onLog: (msg: string) => log('router', msg),
    env: laneEnv(appPort, process.env, appBaseUrl, worktree, runId),
    onPgid,
    onProviderFailure,
    budgetGuard: opts.budgetGuard,
    onContextCeiling: (n: ContextCeilingNotice) => log('context_ceiling', formatContextCeilingNotice(n)),
  };

  // Captured before the worker runs so the post-build diff has a correct base
  // even in checkouts with no origin/main or origin/master (#1162).
  const fallbackBaseRef = await (opts.captureBase ?? captureDiffBase)(worktree);

  let result: RouterResult;
  let crossHarnessReason: FailoverReason | undefined;
  try {
    result = await router.run(taskType, prompt, runOpts);
  } catch (err) {
    const routerFailure = routerFailureOf(err);
    const reason = routerFailure?.reason;
    if (opts.crossProviderLadder === false && reason === 'usage_cap') throw err;
    const attempts = routerFailure?.attempts;
    // These all indicate a provider problem rather than a bad task. Preserve
    // the frozen spec and continue on the other provider when one is available.
    const providerFailure =
      reason === 'usage_cap' ||
      reason === 'rate_limit' ||
      reason === 'timeout' ||
      reason === 'unavailable' ||
      reason === 'local_auth' ||
      reason === 'cli_missing';
    const crossHarnessOk =
      opts.pinnedModel === true ? reason === 'usage_cap' || reason === 'rate_limit' : providerFailure;
    if (providerFailure && !crossHarnessOk) {
      log(
        'model-override',
        `pinned build model ${modelOverride} failed (${reason}); a pin only fails over on usage_cap or rate_limit (#367)`,
      );
    }
    // Only swap when we actually ran the codex route and it was exhausted on a
    // quota reason. The router only throws after trying every eligible codex
    // worker, so reaching here already means "no Codex-harness worker remains".
    if (taskType === 'build_claude' && crossHarnessOk) {
      if (opts.autoFailover && !opts.autoFailover.enabled) throw err;
      const fallback = codexFallbackModel ?? router.resolveAll('build_codex')[0];
      if (!fallback) throw err;
      log('worker_failover', `Claude build workers exhausted (${reason}) — continuing on Codex: to_model=${fallback}`, {
        failoverReason: reason,
      });
      route = 'codex';
      crossHarnessReason = reason;
      result = await router.run('build_codex', buildCommitOnlyPrompt(promptOpts), {
        ...runOpts,
        retryCause: 'failover',
        modelOverride: fallback,
      });
    } else if (taskType === 'build_opencode' && (reason === 'usage_cap' || reason === 'rate_limit')) {
      ({ route, result } = await failOverOpencodeBuild({
        router,
        reason,
        err,
        attempts: attempts ?? [],
        runOpts,
        build: opts,
        prompts: { claude: claudeRoutePrompt, codex: () => buildCommitOnlyPrompt(promptOpts) },
      }));
      crossHarnessReason = reason;
    } else if (taskType !== 'build_codex' || !crossHarnessOk || reason === undefined) throw err;
    else {
      if (opts.autoFailover && !opts.autoFailover.enabled) throw err;
      const fromModel = attempts?.at(-1)?.model ?? 'unknown';
      const provider = router.registryRef.get(fromModel)?.provider ?? 'openai';
      const fallback = opts.autoFailover?.fallbackModel;
      const toModel =
        fallback && router.resolveAll('build_claude').includes(fallback)
          ? fallback
          : router.resolveAll('build_claude')[0];
      if (!toModel) throw err;
      log(
        'worker_failover',
        `Codex build workers exhausted (${reason}) — continuing on claude: ` +
          `from_model=${fromModel} to_model=${toModel} ` +
          `from_route=build_codex to_route=build_claude reason=${reason}`,
        { failoverReason: reason },
      );
      try {
        await opts.autoFailover?.onQuotaExhausted?.({ provider, reason });
      } catch (breakerErr) {
        // Best-effort circuit-breaker bookkeeping — a write failure here must
        // never turn a successful codex→claude failover into a hard build
        // failure.
        log('warn', `provider breaker callback failed (non-fatal): ${(breakerErr as Error).message}`);
      }
      route = 'claude';
      crossHarnessReason = reason;
      const claudePrompt = applySteering(claudeRoutePrompt(), steering);
      result = await router.run('build_claude', claudePrompt, {
        ...runOpts,
        retryCause: 'failover',
        ...(toModel === fallback ? { modelOverride: fallback } : {}),
      });
    }
  }

  for (const f of failoversFrom(result.attempts)) {
    log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }
  await opts.onWorkerResult?.(result);
  const envLine = envErrorLine(result.output ?? '');
  if (envLine) {
    log('build', `worker reported a sandbox environment error: ${envLine}`);
    const sandboxEnv = sandboxEnvParkMessage('build', envLine);
    return { ok: false, model: result.model, route, reason: 'sandbox_env', sandboxEnv };
  }
  if (isEscalation(result.output)) {
    const escalateLine = escalationLine(result.output);
    log('escalate', escalateLine ?? 'build escalated');
    return { ok: false, model: result.model, route, escalate: escalateLine };
  }

  // Second positional arg stays undefined so injected test stubs with the old
  // 1-arg shape still typecheck against `typeof collectDesignDiff`.
  const diff = await (opts.collectDiff ?? collectDesignDiff)(worktree, undefined, {
    fallbackBaseRef,
    ...(parentBaseRef !== undefined ? { baseRefOverride: parentBaseRef } : {}),
  });
  if (diff.skipReason) {
    log('build', `diff post-condition skipped — ${diff.skipReason}`);
  } else if (diff.text === '') {
    const junkOnly = (diff.excludedPaths?.length ?? 0) > 0;
    const detail = junkOnly
      ? `worker changed only generated/cache files against ${diff.baseRef} (${diff.excludedPaths!.slice(0, 10).join(', ')}); no implementation was produced`
      : `worker produced no diff against ${diff.baseRef}; no implementation was produced`;
    const output = result.output ?? '';
    const tail = workerOutputTail(output);
    const cause = junkOnly ? undefined : classifyNoDiff({ output, openQuestions: opts.openQuestions });
    const noDiffDetail = renderNoDiffDetail({ cause, tail, openQuestions: opts.openQuestions });
    log('fail', `${detail}\n${noDiffDetail}`);
    return {
      ok: false,
      model: result.model,
      route,
      reason: junkOnly ? 'junk_only_diff' : 'no_diff',
      ...(cause ? { noDiffCause: cause } : {}),
      noDiffDetail,
    };
  }

  log('build', `Build complete with model ${result.model}`, { model: result.model });
  const failoverReason = crossHarnessReason ?? result.failoverReason;
  return {
    ok: true,
    model: result.model,
    route,
    diffBase: fallbackBaseRef,
    ...(failoverReason ? { failoverReason } : {}),
  };
}
