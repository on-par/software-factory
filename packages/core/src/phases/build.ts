import { type WorkKey } from '../work/work-key.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { captureDiffBase, collectDesignDiff } from '../checkers/design-smells.js';
import { resolveLintCommands, VERIFY_PS1_ARGV } from '../checkers/index.js';
import { fileExists } from '../checkers/probe.js';
import { harnessAutoLoads } from '../harness/catalog.js';
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
import { codexUnavailable, type RouteCapabilities } from './route-capabilities.js';
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
  reason?: 'no_diff' | 'junk_only_diff' | 'budget_exceeded' | 'sandbox_env';
  sandboxEnv?: string;
  noDiffCause?: NoDiffCause;
  noDiffDetail?: string;
  diffBase?: string;
  failoverReason?: FailoverReason;
}

function autoLoadedBy(router: ModelRouter, route: BuildRoutePin, pin?: string): readonly string[] {
  try {
    const models = [...(pin ? [pin] : []), ...router.resolveAll(`build_${route}`)];
    const lists = models.map((m) => harnessAutoLoads(router.registryRef.getHarnessId(m)));
    return lists.length === 0 ? [] : lists[0].filter((f) => lists.every((l) => l.includes(f)));
  } catch {
    return [];
  }
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
  issue: WorkKey;
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
  disablePublish?: boolean;
  publishFromBuild?: boolean;
  crossProviderLadder?: boolean;
  modelOverride?: string;
  pinnedModel?: boolean;
  routePinned?: boolean;
  codexFallbackModel?: string;
  onProviderFailure?: (info: ProviderFailureInfo) => void | Promise<void>;
  sandbox?: SandboxPolicy;
  steering?: ConsumedSteering;
  appPort?: number;
  appBaseUrl?: string;
  routeCapabilities?: RouteCapabilities;
  autoFailover?: {
    enabled: boolean;
    fallbackModel?: string;
    onQuotaExhausted?: (info: { provider: string; reason: FailoverReason }) => void | Promise<void>;
  };
  onPgid?: (pgid: number) => void;
  budgetGuard?: BudgetGuard;
  localOnly?: boolean;
  laneId?: string;
  openQuestions?: readonly string[];
  previousAttempt?: string;
  runId?: string;
  parentBaseRef?: string;
  bus?: LifecycleBus;
  collectDiff?: typeof collectDesignDiff;
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

  const lintRules = await renderLintRulesInForce(worktree);
  const constitutionCtxFor = (r: BuildRoutePin, pin?: string): string =>
    buildConstitutionContext(constitution, 'standards', { omitSources: autoLoadedBy(router, r, pin) }) + lintRules;
  const spec = await readFile(specPath, 'utf-8').catch(() => '');
  const designArtifact = await readDesignArtifact(specPath);
  const designGrounding = designArtifact ? renderDesignGrounding(designArtifact) : '';
  const hasVerifySh = await fileExists(join(worktree, 'scripts/verify.sh'));
  const verifyCommand =
    !hasVerifySh && (await fileExists(join(worktree, 'scripts/verify.ps1'))) ? VERIFY_PS1_ARGV.join(' ') : undefined;
  const lintCommands = hasVerifySh ? [] : await resolveLintCommands({ worktree }).catch(() => []);
  const affectedTestsCommand = loadAffectedConfig(worktree)?.command;
  const basePromptOpts = {
    issue,
    specPath,
    spec,
    appPort,
    appBaseUrl,
    designGrounding,
    lintCommands,
    verifyCommand,
    affectedTestsCommand,
    previousAttempt,
  };
  const promptOptsFor = (r: BuildRoutePin, pin?: string) => ({
    ...basePromptOpts,
    constitutionCtx: constitutionCtxFor(r, pin),
  });
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

  const claudeRoutePrompt = (): string =>
    publishFromBuild && !disablePublish
      ? buildClaudePrompt({
          issue,
          branch,
          specPath,
          constitutionCtx: constitutionCtxFor('claude'),
          skipCI,
          appPort,
          appBaseUrl,
          designGrounding,
          lintCommands,
          verifyCommand,
          affectedTestsCommand,
          previousAttempt,
        })
      : buildCommitOnlyPrompt(promptOptsFor('claude'));
  let prompt: string;
  let taskType: 'build_codex' | 'build_claude' | 'build_opencode' | 'build_command';

  const modelOverride = modelOverrideOpt;
  if (route === 'codex') {
    taskType = 'build_codex';
    prompt = localOnly
      ? buildLocalSmallPrompt({ issue, branch, spec })
      : buildCommitOnlyPrompt(promptOptsFor('codex', modelOverride));
  } else if (route === 'opencode') {
    taskType = 'build_opencode';
    prompt = buildOpencodePrompt(promptOptsFor('opencode', modelOverride));
  } else if (route === 'command') {
    taskType = 'build_command';
    prompt = buildCommitOnlyPrompt(promptOptsFor('command', modelOverride));
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

  const fallbackBaseRef = await (opts.captureBase ?? captureDiffBase)(worktree);

  let result: RouterResult;
  let crossHarnessReason: FailoverReason | undefined;
  try {
    result = await router.run(taskType, prompt, runOpts);
  } catch (err) {
    const routerFailure = routerFailureOf(err);
    const reason = routerFailure?.reason;
    if (opts.crossProviderLadder === false && (reason === 'usage_cap' || reason === 'rate_limit')) throw err;
    const attempts = routerFailure?.attempts;
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
    if (taskType === 'build_claude' && crossHarnessOk) {
      if (opts.autoFailover && !opts.autoFailover.enabled) throw err;
      const fallback = codexFallbackModel ?? router.resolveAll('build_codex')[0];
      if (!fallback) throw err;
      log('worker_failover', `Claude build workers exhausted (${reason}) — continuing on Codex: to_model=${fallback}`, {
        failoverReason: reason,
      });
      route = 'codex';
      crossHarnessReason = reason;
      result = await router.run('build_codex', buildCommitOnlyPrompt(promptOptsFor('codex', fallback)), {
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
        build: { ...opts, codexDisabled: codexUnavailable(opts.routeCapabilities) },
        prompts: { claude: claudeRoutePrompt, codex: () => buildCommitOnlyPrompt(promptOptsFor('codex')) },
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
