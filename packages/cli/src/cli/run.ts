// packages/cli/src/cli/run.ts — the factory run handler, moved out of index.ts (#2800)

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import {
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
  createOctokitGreenPrClient,
  createOctokitQueueClient,
  evaluateLoadGuard,
  fetchRequiredChecksVerdict,
  formatQueueOrderConflict,
  logEvent,
  readHostLoad,
  recordSliceMerged,
  resolveHostLoadGuard,
  resolveLocalOnly,
  resolveRunUsageHarness,
  slugify,
  withAdmissionGuard,
} from '@on-par/factory-core/internal';

import { admissionStateReaderFor } from './admission.js';
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
import { runEndOfRunKpiSnapshot } from './kpi-sweep.js';
import { waitForMerge } from './land.js';
import { runLane } from './run-lane.js';
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
    const runStartedAt = new Date().toISOString();
    const stopStatus = readStopFileStatus(paths);
    if (stopStatus.present) {
      const msg = stopSentinelRunSkipMessage(stopStatus);
      console.log(styleText('yellow', `!! ${msg}`));
      logEvent(paths.events, 'stopped', 'all', msg);
      return;
    }
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
          preflight: withAdmissionGuard({
            reader: admissionStateReaderFor(paths.state),
            preflight: (issue) =>
              rt.preflightQueuedIssue(
                issue,
                rt.createQueuePreflightOps(octokit, owner, repo, {
                  autoMergeStack:
                    resolveSizeGateMode(factoryConfig) === 'stack' &&
                    resolveMergePolicy(factoryConfig, process.env, { auto: opts.autoMerge }).auto,
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

    const loadGuardPolicy = resolveHostLoadGuard(factoryConfig);
    let knobs: UsageKnobs;
    let laneBreakerThreshold: number;
    try {
      knobs = rt.resolveUsageKnobs(
        process.env,
        rt.configLoaders.loadRepoConfig(repoRoot),
        rt.usageFlagOverrides(opts, 'stopAt'),
      );
      laneBreakerThreshold = resolveLaneBreakerThreshold(rt.configLoaders.loadRepoConfig(repoRoot));
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
        const build = resolveEffectiveBuildRoute(registry, repoConfig, pins);
        watchdogHarness = resolveRunUsageHarness({
          buildRoute: build.route,
          buildRouteSource: build.source,
          planHarnesses: [pins.plan, pins.planFallback]
            .filter((m): m is string => !!m)
            .map((m) => registry.getHarnessId(m)),
          codexDisabled: resolveCodexDisabled(repoConfig),
          localOnly: resolveLocalOnly(),
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
            laneBreakerThreshold,
            activeIssues: inFlightIssues,
            loadGuard: opts.localQueue === true ? undefined : () => evaluateLoadGuard(loadGuardPolicy, readHostLoad()),
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
                      return fetchRequiredChecksVerdict(rt.getOctokit(), {
                        owner,
                        repo: repoName,
                        branch: 'main',
                        sha,
                      });
                    },
                    listCheckRuns: (ref) => {
                      const [owner, repoName] = ghRepo.split('/');
                      return createOctokitGreenPrClient(rt.getOctokit()).listCheckRuns({ owner, repo: repoName, ref });
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
            recordStackMerge: (issue, prNumber) =>
              recordSliceMerged({ octokit: rt.getOctokit(), repo: ghRepo, issue, prNumber }).then(() => {}),
            waitMerge: (issue, branch, root, gh, p, d = {}) =>
              waitForMerge(issue, branch, root, gh, p, { ...d, mergeOverrides: { auto: opts.autoMerge } }),
          }),
        );
      }

      await Promise.allSettled(pids);
      controller.abort();
      await watchdog;
      logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
    } finally {
      if (proxy) {
        await proxy.stop();
        clearProxyState(paths.proxyState);
      }
    }

    if (lanes.length > 0) await runEndOfRunKpiSnapshot(paths, repoRoot, branchPrefix, runStartedAt, rt);
  });
}
