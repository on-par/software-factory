// packages/cli/src/cli/ship-steps.ts — named steps of the ship flow: run-report/benchmark writers, sandbox logging, RunRequest builder (#2788)

import { exec as execCb } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify, styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import type {
  BenchmarkRunFailure,
  CheckSummary,
  EventKind,
  FactoryConfig,
  ParkReason,
  LocalOnlyPolicy,
  RunOutcome,
  RunPorts,
  RunRequest,
  SandboxPolicy,
  Workspace,
  WorkRequest,
  WorkRequestSourceKind,
  resolveEfficiencyPolicy,
  resolveSandboxPolicy,
  writeLocalRunReport,
  getFactoryPaths,
} from '@on-par/factory-core';
import {
  GITHUB_ISSUE_SOURCE,
  listQueuedSteering,
  localOnlyWorkspace,
  resolveBuildPublish,
  resolveDesignRegressionBlock,
  resolveReadinessUpdateIssueBody,
  rewriteQueueForDecomposition,
  type SizeGateMode,
  worktreeWorkspace,
  writeBenchmarkArtifacts,
} from '@on-par/factory-core';
import type { CheckResumeRecord, WorktreeSandbox } from '@on-par/factory-core/internal';
import {
  currentSlice,
  findOpenPR,
  findSlicePlanComment,
  resolveFilingPolicy,
  resolveReviewFloorRules,
  withFileLock,
  withGitLock,
} from '@on-par/factory-core/internal';
import { recordGitPushes, resolveGitHubMode, GITHUB_STUB_CALLS_FILE } from './github-stub.js';
import type { CliDeps, ConfigLoaderKey, GitOpKey } from './index.js';
import { shipRuntime } from './ship-runtime.js';

// Captures the message of the last terminal event runIssue emits (ready/fail/
// escalate/held/conflict/ci-failed/timeout) so the LaneParkError the ship adapter
// raises carries the same diagnostic text shipIssue used to throw with —
// RunOutcome's parked variant carries only the ParkReason enum, not free text.
export const TERMINAL_EVENT_KINDS = new Set<EventKind>([
  'ready',
  'environment-released',
  'fail',
  'escalate',
  'held',
  'conflict',
  'config',
  'ci-failed',
  'ci-infra',
  'timeout',
]);

/** FACTORY_GITHUB=stub (#2652): record each `git push` ship runs in the stub's calls.jsonl. */
export function stubAwareShipPhase(shipPhase: NonNullable<RunPorts['shipPhase']>): NonNullable<RunPorts['shipPhase']> {
  let shipPhaseForMode = shipPhase;
  if (resolveGitHubMode(process.env) === 'stub') {
    const base = shipPhase;
    const stubCalls = join(resolve(process.env.FACTORY_GITHUB_STUB_DIR ?? ''), GITHUB_STUB_CALLS_FILE);
    const defaultShipRunner = promisify(execCb);
    const wrapped: RunPorts['shipPhase'] = (o) =>
      base({ ...o, run: recordGitPushes(o.run ?? defaultShipRunner, stubCalls, o.branch) });
    shipPhaseForMode = wrapped;
  }
  return shipPhaseForMode;
}

/** Logs the sandbox state for this run and returns the policy to pass to harnesses, if any. */
export function logSandboxPolicy(
  opts: { sandbox?: boolean },
  sandboxPolicy: ReturnType<typeof resolveSandboxPolicy>,
  log: (type: EventKind, msg: string) => void,
): SandboxPolicy | undefined {
  let activeSandboxPolicy: SandboxPolicy | undefined;
  if (opts.sandbox === false) {
    console.error(styleText('yellow', 'factory: sandbox disabled by --no-sandbox — agent runs are UNCONTAINED'));
    log('sandbox-disabled', 'sandbox disabled by --no-sandbox');
  } else if (!sandboxPolicy) {
    log('sandbox-disabled', 'sandbox disabled by config/FACTORY_SANDBOX');
  } else if (sandboxPolicy.runtime === 'none') {
    activeSandboxPolicy = sandboxPolicy;
    log(
      'sandbox',
      'outer sandbox off; harness sandbox in use (codex --sandbox workspace-write; harnesses without their own sandbox run unwrapped)',
    );
  } else if (sandboxPolicy.runtime === 'docker-sandbox') {
    // docker-sandbox's containment is the microVM created by worktreeWorkspace in shipIssue
    // (#653), not a command-prefix wrap — activeSandboxPolicy stays undefined because
    // wrapCommandInSandbox remains a no-op for this runtime. createMicroVm logs the
    // actual outcome ('sandbox' on success, 'sandbox-unavailable' on fallback), so no
    // speculative log is emitted here.
  } else {
    activeSandboxPolicy = sandboxPolicy;
    if (sandboxPolicy.allowHosts.length > 0) {
      log(
        'sandbox-degraded',
        `host-level egress filtering unavailable in v1; intended allowlist: ${sandboxPolicy.allowHosts.join(', ')}`,
      );
    }
  }
  return activeSandboxPolicy;
}

/** ADR-0147: slice k >= 2 builds on its own branch, so the slice plan is read before the worktree exists. */
export async function findSliceIndex({
  sizeGateMode,
  ctx,
  work,
  octokit,
  ghRepo,
  issueNum,
}: {
  sizeGateMode: SizeGateMode;
  ctx?: { localOnly?: LocalOnlyPolicy; resumeFrom?: CheckResumeRecord };
  work: WorkRequest;
  octokit: Octokit;
  ghRepo: string;
  issueNum: number;
}): Promise<number | undefined> {
  const { errorDetail, LaneParkError } = shipRuntime();
  let sliceIndex: number | undefined;
  // ADR-0161: stack runs as slice until stacked PRs are built.
  if (
    (sizeGateMode === 'slice' || sizeGateMode === 'stack') &&
    !ctx?.localOnly &&
    !ctx?.resumeFrom &&
    work.kind === GITHUB_ISSUE_SOURCE
  ) {
    try {
      const lookup = await findSlicePlanComment({ octokit, repo: ghRepo, issue: issueNum });
      if (lookup.status === 'found') sliceIndex = currentSlice(lookup.plan)?.index;
    } catch (err) {
      throw new LaneParkError(
        `slice plan lookup failed for #${issueNum}: ${errorDetail(err)} — parked before creating a worktree`,
        'escalate',
      );
    }
  }
  return sliceIndex;
}

/** Sets up the run's workspace: reuse a kept worktree, create a factory worktree, or wrap the local-only one. */
export async function setupRunWorkspace({
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
}: {
  ctx?: { localOnly?: LocalOnlyPolicy; resumeFrom?: CheckResumeRecord };
  repoRoot: string;
  branch: string;
  worktree: string;
  log: (type: EventKind, msg: string) => void;
  worktreeSandbox: WorktreeSandbox | undefined;
  octokit: Octokit;
  ghOwner: string;
  ghName: string;
  git: Required<Pick<CliDeps, GitOpKey>>;
  paths: ReturnType<typeof getFactoryPaths>;
}): Promise<Workspace> {
  let workspace: Workspace;
  if (ctx?.resumeFrom) {
    workspace = { path: worktree, dispose: async () => {} };
    log('worktree', `reusing kept worktree at ${worktree} (resume --from check)`);
  } else if (!ctx?.localOnly) {
    workspace = await worktreeWorkspace({
      repoRoot,
      branch,
      worktreePath: worktree,
      log,
      sandbox: worktreeSandbox,
      findOpenPr: (br) => findOpenPR(octokit, ghOwner, ghName, br),
      setup: (root, br, wt, sp, sandbox, setupLog, setupOpts) =>
        withGitLock(root, () =>
          withFileLock(
            paths.gitLock,
            // setupWorktree fetches origin itself before creating the worktree (#1167),
            // so no explicit gitFetch here — still under the git + file locks.
            () => git.setupWorktree(root, br, wt, sp, sandbox, setupLog, setupOpts),
            { onSteal: (pid) => log('lock-stolen', `stole ${paths.gitLock} from dead holder pid ${pid ?? 'unknown'}`) },
          ),
        ),
    });
    log('worktree', `Worktree ready at ${worktree}`);
  } else {
    workspace = localOnlyWorkspace(ctx.localOnly);
    log('workspace', `local-only: using caller-provided workspace ${worktree} (no factory worktree created)`);
  }
  return workspace;
}

/** Rewrites the queue for a decomposed issue, then throws so the lane moves on to the children. */
export function decomposeQueue({
  issueNum,
  childIssues,
  paths,
  planLog,
}: {
  issueNum: number;
  childIssues: number[];
  paths: ReturnType<typeof getFactoryPaths>;
  planLog: (type: EventKind, msg: string) => void;
}): never {
  const { readTextFileOrEmpty, errorDetail, IssueDecomposedError } = shipRuntime();
  const childList = childIssues.map((n) => `#${n}`).join(', ');
  try {
    const before = readTextFileOrEmpty(paths.queue);
    const rewrite = rewriteQueueForDecomposition(before, { issue: issueNum, childIssues });
    if (rewrite.changed) {
      writeFileSync(paths.queue, rewrite.content);
      planLog('decompose_filed', `queue entry for #${issueNum} replaced with ${childList}`);
    } else {
      planLog('decompose_filed', `#${issueNum} had no queue entry to replace — continuing the lane with ${childList}`);
    }
  } catch (err) {
    planLog('decompose_file_failed', `queue rewrite for #${issueNum} failed: ${errorDetail(err)}`);
  }
  throw new IssueDecomposedError(`issue #${issueNum} decomposed into ${childList}`, childIssues);
}

/** Maps the core RunOutcome to the shipped branch name, or throws the park/pause error the lane expects. */
export function finishOutcome({
  outcome,
  opts,
  ctx,
  paths,
  issueNum,
  worktree,
  terminalMessage,
  log,
}: {
  outcome: RunOutcome;
  opts: { interactive?: boolean };
  ctx?: { localOnly?: LocalOnlyPolicy };
  paths: ReturnType<typeof getFactoryPaths>;
  issueNum: number;
  worktree: string;
  terminalMessage: string | undefined;
  log: (type: EventKind, msg: string) => void;
}): string {
  const { LaneParkError, LaneEnvironmentPauseError } = shipRuntime();
  if (opts.interactive && !ctx?.localOnly && (outcome.state === 'ready' || outcome.state === 'shipped')) {
    const leftover = listQueuedSteering(paths.steering, issueNum);
    if (leftover.length > 0) {
      log('steering_unconsumed', `${leftover.length} steering message(s) not consumed (no worker phase remained)`);
    }
  }

  if (outcome.state === 'ready' || outcome.state === 'shipped') {
    if (ctx?.localOnly) {
      console.log(styleText('green', `✅ Local-only run complete in ${worktree} (no PR — publishing disabled)`));
    } else {
      console.log(styleText('green', `✅ Issue #${issueNum} → ${terminalMessage ?? 'ready'}`));
    }
    return outcome.branch;
  }

  if (outcome.state === 'released') {
    throw new LaneEnvironmentPauseError(terminalMessage ?? 'environment failure on base', {
      baseSha: outcome.baseSha,
      failingChecks: outcome.failingChecks,
      failureSignature: outcome.failureSignature,
      buildPreserved: outcome.buildPreserved,
      awaitingCi: outcome.awaitingCi,
    });
  }

  const reason: ParkReason = outcome.state === 'escalated' ? 'escalate' : outcome.reason;
  const message = outcome.state === 'escalated' ? outcome.reason : (terminalMessage ?? `run parked: ${outcome.reason}`);
  throw new LaneParkError(
    message,
    reason,
    outcome.state === 'parked'
      ? { failureSignature: outcome.failureSignature, failingChecks: outcome.failingChecks }
      : undefined,
  );
}

/** Everything buildRunRequest reads from shipIssue's locals. */
export interface RunRequestInput {
  issueNum: number;
  ghRepo: string;
  repoRoot: string;
  branch: string;
  specPath: string;
  work: WorkRequest;
  product: string | undefined;
  runStartedAt: string;
  lane: string | undefined;
  opts: { interactive?: boolean; sandbox?: boolean };
  ctx?: {
    workSource?: { kind: WorkRequestSourceKind; params: unknown };
    localOnly?: LocalOnlyPolicy;
    resumeFrom?: CheckResumeRecord;
  };
  autoRework: boolean;
  planApprovalEnabled: boolean;
  factoryConfig: FactoryConfig;
  repoConfig: Parameters<typeof resolveReviewFloorRules>[0];
  classifierPolicy: { enabled: boolean };
  loaders: Pick<Required<Pick<CliDeps, ConfigLoaderKey>>, 'resolveSkipCI'>;
  efficiency: ReturnType<typeof resolveEfficiencyPolicy>;
  sizeGateMode: RunRequest['sizeGateMode'];
  maxSlices: RunRequest['maxSlices'];
  timeouts: RunRequest['timeouts'];
  modelPins: RunRequest['modelPins'];
  codexOff: boolean;
  failoverSettings: RunRequest['failover'];
  activeSandboxPolicy: SandboxPolicy | undefined;
  processGroupGraceMs: number;
  paths: ReturnType<typeof getFactoryPaths>;
}

export function buildRunRequest({
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
}: RunRequestInput): RunRequest {
  const { repoConfigFileFor } = shipRuntime();
  return {
    issue: issueNum,
    repo: ghRepo,
    branch,
    specPath,
    work,
    workSource: ctx?.workSource,
    product,
    startedAt: runStartedAt,
    lane,
    options: {
      interactive: Boolean(opts.interactive),
      autoRework,
      approvePlan: planApprovalEnabled,
      sandboxDisabled: opts.sandbox === false,
    },
    localOnly: Boolean(ctx?.localOnly),
    blockUnresolvedRegressions: resolveDesignRegressionBlock(factoryConfig),
    readinessUpdateIssueBody: resolveReadinessUpdateIssueBody(factoryConfig),
    publishFromBuild: resolveBuildPublish(factoryConfig),
    sizeGateMode,
    maxSlices,
    prClassifier: classifierPolicy.enabled
      ? {
          rules: resolveReviewFloorRules(repoConfig),
          gateLabel: resolveFilingPolicy(factoryConfig).selfFixLabel,
          modelPin: repoConfig?.models?.pins?.classifier,
        }
      : undefined,
    timeouts,
    modelPins,
    codexDisabled: codexOff,
    skipCI: loaders.resolveSkipCI(factoryConfig),
    failover: failoverSettings,
    efficiency: { maxReworkRounds: efficiency.maxReworkRounds, fastPath: efficiency.fastPath },
    sandboxPolicy: activeSandboxPolicy,
    codexWorkspacePaths: { primaryRepoRoot: repoRoot, writableRoots: [paths.state, resolve(repoRoot, '.git')] },
    processGroupGraceMs,
    preferredRoute: repoConfig?.route,
    ...(ctx?.resumeFrom
      ? {
          resumeFrom: {
            phase: 'check' as const,
            diffBase: ctx.resumeFrom.diffBase,
            route: ctx.resumeFrom.route,
            model: ctx.resumeFrom.model,
            buildMinutes: ctx.resumeFrom.buildMinutes,
          },
        }
      : {}),
    eventsFile: paths.events,
    logsDir: paths.logs,
    baselineCachePath: paths.baselineCache,
    repoConfigFile: repoConfigFileFor(repoRoot, paths.config),
    flakyLedgerPath: paths.flakyLedger,
  };
}

export async function maybeWriteLocalRunReport(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  startedAt: string;
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  branch?: string;
  worktree?: string;
  specPath?: string;
  route?: string;
  reason?: string;
  writeLocalRunReport?: typeof writeLocalRunReport;
}): Promise<string | undefined> {
  if (process.env.FACTORY_LOCAL_ONLY !== '1') return undefined;
  const report = await (opts.writeLocalRunReport ?? shipRuntime().defaultWriteLocalRunReport())({
    issue: opts.issueNum,
    eventsFile: opts.paths.events,
    reportsDir: opts.paths.reports,
    startedAt: opts.startedAt,
    outcome: opts.outcome,
    profile: 'local-only',
    branch: opts.branch,
    worktree: opts.worktree,
    specPath: opts.specPath,
    route: opts.route,
    reason: opts.reason,
  });
  console.log(styleText('cyan', `local-only report: ${report.path}`));
  return report.path;
}

export async function maybeWriteBenchmarkArtifacts(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  ctx?: { localOnly?: LocalOnlyPolicy; artifactsDir?: string; workRequest?: WorkRequest };
  startedAt: string;
  outcome: 'ready' | 'failed' | 'escalated';
  branch?: string;
  specPath?: string;
  route?: string;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  failure?: BenchmarkRunFailure;
  reportPath?: string;
  diffBase?: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<void> {
  if (!opts.ctx?.localOnly || !opts.ctx.artifactsDir) return;
  try {
    const { manifestPath } = await writeBenchmarkArtifacts({
      issue: opts.issueNum,
      artifactsDir: opts.ctx.artifactsDir,
      eventsFile: opts.paths.events,
      costsFile: opts.paths.costs,
      startedAt: opts.startedAt,
      outcome: opts.outcome,
      workspace: opts.ctx.localOnly.workspace,
      branch: opts.branch,
      specPath: opts.specPath,
      route: opts.route,
      request: opts.ctx.workRequest,
      checkSummary: opts.checkSummary,
      reworkRounds: opts.reworkRounds,
      failure: opts.failure,
      reportPath: opts.reportPath,
      diffBase: opts.diffBase,
    });
    opts.log('benchmark-artifacts', `manifest written to ${manifestPath}`);
    console.log(styleText('cyan', `benchmark artifacts: ${manifestPath}`));
  } catch (err: any) {
    // Never let artifact emission mask the run outcome.
    opts.log('benchmark-artifacts-failed', `could not write benchmark artifacts: ${err.message}`);
  }
}
