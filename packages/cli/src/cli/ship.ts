// packages/cli/src/cli/ship.ts — issue-level ship flow: resolve config, build RunRequest/RunPorts, run runIssue, map the outcome (#2788)
import { resolve } from 'node:path';
import { styleText } from 'node:util';
import type {
  EventKind,
  FailurePhase,
  GithubIssueParams,
  LocalOnlyPolicy,
  RunOutcome,
  RunPolicy,
  RunPorts,
  WorkRequest,
  WorkRequestSourceKind,
} from '@on-par/factory-core';
import {
  applyRepoConfig,
  closedWorkSkipReason,
  createDefaultWorkSourceRegistry,
  createFileApprovalGate,
  drainSteering,
  getFactoryPaths,
  GITHUB_ISSUE_SOURCE,
  LaneFileGuard,
  phaseSnapshotFile,
  ProviderBreaker,
  resolveAutoFailover,
  resolveCodexDisabled,
  resolveEfficiencyPolicy,
  resolveEnvironmentPorts,
  resolveEnvironmentProxy,
  resolvePlanApproval,
  resolveProcessGroupGraceMs,
  resolveSandboxPolicy,
  resolveSizeGateMaxSlices,
  resolveSizeGateMode,
  ReworkHistory,
  runIssue,
  type EffectiveModelPins,
  type RepoFactoryConfig,
  type SizeGateMode,
  summarizeEvent,
  touchLastEvent,
  touchRunActivity,
  writePhaseSnapshot,
} from '@on-par/factory-core';
import { hostBuildSlotPort } from './host-slot.js';
import type { CheckResumeRecord, WorktreeSandbox } from '@on-par/factory-core/internal';
import {
  createCheckResumeStore,
  createGithubLaneClaimStalenessProbe,
  createPlanReuseStore,
  egressHostMessage,
  egressSummaryMessage,
  logCost,
  logEvent,
  recordLocalAuthFailure,
  resolveBaseHealthChecks,
  resolveEffectiveConfig,
  resolvePrClassifierPolicy,
  shouldProxyEgress,
  startEgressProxy,
  worktreeSandboxFor,
} from '@on-par/factory-core/internal';
import { baseHealthWithCi } from './base-health-ci.js';
import { formatDeprecation } from './octokit.js';
import type { CliDeps, ConfigLoaderKey, CoreOpKey, GitOpKey, ShellOpKey } from './index.js';
import { resolveRunBranch } from './run-branch.js';
import { shipRuntime } from './ship-runtime.js';
import { runStateRecorder } from './ship-run-state.js';
import {
  buildRunRequest,
  decomposeQueue,
  finishOutcome,
  logSandboxPolicy,
  maybeWriteBenchmarkArtifacts,
  maybeWriteLocalRunReport,
  setupRunWorkspace,
  stubAwareShipPhase,
  TERMINAL_EVENT_KINDS,
} from './ship-steps.js';

/** One `model-override` message per pinned phase, naming the file or env var it came from (#2497). */
function modelOverrideMessages(
  pins: EffectiveModelPins,
  repo: RepoFactoryConfig | null,
  repoConfigLabel: string,
): string[] {
  const label = (source: 'repo' | 'env' | undefined, envVar: string) => (source === 'repo' ? repoConfigLabel : envVar);
  const repoPins = repo?.models?.pins;
  return [
    ...(repoPins?.triage ? [`triage model pinned to ${repoPins.triage} (${repoConfigLabel})`] : []),
    ...(pins.plan ? [`plan model pinned to ${pins.plan} (${label(pins.sources.plan, 'FACTORY_PLAN_MODEL')})`] : []),
    ...(pins.build
      ? [`build model pinned to ${pins.build} (${label(pins.sources.build, 'FACTORY_BUILD_MODEL')})`]
      : []),
    ...(repoPins?.checker ? [`checker model pinned to ${repoPins.checker} (${repoConfigLabel})`] : []),
  ];
}

export async function shipIssue(
  issueNum: number,
  opts: {
    product?: string;
    autoRework?: boolean;
    interactive?: boolean;
    sandbox?: boolean;
    approvePlan?: boolean;
    branchPrefix?: string;
    /** `run-issue --size-gate` (ADR-0147); undefined defers to sizeGate.mode in the config. */
    sizeGate?: SizeGateMode;
    /** run-issue --max-slices (ADR-0156); undefined defers to sizeGate.maxSlices. */
    maxSlices?: number;
    /** `--pr-classifier` / `--no-pr-classifier` (#1724); undefined defers to config/env. */
    prClassifier?: boolean;
  },
  ctx?: {
    repoRoot: string;
    ghRepo: string;
    /** Resolved factory state paths, supplied by daemon lanes with an external state root. */
    paths?: ReturnType<typeof getFactoryPaths>;
    lane?: string;
    workRequest?: WorkRequest;
    /** Receives the core RunOutcome before shipIssue maps it to a return/throw — lets
     *  `run-issue --run-children` read the PR number as data (#1747). */
    onOutcome?: (outcome: RunOutcome) => void;
    /** Input source for planPhase to resolve; defaults inside planPhase to this run's GitHub issue. */
    workSource?: { kind: WorkRequestSourceKind; params: unknown };
    /** Local-only policy (#508): run in this caller-provided workspace, no worktree, no publishing, no SHIP phase. */
    localOnly?: LocalOnlyPolicy;
    /** Per-run BUILD/CHECK slot gate shared by every lane of one run (#3049); absent = host cap only. */
    runSlots?: Parameters<typeof hostBuildSlotPort>[4];
    /** Benchmark artifact directory (#509) — only set for local-only runs. */
    artifactsDir?: string;
    resumeFrom?: CheckResumeRecord; // Resume at CHECK on a kept worktree (#2564).
  },
  deps: Pick<
    CliDeps,
    | 'octokit'
    | 'planPhase'
    | 'buildPhase'
    | 'checkPhase'
    | 'shipPhase'
    | 'checkBaseHealth'
    | ConfigLoaderKey
    | GitOpKey
    | ShellOpKey
    | CoreOpKey
  > = {},
): Promise<string> {
  const {
    resolveConfigLoaders,
    resolveGitOps,
    resolveShellOps,
    resolveCoreOps,
    resolvePhaseOps,
    getRepoRoot,
    getGitHubRepo,
    repoConfigFileFor,
    getOctokit,
    worktreePathFor,
    isCommandAvailableViaShell,
    readActiveProduct,
    resolveEnvironmentAcquirer,
    resolveLaneBaseUrl,
    IssueSkippedError,
  } = shipRuntime();
  const loaders = resolveConfigLoaders(deps);
  const git = resolveGitOps(deps);
  const shell = resolveShellOps(deps);
  const core = resolveCoreOps(deps);
  const phases = resolvePhaseOps(deps);
  const shipPhaseForMode = stubAwareShipPhase(phases.shipPhase);
  const repoRoot = ctx?.repoRoot ?? (await getRepoRoot(shell));
  const ghRepo = ctx?.ghRepo ?? (await getGitHubRepo(shell));
  const paths = ctx?.paths ?? getFactoryPaths(repoRoot);
  // GitHub REST deprecations seen on this run's client become one warn event per route (#2218).
  const octokit = (
    deps.octokit ??
    (() =>
      getOctokit(shell, {
        log: (d) =>
          logEvent(paths.events, 'github_api_deprecated', issueNum, formatDeprecation(d), { lane: ctx?.lane }),
      }))
  )();
  const [ghOwner, ghName] = ghRepo.split('/');

  const repoConfig = loaders.loadRepoConfig(repoRoot, paths.root);
  const factoryConfig = loaders.loadFactoryConfigForRepo(paths.config);
  const classifierPolicy = resolvePrClassifierPolicy(factoryConfig, process.env, { classifier: opts.prClassifier });
  const timeouts = loaders.resolveTimeouts(factoryConfig);
  const failoverSettings = resolveAutoFailover(factoryConfig);
  const breaker = new ProviderBreaker(paths.breaker);
  const reworkHistory = new ReworkHistory(paths.reworkHistory);
  const laneFileGuard = new LaneFileGuard(paths.laneFiles);
  const efficiency = resolveEfficiencyPolicy(repoConfig);
  const policy: RunPolicy = {
    models: applyRepoConfig(loaders.loadModelsConfig(), repoConfig),
    routes: loaders.loadRoutesConfig(),
    sandbox: factoryConfig.sandbox,
    budget: { perIssueCapUsd: efficiency.perIssueCapUsd },
    effective:
      opts.branchPrefix === undefined
        ? resolveEffectiveConfig(repoConfig)
        : { ...resolveEffectiveConfig(repoConfig), branchPrefix: opts.branchPrefix },
  };
  const router = new core.ModelRouter(
    policy.models,
    policy.routes,
    false,
    undefined,
    policy.effective.allowExperimental,
    policy.effective.localOnly,
  );
  router.setCodexFullAccessTasks?.(policy.sandbox.codexFullAccessTasks);
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  router.skipMissingHarnessClis(core.isCommandAvailable);
  let issueSpend = 0;
  let laneSandboxRuntime = 'none';
  const laneWorkspaceBackend =
    factoryConfig.workspace?.backend === 'disposable-docker' ? 'disposable-docker' : 'worktree';
  router.setCostSink((entry) => {
    issueSpend += entry.cost ?? 0;
    logCost(paths.costs, {
      ...entry,
      issue: String(issueNum),
      sandboxRuntime: laneSandboxRuntime,
      reworkRoundCount: laneReworkRounds,
      workspaceBackend: laneWorkspaceBackend,
    });
  });
  const modelPins = loaders.resolveEffectiveModelPins(router.registryRef, repoConfig);
  const codexOff = resolveCodexDisabled(repoConfig);
  const constitutionLoader = new core.ConstitutionLoader();

  const product = opts.product ?? readActiveProduct(paths.product);
  const autoRework = opts.autoRework ?? true;
  const work =
    ctx?.workRequest ??
    (await createDefaultWorkSourceRegistry({ octokit }).resolve(GITHUB_ISSUE_SOURCE, {
      repo: ghRepo,
      issue: issueNum,
    } satisfies GithubIssueParams));
  const issueTitle = work.title;
  const sizeGateMode = opts.sizeGate ?? resolveSizeGateMode(factoryConfig);
  const maxSlices = opts.maxSlices ?? resolveSizeGateMaxSlices(factoryConfig);
  const { branchPrefix } = policy.effective;
  const claim = { issueNum, issueTitle, ghRepo, sizeGateMode, work, ctx, octokit };
  const branch = await resolveRunBranch({ ...claim, branchPrefix, eventsFile: paths.events });
  const worktree = ctx?.resumeFrom
    ? ctx.resumeFrom.worktree
    : ctx?.localOnly
      ? ctx.localOnly.workspace
      : worktreePathFor(repoRoot, ghRepo, issueNum, branchPrefix, loaders);
  const specPath = resolve(paths.plans, `issue-${issueNum}.md`);
  const runStartedAt = new Date().toISOString();

  const lane = ctx?.lane;
  const baseHealthOpts = { checks: resolveBaseHealthChecks(repoConfig), events: paths.events, lane };
  let terminalMessage: string | undefined;
  let laneReworkRounds = 0;
  const mkLog = (phase?: string) => (type: EventKind, msg: string, extra?: Parameters<typeof logEvent>[4]) => {
    if (TERMINAL_EVENT_KINDS.has(type)) terminalMessage = msg;
    if (type === 'rework') laneReworkRounds++;
    // checkPhase logs each skipped checker as a 'SKIPPED: ' check event — echo it to the terminal.
    if (type === 'check' && msg.startsWith('SKIPPED: ')) {
      console.error(styleText('yellow', `  SKIP: ${msg.slice('SKIPPED: '.length)}`));
    }
    // Likewise for failing checkers: the parked RunOutcome carries only an aggregate count (#675).
    if (type === 'check' && msg.startsWith('FAILED: ')) {
      console.error(styleText('red', `  FAIL: ${msg.slice('FAILED: '.length)}`));
    }
    logEvent(paths.events, type, issueNum, msg, { ...extra, lane, phase });
    // Best-effort lastEvent summary (#1327): a write failure is swallowed, not logged (re-entrancy).
    touchLastEvent(phaseSnapshotFile(paths.runs, issueNum), summarizeEvent(type, msg)).catch(() => {});
  };
  const log = mkLog();
  log('issue-title', issueTitle);
  const repoConfigLabel = repoConfigFileFor(repoRoot, paths.config).relPath;
  for (const msg of modelOverrideMessages(modelPins, repoConfig, repoConfigLabel)) log('model-override', msg);

  const skipReason = closedWorkSkipReason(work);
  if (skipReason) {
    log('skipped-already-closed', skipReason);
    console.log(styleText('yellow', `skipped: ${skipReason}`));
    throw new IssueSkippedError(skipReason, 'already-closed');
  }
  const sandboxPolicy = resolveSandboxPolicy(policy.sandbox, {
    worktree,
    repoRoot,
    factoryStateDir: paths.state,
    cliDisabled: opts.sandbox === false,
    laneId: lane,
    isAvailable: (cmd) => isCommandAvailableViaShell(shell, cmd),
  });
  laneSandboxRuntime = sandboxPolicy?.runtime ?? 'none';
  const worktreeSandbox: WorktreeSandbox | undefined = worktreeSandboxFor(sandboxPolicy?.runtime, {
    allowHosts: sandboxPolicy?.allowHosts ?? [],
  });
  const activeSandboxPolicy = logSandboxPolicy(opts, sandboxPolicy, log);

  const workspace = await setupRunWorkspace({
    ctx,
    repoRoot,
    branch,
    worktree,
    log,
    worktreeSandbox,
    octokit,
    ghOwner,
    ghName,
    git,
    paths,
  });

  const planApprovalEnabled = opts.approvePlan ?? resolvePlanApproval(factoryConfig);
  const processGroupGraceMs = resolveProcessGroupGraceMs(factoryConfig);

  const portsSettings = resolveEnvironmentPorts(factoryConfig);
  if (!portsSettings.enabled) {
    log('environment_lease', 'port leasing disabled (environment.ports.enabled=false or FACTORY_ENV_PORTS=0)');
  }
  // recordPgid/release only persist/deallocate the lease; process-group killing is runIssue's own tracker (Invariant 3).
  const acquireEnvironment = portsSettings.enabled
    ? resolveEnvironmentAcquirer({
        laneSandboxRuntime: sandboxPolicy?.runtime ?? 'none',
        paths,
        worktree,
        branch,
        range: portsSettings.range,
        processGroupGraceMs,
        log,
        findPortListeners: core.defaultFindPortListeners,
        reapOrphanProcesses: core.reapOrphanProcesses,
      })
    : undefined;

  const proxySettings = resolveEnvironmentProxy(factoryConfig);
  const resolveBaseUrl = (appPort: number | undefined) => resolveLaneBaseUrl(paths, proxySettings, worktree, appPort);

  const request = buildRunRequest({
    issueNum,
    ghRepo,
    repoRoot,
    branch,
    specPath,
    work,
    product,
    runStartedAt,
    lane,
    opts,
    ctx,
    autoRework,
    planApprovalEnabled,
    factoryConfig,
    repoConfig,
    classifierPolicy,
    loaders,
    efficiency,
    sizeGateMode,
    maxSlices,
    timeouts,
    modelPins,
    codexOff,
    failoverSettings,
    activeSandboxPolicy,
    processGroupGraceMs,
    paths,
  });

  const ports: RunPorts = {
    router,
    octokit,
    workspace,
    events: mkLog,
    acquireEnvironment,
    resolveBaseUrl,
    getIssueSpend: () => issueSpend,
    breaker,
    planReuse: ctx?.localOnly ? undefined : createPlanReuseStore(specPath),
    checkResume: ctx?.localOnly ? undefined : createCheckResumeStore(specPath),
    planPhase: phases.planPhase,
    buildPhase: phases.buildPhase,
    checkPhase: phases.checkPhase,
    hostBuildSlot: hostBuildSlotPort(factoryConfig, ghRepo, issueNum, log, ctx?.runSlots),
    shipPhase: shipPhaseForMode,
    checkBaseHealth: deps.checkBaseHealth ?? baseHealthWithCi(octokit, ghOwner, ghName, baseHealthOpts),
    resolveConstitution: () =>
      // Resolved once so the build worker can't author its own standards; a caller-provided local-only workspace keeps its own.
      constitutionLoader.resolve(
        worktree,
        product,
        factoryConfig.paths?.constitution,
        ctx?.localOnly ? undefined : repoRoot,
      ),
    createApprovalGate: () => createFileApprovalGate({ dir: paths.approvals, timeoutMs: timeouts.approval * 1000 }),
    drainSteering: () => drainSteering(paths.steering, issueNum, worktree),
    reworkHistory,
    laneFileGuard,
    laneClaimStaleness: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: policy.effective.branchPrefix }),
    recordPhase: (phase: FailurePhase) => {
      const now = new Date().toISOString();
      return writePhaseSnapshot(phaseSnapshotFile(paths.runs, issueNum), {
        issue: issueNum,
        phase,
        updatedAt: now,
        lastActivityAt: now,
      });
    },
    recordRunState: runStateRecorder(paths.runs, {
      issue: issueNum,
      lane: lane ?? '',
      branch,
      worktree,
      specPath,
      startedAt: runStartedAt,
    }),
    onActivity: () => touchRunActivity(phaseSnapshotFile(paths.runs, issueNum), new Date().toISOString()),
    onDecomposed: (childIssues) => {
      decomposeQueue({ issueNum, childIssues, paths, planLog: mkLog('plan') });
    },
    writeLocalRunReport: (info) =>
      maybeWriteLocalRunReport({
        issueNum,
        paths,
        startedAt: runStartedAt,
        outcome: info.outcome,
        branch: info.branch,
        worktree,
        specPath,
        route: info.route,
        reason: info.reason,
        writeLocalRunReport: core.writeLocalRunReport,
      }),
    writeBenchmarkArtifacts: (info) =>
      maybeWriteBenchmarkArtifacts({
        issueNum,
        paths,
        ctx,
        startedAt: runStartedAt,
        outcome: info.outcome === 'parked' ? 'failed' : info.outcome,
        branch: info.branch,
        specPath,
        route: info.route,
        checkSummary: info.checkSummary,
        reworkRounds: info.reworkRounds,
        failure: info.failure,
        reportPath: info.reportPath,
        diffBase: info.diffBase,
        log,
      }),
  };

  // #2214: report-only per-lane egress proxy for sandbox-exec, started after worktree setup; the finally below stops it.
  const proxied = shouldProxyEgress(request.sandboxPolicy) ? request.sandboxPolicy : undefined;
  const egressProxy = proxied
    ? await startEgressProxy({
        allowHosts: proxied.allowHosts,
        blockTelemetry: proxied.blockTelemetry,
        onHost: (host, allowed) => log('egress_host', egressHostMessage(host, allowed)),
      })
    : undefined;
  let outcome: Awaited<ReturnType<typeof runIssue>>;
  try {
    outcome = await runIssue(
      proxied && egressProxy ? { ...request, sandboxPolicy: { ...proxied, proxyUrl: egressProxy.url } } : request,
      policy,
      ports,
    );
  } finally {
    if (proxied && egressProxy) {
      log('egress_summary', egressSummaryMessage(egressProxy.hosts(), proxied.allowHosts));
      await egressProxy.close();
    }
  }
  ctx?.onOutcome?.(outcome);

  return finishOutcome({ outcome, opts, ctx, paths, issueNum, worktree, terminalMessage, log });
}
