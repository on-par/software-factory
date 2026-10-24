// packages/cli/src/cli/run.ts — the factory run handler, moved out of index.ts (#2800)

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import {
  LaneFileGuard,
  applyRepoConfig,
  clearProxyState,
  getFactoryPaths,
  provisionLaneContainer,
  resolveCodexDisabled,
  resolveEffectiveBuildRoute,
  resolveEnvironmentProxy,
  resolveLaneBreakerThreshold,
  resolveMergePolicy,
  resolveSizeGateMode,
} from '@on-par/factory-core';
import type { FactoryEvent, HealthKpis, KpiReconstruction, QueueDiagnostic } from '@on-par/factory-core';
import {
  createDockerEngine,
  createGithubQueue,
  createFileIterateStore,
  createFileReviewReworkStore,
  createOctokitCollaboratorPermissionClient,
  createOctokitQueueClient,
  createOctokitIterateGitHub,
  createOctokitReviewReworkGitHub,
  formatQueueOrderConflict,
  logEvent,
  parkPayload,
  pollIterateCommands,
  pollReviewRework,
  publishParkComment,
  recordSliceMerged,
  resolveBaseHealthChecks,
  resolveLocalOnly,
  resolveMaxReviewReworkRuns,
  resolveQueueClaimSettleMs,
  resolveRunUsageHarness,
  settleParkedPullRequest,
  slugify,
  withAdmissionGuard,
} from '@on-par/factory-core/internal';

import { admissionStateReaderFor } from './admission.js';
import { baseChecksVerdict } from './base-health-ci.js';
import { createBaseHoldGate, formatBaseHoldCleared } from './base-hold.js';
import { keychainPreflightError, type KeychainProbeStatus } from './doctor.js';
import type {
  CliDeps,
  CliExitError,
  UsageKnobs,
  createQueuePreflightOps,
  planRunLanes,
  preflightQueuedIssue,
  reapParkedLaneWorktree,
  resolveUsageKnobs,
  startLaneProxy,
  sweepBetweenLaneIssues,
  usageWatchSourceLabel,
  withRepoRunLock,
} from './index.js';
import { awaitingCiLaneDeps } from './awaiting-ci-wiring.js';
import { runEndOfRunKpiSnapshot } from './kpi-sweep.js';
import { waitForMerge } from './land.js';
import { hostClaimGuards } from './host-claim-guards.js';
import { DRAIN_MESSAGE, createNotifier, resolveNotifyCommand, withDiskLowNotify, withParkNotify } from './notify.js';
import { runLane } from './run-lane.js';
import { restackFromSlicePlan } from './run-restack.js';
import { writeRunFlagOverrides } from './run-flags.js';
import { shipIssue } from './ship.js';
import { readStopFileStatus, stopSentinelRunSkipMessage } from './stop-sentinel.js';

export interface RunOptions {
  localQueue?: boolean;
  autoMerge?: boolean;
  prClassifier?: boolean;
  usageWatch?: boolean;
  usageThreshold?: string;
  usagePoll?: string;
  branchPrefix?: string;
  notify?: string;
}

/** index.ts's helpers for `factory run`, built at call time so main() deps injection reaches the handler. */
export interface RunRuntime {
  configLoaders: Required<
    Pick<CliDeps, 'loadFactoryConfigForRepo' | 'loadRepoConfig' | 'loadModelsConfig' | 'resolveEffectiveModelPins'>
  >;
  coreOps: Required<Pick<CliDeps, 'ModelRegistry' | 'watchUsage'>>;
  shellOps: Required<Pick<CliDeps, 'exec'>>;
  readCosts: Required<CliDeps>['readCosts'];
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  branchPrefixOrExit: (raw: string | undefined) => string;
  withRepoRunLock: typeof withRepoRunLock;
  runAutoWorktreeGc: (
    repoRoot: string,
    paths: ReturnType<typeof getFactoryPaths>,
    ghRepo: string,
    eventScope: string | number,
  ) => Promise<void>;
  sweepStaleLaneClaims: (paths: ReturnType<typeof getFactoryPaths>, ghRepo: string) => Promise<void>;
  sweepOrphanDrafts: (paths: ReturnType<typeof getFactoryPaths>, ghRepo: string) => Promise<void>;
  planRunLanes: typeof planRunLanes;
  preflightQueuedIssue: typeof preflightQueuedIssue;
  createQueuePreflightOps: typeof createQueuePreflightOps;
  warnQueueDiagnostics: (diagnostics: QueueDiagnostic[]) => void;
  resolveUsageKnobs: typeof resolveUsageKnobs;
  usageFlagOverrides: (
    opts: { usageWatch?: boolean; usageThreshold?: string; usagePoll?: string },
    threshold: 'stopAt' | 'resumeAt',
  ) => Parameters<typeof resolveUsageKnobs>[2];
  usageWatchSourceLabel: typeof usageWatchSourceLabel;
  probeClaudeKeychain: () => KeychainProbeStatus;
  startLaneProxy: typeof startLaneProxy;
  sweepBetweenLaneIssues: typeof sweepBetweenLaneIssues;
  reapParkedLaneWorktree: typeof reapParkedLaneWorktree;
  reconstructHumanEventsForKpis: (
    events: FactoryEvent[],
    branchPrefix: string,
  ) => Promise<KpiReconstruction & { owner: string; repoName: string }>;
  appendKpiSnapshot: (
    paths: ReturnType<typeof getFactoryPaths>,
    repoRoot: string,
    kpis: HealthKpis,
    opts?: { partial?: boolean },
  ) => Promise<unknown>;
  CliExitError: typeof CliExitError;
}

export async function cmdRun(opts: RunOptions, rt: RunRuntime): Promise<void> {
  const repoRoot = await rt.getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const branchPrefix = rt.branchPrefixOrExit(opts.branchPrefix);

  return rt.withRepoRunLock(paths, 'factory run', async () => {
    const deferredIssues = new Set<number>();
    const runStartedAt = new Date().toISOString();
    const stopStatus = readStopFileStatus(paths);
    if (stopStatus.present) {
      const msg = stopSentinelRunSkipMessage(stopStatus);
      console.log(styleText('yellow', `!! ${msg}`));
      logEvent(paths.events, 'stopped', 'all', msg);
      return;
    }
    const notifier = createNotifier(resolveNotifyCommand(opts.notify, process.env), {
      onError: (m) => logEvent(paths.events, 'warn', '-', m),
    });
    writeRunFlagOverrides(paths.runFlags, { autoMerge: opts.autoMerge, prClassifier: opts.prClassifier });
    const ghRepo = await rt.getGitHubRepo();
    const factoryConfig = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
    const keychainErr = keychainPreflightError(rt.probeClaudeKeychain());
    if (keychainErr) {
      logEvent(paths.events, 'environment_warning', 'all', keychainErr);
      throw new Error(keychainErr);
    }
    await rt.runAutoWorktreeGc(repoRoot, paths, ghRepo, 'all');
    await rt.sweepStaleLaneClaims(paths, ghRepo);
    await rt.sweepOrphanDrafts(paths, ghRepo);

    const { lanes, diagnostics } = await rt.planRunLanes({
      localQueue: opts.localQueue === true,
      readLocalQueue: () => (existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : null),
      queue: () => {
        const [owner, repo] = ghRepo.split('/');
        const octokit = rt.getOctokit();
        return createGithubQueue({
          client: createOctokitQueueClient(octokit),
          owner,
          repo,
          claimSettleMs: resolveQueueClaimSettleMs(factoryConfig),
          preflight: withAdmissionGuard({
            reader: admissionStateReaderFor(paths.state),
            preflight: (issue) =>
              rt.preflightQueuedIssue(
                issue,
                rt.createQueuePreflightOps(octokit, owner, repo, {
                  autoMergeStack:
                    resolveSizeGateMode(factoryConfig) === 'stack' &&
                    resolveMergePolicy(factoryConfig, process.env, { auto: opts.autoMerge }).auto,
                  stackMode: resolveSizeGateMode(factoryConfig) === 'stack',
                  laneFileHold: (n) => new LaneFileGuard(paths.laneFiles).liveHold(ghRepo, n),
                  onDeferred: (issue, message) => {
                    if (deferredIssues.has(issue)) return;
                    deferredIssues.add(issue);
                    logEvent(paths.events, 'issue_deferred', issue, message);
                  },
                }),
              ),
            onConflict: (issue, verdict) => {
              const line = `#${issue} refused — ${verdict.reason} | repair: ${verdict.repair}`;
              console.error(styleText('yellow', `factory: ${line}`));
              logEvent(paths.events, 'queue_admission_conflict', String(issue), line);
            },
          }),
          onOrderConflict: (conflict) => {
            const line = formatQueueOrderConflict(conflict);
            console.error(styleText('yellow', `factory: ${line}`));
            logEvent(paths.events, 'queue_order_conflict', conflict.issues.join(','), line, { lane: conflict.lane });
          },
        });
      },
    });
    rt.warnQueueDiagnostics(diagnostics);

    let knobs: UsageKnobs;
    let laneBreakerThreshold: number;
    let baseHealthChecks: string[] | undefined;
    try {
      knobs = rt.resolveUsageKnobs(
        process.env,
        rt.configLoaders.loadRepoConfig(repoRoot),
        rt.usageFlagOverrides(opts, 'stopAt'),
      );
      laneBreakerThreshold = resolveLaneBreakerThreshold(rt.configLoaders.loadRepoConfig(repoRoot));
      baseHealthChecks = resolveBaseHealthChecks(rt.configLoaders.loadRepoConfig(repoRoot));
    } catch (err: any) {
      throw new rt.CliExitError(`factory: ${err.message}`, 2);
    }
    if (knobs.watchSource === 'flag') {
      const detail = `usage watchdog ${knobs.watch ? 'enabled' : 'disabled'} by ${rt.usageWatchSourceLabel(knobs.watchSource, knobs.watch)}`;
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    if (knobs.stopAtSource === 'flag') {
      const detail = 'usage watchdog threshold set by flag: --usage-threshold';
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    if (knobs.pollSource === 'flag') {
      const detail = 'usage watchdog poll set by flag: --usage-poll';
      console.log(`[factory] run: ${detail}`);
      logEvent(paths.events, 'watchdog', 'all', detail);
    }
    let watchdogHarness: string | undefined;
    if (knobs.watch) {
      try {
        const repoConfig = rt.configLoaders.loadRepoConfig(repoRoot);
        const registry = new rt.coreOps.ModelRegistry(applyRepoConfig(rt.configLoaders.loadModelsConfig(), repoConfig));
        const pins = rt.configLoaders.resolveEffectiveModelPins(registry, repoConfig, process.env);
        const localOnly = resolveLocalOnly();
        const codexDisabled = resolveCodexDisabled(repoConfig);
        const build = resolveEffectiveBuildRoute(registry, repoConfig, pins, { localOnly, codexDisabled });
        watchdogHarness = resolveRunUsageHarness({
          buildRoute: build.route,
          buildRouteSource: build.source,
          planHarnesses: [pins.plan, pins.planFallback]
            .filter((m): m is string => !!m)
            .map((m) => registry.getHarnessId(m)),
          codexDisabled,
          localOnly,
        });
      } catch {
        watchdogHarness = undefined; // unresolvable config keeps today's Claude gating
      }
    }
    const controller = new AbortController();
    const watchdog = knobs.watch
      ? rt.coreOps
          .watchUsage({
            cap: knobs.cap,
            stopAt: knobs.stopAt,
            pollMs: knobs.pollMs,
            stopFile: paths.stop,
            eventsFile: paths.events,
            signal: controller.signal,
            estimator: knobs.estimator,
            ...(watchdogHarness ? { harness: watchdogHarness } : {}),
          })
          .catch((err: any) => {
            // a watchdog crash must never take down the run
            logEvent(paths.events, 'warn', '-', `usage watchdog crashed: ${err.message}`);
          })
      : Promise.resolve();

    const { proxy } = await rt.startLaneProxy(paths, resolveEnvironmentProxy(factoryConfig));

    const workspaceBackend = factoryConfig.workspace?.backend ?? 'host';
    const runId = randomUUID();
    const containerEngine = workspaceBackend === 'disposable-docker' ? createDockerEngine({}) : undefined;

    try {
      // Run lanes in parallel
      const pids: Promise<void>[] = [];
      // Issues in flight on any lane of this run; every lane's between-issues sweep protects them (#2964).
      const inFlightIssues = new Set<number>();
      // #3563: one shared, coalesced review-rework poll for every lane's pre-claim step (GitHub queue only).
      const runReviewReworkPoll = async (): Promise<void> => {
        const [owner = '', repo = ''] = ghRepo.split('/');
        const octokit = rt.getOctokit();
        const results = await pollReviewRework({
          github: createOctokitReviewReworkGitHub(octokit, owner, repo),
          queue: createOctokitQueueClient(octokit),
          owner,
          repo,
          branchPrefix,
          trustedApprovers: factoryConfig.intake?.trustedApprovers,
          permissions: createOctokitCollaboratorPermissionClient(octokit),
          store: createFileReviewReworkStore(paths.reviewRework),
          maxRuns: resolveMaxReviewReworkRuns(factoryConfig),
          publishParkComment: (input) => publishParkComment({ octokit, repo: ghRepo, input }),
        });
        for (const r of results) {
          if (r.outcome === 'queued') {
            logEvent(
              paths.events,
              'review_rework_queued',
              r.issue,
              `#${r.issue} queued for review rework on lane '${r.lane}' — PR #${r.pr} review ${r.reviewIds.join(', ')} by ${r.reviewer}`,
              { lane: r.lane },
            );
          } else if (r.outcome === 'capped') {
            logEvent(
              paths.events,
              'escalate',
              r.issue,
              `#${r.issue} parked: review rework cap ${r.cap} reached (${r.count} runs) — PR #${r.pr} review ${r.reviewIds.join(', ')}`,
              parkPayload('escalate', r.issue, r.lane, []),
            );
          } else if (r.outcome === 'error') {
            logEvent(paths.events, 'warn', r.issue, `review-rework poll for PR #${r.pr} failed: ${r.detail}`);
          }
        }
        // #3625: `/factory iterate` comments; a failure only warns so the review-rework results above stand.
        try {
          const iterated = await pollIterateCommands({
            github: createOctokitIterateGitHub(octokit, owner, repo),
            queue: createOctokitQueueClient(octokit),
            owner,
            repo,
            branchPrefix,
            trustedApprovers: factoryConfig.intake?.trustedApprovers,
            permissions: createOctokitCollaboratorPermissionClient(octokit),
            store: createFileIterateStore(paths.iterate),
          });
          for (const r of iterated) {
            if (r.outcome === 'queued' || r.outcome === 'already-queued') {
              logEvent(
                paths.events,
                'iterate_queued',
                r.issue,
                `#${r.issue} queued for iterate on lane '${r.lane}' — PR #${r.pr} comment ${r.commentId} by ${r.actor}`,
                { lane: r.lane },
              );
            } else if (r.outcome === 'rejected') {
              logEvent(paths.events, 'iterate_rejected', r.issue, `iterate on PR #${r.pr} rejected: ${r.detail}`);
            } else {
              logEvent(paths.events, 'warn', r.issue, `iterate poll for PR #${r.pr} failed: ${r.detail}`);
            }
          }
        } catch (err) {
          logEvent(paths.events, 'warn', 0, `iterate poll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      let reviewPoll: Promise<void> | null = null;
      const pollReviewReworkOnce = (): Promise<void> =>
        (reviewPoll ??= runReviewReworkPoll().finally(() => {
          reviewPoll = null;
        }));
      for (const planned of lanes) {
        logEvent(
          paths.events,
          'lane-start',
          '-',
          `lane '${planned.lane}' started${planned.issues.length ? ` (${planned.issues.length} issues)` : ''}`,
          { lane: planned.lane },
        );
        if (containerEngine) {
          const provision = await provisionLaneContainer(
            containerEngine,
            workspaceBackend,
            runId,
            slugify(planned.lane),
            ghRepo,
          );
          if (provision.attempted && !provision.created) {
            logEvent(
              paths.events,
              'warn',
              '-',
              `disposable-docker container creation failed for lane '${planned.lane}': ${provision.error}`,
              { lane: planned.lane },
            );
          } else if (provision.attempted && provision.created && provision.workspaceCloned === false) {
            logEvent(
              paths.events,
              'warn',
              '-',
              `disposable-docker workspace clone failed for lane '${planned.lane}': ${provision.workspaceError}`,
              { lane: planned.lane },
            );
          }
        }
        pids.push(
          runLane(planned.lane, planned.issues, repoRoot, ghRepo, paths, {
            ...planned.deps,
            ...(notifier ? { emitEvent: withDiskLowNotify(withParkNotify(logEvent, notifier), notifier) } : {}),
            laneBreakerThreshold,
            octokit: opts.localQueue === true ? undefined : () => rt.getOctokit(),
            pollReviewRework: opts.localQueue === true ? undefined : pollReviewReworkOnce,
            ...(opts.localQueue === true
              ? {}
              : awaitingCiLaneDeps(() => rt.getOctokit(), ghRepo, paths, factoryConfig)),
            runId,
            readParkSha: (branch) =>
              rt.shellOps
                .exec(`git rev-parse --verify ${JSON.stringify(`refs/remotes/origin/${branch}`)}`, { cwd: repoRoot })
                .then((r) => r.stdout.trim()),
            activeIssues: inFlightIssues,
            ...hostClaimGuards(factoryConfig, { repoRoot, ghRepo, stateRoot: paths.root }, opts.localQueue === true),
            baseHoldGate:
              opts.localQueue === true
                ? undefined
                : createBaseHoldGate({
                    file: paths.baseHold,
                    repo: ghRepo,
                    onCleared: (c) =>
                      logEvent(paths.events, 'base-hold-cleared', planned.lane, formatBaseHoldCleared(c), {
                        lane: planned.lane,
                      }),
                    git: (cmd) => rt.shellOps.exec(cmd, { cwd: repoRoot }).then((r) => r.stdout),
                    requiredChecksVerdict: (sha) => {
                      const [owner, repoName] = ghRepo.split('/');
                      return baseChecksVerdict(rt.getOctokit(), owner, repoName, {
                        checks: baseHealthChecks,
                        events: paths.events,
                        lane: planned.lane,
                      })(sha);
                    },
                  }),
            commentIssue: async (issue, body) => {
              const [owner, repoName] = ghRepo.split('/');
              await rt.getOctokit().rest.issues.createComment({ owner, repo: repoName, issue_number: issue, body });
            },
            ship: (issue, o, c) => shipIssue(issue, { ...o, branchPrefix, prClassifier: opts.prClassifier }, c),
            sweepFinished: (issue) =>
              rt
                .sweepBetweenLaneIssues(issue, planned.lane, repoRoot, ghRepo, paths, {
                  protectedIssues: () => inFlightIssues,
                })
                .then(() => {}),
            reapWorktree: (issue) =>
              rt.reapParkedLaneWorktree(
                issue,
                repoRoot,
                ghRepo,
                paths,
                opts.branchPrefix === undefined ? undefined : branchPrefix,
              ),
            closeParkedPr: (issue, branch, reason) =>
              settleParkedPullRequest({
                octokit: rt.getOctokit(),
                repo: ghRepo,
                issue,
                branch,
                reason,
                greenAndChecked: false,
                log: (type, msg) => logEvent(paths.events, type, issue, msg, { lane: planned.lane }),
              }).then(() => {}),
            recordStackMerge: (issue, prNumber) =>
              recordSliceMerged({ octokit: rt.getOctokit(), repo: ghRepo, issue, prNumber }).then(() => {}),
            restack: (issue, merged) =>
              restackFromSlicePlan({ octokit: rt.getOctokit(), repo: ghRepo, repoRoot, issue, merged }),
            waitMerge: (issue, branch, root, gh, p, d = {}) =>
              waitForMerge(issue, branch, root, gh, p, { ...d, mergeOverrides: { auto: opts.autoMerge } }),
          }),
        );
      }

      await Promise.allSettled(pids);
      controller.abort();
      await watchdog;
      logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
      if (notifier) {
        notifier.notify({
          kind: 'drain',
          ts: new Date().toISOString(),
          message: DRAIN_MESSAGE,
          parked: notifier.parked,
        });
        await notifier.settle();
      }
    } finally {
      if (proxy) {
        await proxy.stop();
        clearProxyState(paths.proxyState);
      }
    }

    if (lanes.length > 0) await runEndOfRunKpiSnapshot(paths, repoRoot, branchPrefix, runStartedAt, rt);
  });
}
