// packages/cli/src/cli/ship-steps.ts — named steps of the ship flow: sandbox logging, workspace setup, RunRequest builder (#2788)

import { exec as execCb } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import type {
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
  getFactoryPaths,
} from '@on-par/factory-core';
import {
  listQueuedSteering,
  localOnlyWorkspace,
  resolveBuildPublish,
  resolveDesignRegressionBlock,
  resolveReadinessUpdateIssueBody,
  resolveSizeGateBudget,
  rewriteQueueForDecomposition,
  worktreeWorkspace,
} from '@on-par/factory-core';
import type { CheckResumeRecord, WorktreeSandbox } from '@on-par/factory-core/internal';
import {
  findOpenPR,
  isEgressEnforced,
  resolveFilingPolicy,
  resolveConfiguredWritablePaths,
  resolveHermeticGit,
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
  'sandbox-env',
  'no-pr-complete',
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
    const stubCalls = join(resolve(process.env.FACTORY_GITHUB_STUB_DIR ?? ''), GITHUB_STUB_CALLS_FILE);
    const defaultShipRunner = promisify(execCb);
    shipPhaseForMode = (o) =>
      shipPhase({ ...o, run: recordGitPushes(o.run ?? defaultShipRunner, stubCalls, o.branch) });
  }
  return shipPhaseForMode;
}

function logConfiguredWritablePaths(policy: SandboxPolicy, log: (type: EventKind, msg: string) => void): void {
  const extra = policy.configuredWritablePaths ?? [];
  if (extra.length > 0) log('sandbox', `extra writable paths (sandbox.writablePaths): ${extra.join(', ')}`);
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
    logConfiguredWritablePaths(sandboxPolicy, log);
  } else if (sandboxPolicy.runtime === 'docker-sandbox') {
    // Containment is the microVM created by worktreeWorkspace in shipIssue (#653), not a command-prefix
    // wrap: activeSandboxPolicy stays undefined (wrapCommandInSandbox is a no-op here) and createMicroVm
    // logs the actual outcome ('sandbox' or 'sandbox-unavailable'), so nothing is logged here.
  } else {
    activeSandboxPolicy = sandboxPolicy;
    logConfiguredWritablePaths(sandboxPolicy, log);
    if (sandboxPolicy.allowHosts.length > 0 && !isEgressEnforced(sandboxPolicy)) {
      log(
        'sandbox-degraded',
        `host-level egress filtering unavailable in v1; intended allowlist: ${sandboxPolicy.allowHosts.join(', ')}`,
      );
    }
  }
  return activeSandboxPolicy;
}

export { findSliceIndex } from './slice-index.js';

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
      keepsFile: paths.worktreeKeeps,
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

  if (outcome.state === 'released' && outcome.reason === 'stack-wait') {
    console.log(
      styleText(
        'yellow',
        `⏸ Issue #${issueNum} → waiting for approval or merge of slice ${outcome.slice.index}/${outcome.slice.count} PR #${outcome.prNumber}; released, not parked`,
      ),
    );
    return outcome.branch ?? '';
  }

  if (outcome.state === 'released') {
    throw new LaneEnvironmentPauseError(terminalMessage ?? 'environment failure on base', {
      baseSha: outcome.baseSha,
      failingChecks: outcome.failingChecks,
      failureSignature: outcome.failureSignature,
      buildPreserved: outcome.buildPreserved,
      awaitingCi: outcome.awaitingCi,
      confirmedLocally: outcome.confirmedLocally,
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
  opts: { interactive?: boolean; sandbox?: boolean; pr?: boolean };
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
    noPr: opts.pr === false,
    blockUnresolvedRegressions: resolveDesignRegressionBlock(factoryConfig),
    hermeticGit: resolveHermeticGit(repoConfig),
    readinessUpdateIssueBody: resolveReadinessUpdateIssueBody(factoryConfig),
    publishFromBuild: resolveBuildPublish(factoryConfig),
    sizeGateMode,
    maxSlices,
    sizeBudget: resolveSizeGateBudget(factoryConfig),
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
    codexWorkspacePaths: {
      primaryRepoRoot: repoRoot,
      writableRoots: [
        paths.state,
        resolve(repoRoot, '.git'),
        ...resolveConfiguredWritablePaths(factoryConfig.sandbox.writablePaths, { home: homedir(), repoRoot }),
      ],
    },
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
    worktreeKeepsPath: paths.worktreeKeeps,
  };
}
