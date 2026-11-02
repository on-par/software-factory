// packages/cli/src/cli/status.ts — the factory status handler, moved out of index.ts (#2798)

import { existsSync, readFileSync } from 'node:fs';
import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import {
  applyRepoConfig,
  computeHealthKpis,
  describeEffectiveConfig,
  formatKpiLines,
  getFactoryPaths,
  parseQueue,
  partitionLocalQueueByActivity,
  ProviderBreaker,
  readEvents,
  resolveAutoFailover,
  resolveMergePolicy,
} from '@on-par/factory-core';
import type { ActiveQueueClaim, QueueDiagnostic } from '@on-par/factory-core';
import {
  createGithubQueue,
  createOctokitQueueClient,
  daemonRuntimePaths,
  formatQueueOrderConflict,
  formatWorktreeLocation,
  hostBuildSlotsDir,
  IN_PROGRESS_LABEL,
  listHostSlots,
  partitionGithubClaimsByActivity,
  recordLocalAuthFailure,
  resolveEffectiveConfig,
  resolveHostMaxBuilds,
  describeDraftPrPolicy,
  resolveDraftPrPolicy,
  resolvePrClassifierPolicy,
  resolveWorktreeRoot,
  createDiskGuard,
  readStopMarker,
  formatBreakerRemaining,
  formatOpenFactoryDraftsLine,
  readOpenFactoryDrafts,
  resolveBranchPrefix,
} from '@on-par/factory-core/internal';
import type { DiskGuard, OpenFactoryDrafts, QueueOrderConflict } from '@on-par/factory-core/internal';

import { formatBaseHoldStatus, readBaseHold } from './base-hold.js';
import { notInitializedMessage } from './first-run.js';
import type { CliDeps, CliExitError, readActiveProduct } from './index.js';
import { readRunFlagOverrides } from './run-flags.js';
import { readStopFileStatus, stopSentinelStatusLine } from './stop-sentinel.js';
import { formatHostSlotsSection } from './status-host-slots.js';
import { buildStatusJson, statusProviderInputs } from './status-json.js';
import { checkSweepHeartbeat, defaultSweepHeartbeatDeps, formatSweepHeartbeatStatusLine } from './sweep-heartbeat.js';
import { buildStatusUpdateJson, formatUpdateStatusLine, readUpdateState, updateStatePath } from './update-state.js';

export interface StatusOptions {
  kpis?: boolean;
  json?: boolean;
}

/** index.ts's helpers for `factory status`, built at call time so main() deps injection reaches the handler. */
export interface StatusRuntime {
  configLoaders: Required<
    Pick<CliDeps, 'loadRepoConfig' | 'loadModelsConfig' | 'loadRoutesConfig' | 'loadFactoryConfigForRepo'>
  >;
  ModelRouter: Required<CliDeps>['ModelRouter'];
  readCosts: Required<CliDeps>['readCosts'];
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  hasGitHubToken: () => boolean;
  readActiveProduct: typeof readActiveProduct;
  warnQueueDiagnostics: (diagnostics: QueueDiagnostic[]) => void;
  errorDetail: (err: unknown) => string;
  CliExitError: typeof CliExitError;
  /** Resolves the repo config file's display path, so messages name the file actually loaded (#2570). */
  repoConfigFileFor: (repoRoot: string, absPath: string) => { absPath: string; relPath: string };
}

/** Formats the time since `lastActivityAt` as a short duration (e.g. `3m`) for the
 *  `factory status` `== Active ==` section's `[phase, <age> ago]` display (#1343). An
 *  active claim's heartbeat is always within DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS
 *  (15m), so minutes is the only unit that ever shows. */
function formatClaimAge(lastActivityAt: string, now: number): string {
  const ageMs = Math.max(0, now - Date.parse(lastActivityAt));
  const minutes = Math.floor(ageMs / 60_000);
  return minutes < 1 ? '<1m' : `${minutes}m`;
}

interface ActiveClaimsView {
  hasQueueFile: boolean;
  active: Array<Pick<ActiveQueueClaim, 'lane' | 'issue' | 'phase' | 'lastActivityAt'>>;
  staleCount: number;
  diagnostics: QueueDiagnostic[];
  /** A token was present and the GitHub lookup ran. */
  githubChecked: boolean;
  githubError: string | null;
}

/** Reads both Active sources once: the local queue file and GitHub-label-queue claims (#3344).
 *  An issue already in the local queue file is judged from that entry only. */
async function readActiveClaims(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  rt: StatusRuntime,
): Promise<ActiveClaimsView> {
  const view: ActiveClaimsView = {
    hasQueueFile: existsSync(paths.queue),
    active: [],
    staleCount: 0,
    diagnostics: [],
    githubChecked: false,
    githubError: null,
  };
  const localIssues = new Set<number>();
  if (view.hasQueueFile) {
    const { entries, diagnostics } = parseQueue(readFileSync(paths.queue, 'utf-8'));
    view.diagnostics = diagnostics;
    for (const e of entries) localIssues.add(e.issue);
    if (entries.length > 0) {
      const local = await partitionLocalQueueByActivity(entries, paths.runs);
      view.active.push(...local.active);
      view.staleCount += local.staleCount;
    }
  }
  if (rt.hasGitHubToken()) {
    view.githubChecked = true;
    try {
      const [owner, repo] = ghRepo.split('/');
      const inProgress = await createOctokitQueueClient(rt.getOctokit()).listOpenIssuesWithLabels({
        owner,
        repo,
        labels: [IN_PROGRESS_LABEL],
      });
      const github = await partitionGithubClaimsByActivity(
        inProgress.filter((i) => !localIssues.has(i.number)),
        paths.runs,
      );
      view.active.push(...github.active);
      view.staleCount += github.staleCount;
    } catch (err) {
      view.githubError = rt.errorDetail(err);
    }
  }
  return view;
}

/** Open factory drafts for the Health band and JSON (#3553); null when no token, the config is unreadable, or the listing fails. */
async function readDrafts(ghRepo: string, configPath: string, rt: StatusRuntime): Promise<OpenFactoryDrafts | null> {
  if (!rt.hasGitHubToken()) return null;
  const [owner, repo] = ghRepo.split('/');
  let prefix: string;
  try {
    prefix = resolveBranchPrefix(rt.configLoaders.loadFactoryConfigForRepo(configPath));
  } catch {
    return null;
  }
  return readOpenFactoryDrafts({ octokit: rt.getOctokit(), owner, repo, prefix });
}

/** Disk state for the Health band and JSON (#2284); null when unreadable. */
function readStatusDisk(
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  rt: StatusRuntime,
): ReturnType<DiskGuard['status']> {
  try {
    const config = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
    return createDiskGuard(config, { repoRoot, ghRepo, stateRoot: paths.root }).status();
  } catch {
    return null;
  }
}

export async function cmdStatus(opts: StatusOptions, rt: StatusRuntime): Promise<void> {
  if (opts.json) {
    // `--kpis` is deliberately ignored here: the JSON shape is fixed (#1101).
    const repoRoot = await rt.getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    if (!existsSync(paths.root)) throw new rt.CliExitError(`factory: ${notInitializedMessage()}`, 2);
    const ghRepo = await rt.getGitHubRepo();
    const view = await readActiveClaims(paths, ghRepo, rt);
    rt.warnQueueDiagnostics(view.diagnostics);
    const marker = readStopMarker(paths.stop);
    let inputs: ReturnType<typeof statusProviderInputs> = { providers: [], stages: [] };
    try {
      const repoConfig = rt.configLoaders.loadRepoConfig(repoRoot);
      const effective = resolveEffectiveConfig(repoConfig);
      const router = new rt.ModelRouter(
        applyRepoConfig(rt.configLoaders.loadModelsConfig(), repoConfig),
        rt.configLoaders.loadRoutesConfig(),
        false,
        undefined,
        effective.allowExperimental,
        effective.localOnly,
      );
      const failoverEnabled = resolveAutoFailover(rt.configLoaders.loadFactoryConfigForRepo(paths.config)).enabled;
      inputs = statusProviderInputs(router, { failoverEnabled });
    } catch {
      // config unreadable: report no providers rather than failing status --json
    }
    console.log(
      JSON.stringify(
        buildStatusJson({
          repo: ghRepo,
          product: rt.readActiveProduct(paths.product) ?? null,
          stop: existsSync(paths.stop),
          stopInfo: marker ? { source: marker.source, setAt: marker.at ?? null } : null,
          breakers: await new ProviderBreaker(paths.breaker).list(),
          providers: inputs.providers,
          stages: inputs.stages,
          active: view.active,
          update: buildStatusUpdateJson(readUpdateState(updateStatePath(daemonRuntimePaths().dir))),
          openFactoryDrafts: await readDrafts(ghRepo, paths.config, rt),
          disk: readStatusDisk(repoRoot, ghRepo, paths, rt),
          now: Date.now(),
        }),
      ),
    );
    return;
  }
  const repoRoot = await rt.getRepoRoot();
  const ghRepo = await rt.getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  const repoConfig = rt.configLoaders.loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(rt.configLoaders.loadModelsConfig(), repoConfig);
  const routesConfig = rt.configLoaders.loadRoutesConfig();
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new rt.ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  const sandbox = rt.configLoaders.loadFactoryConfigForRepo(paths.config).sandbox;
  router.setCodexFullAccessTasks?.(sandbox.codexFullAccessTasks);
  router.setCodexSandbox?.(sandbox.codexSandbox);
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  const product = rt.readActiveProduct(paths.product) ?? '(none)';

  console.log(styleText('bold', `== ${ghRepo} ==`));
  console.log(`Product: ${product}`);
  const worktreeParent = rt.configLoaders.loadFactoryConfigForRepo(paths.config).worktree.parent;
  console.log(
    formatWorktreeLocation(resolveWorktreeRoot({ repoRoot, parent: worktreeParent, repo: ghRepo }), worktreeParent),
  );

  console.log(styleText('bold', '\n== Active =='));
  const view = await readActiveClaims(paths, ghRepo, rt);
  if (view.active.length > 0) {
    const now = Date.now();
    for (const e of view.active) {
      console.log(`  ${e.lane} #${e.issue}  [${e.phase}, ${formatClaimAge(e.lastActivityAt, now)} ago]`);
    }
  } else if (!view.hasQueueFile && !view.githubChecked) {
    console.log('  (no queue file)');
  } else if (view.diagnostics.length === 0 || view.githubChecked) {
    console.log('  (idle — no active claims)');
  }
  if (view.staleCount > 0) {
    console.log(`  (${view.staleCount} stale entr${view.staleCount === 1 ? 'y' : 'ies'} hidden — no recent activity)`);
  }
  if (view.githubError) console.log(`  (GitHub claim lookup failed — ${view.githubError})`);
  rt.warnQueueDiagnostics(view.diagnostics);

  const baseHold = readBaseHold(paths.baseHold);
  if (baseHold !== null && baseHold.repo === ghRepo) {
    console.log(styleText('bold', '\n== Base hold =='));
    for (const line of formatBaseHoldStatus(baseHold)) console.log(line);
  }

  console.log(styleText('bold', '\n== Host slots =='));
  try {
    const maxBuilds = resolveHostMaxBuilds(rt.configLoaders.loadFactoryConfigForRepo(paths.config));
    for (const line of formatHostSlotsSection(listHostSlots(hostBuildSlotsDir()), maxBuilds)) console.log(line);
  } catch (err) {
    console.log(`  (host slot lookup failed — ${rt.errorDetail(err)})`);
  }

  console.log(styleText('bold', '\n== Queue =='));
  if (!rt.hasGitHubToken()) {
    console.log('  (no GitHub token — run `gh auth login`)');
  } else {
    const [owner, repoName] = ghRepo.split('/');
    const orderConflicts: QueueOrderConflict[] = [];
    const githubQueue = createGithubQueue({
      client: createOctokitQueueClient(rt.getOctokit()),
      owner,
      repo: repoName,
      onOrderConflict: (c) => orderConflicts.push(c),
    });
    try {
      const lanes = await githubQueue.lanes();
      let printed = false;
      for (const lane of lanes) {
        const issues = await githubQueue.list(lane);
        for (const issue of issues) {
          console.log(`  ${lane} #${issue}`);
          printed = true;
        }
      }
      for (const c of orderConflicts) {
        console.log(styleText('yellow', `  ⚠ ${formatQueueOrderConflict(c)}`));
      }
      if (!printed) {
        console.log('  (no claimable work)');
      }
    } catch (err) {
      console.log(`  (queue lookup failed — ${rt.errorDetail(err)})`);
    }
  }

  console.log(styleText('bold', '\n== Health =='));
  const update = buildStatusUpdateJson(readUpdateState(updateStatePath(daemonRuntimePaths().dir)));
  console.log(`  ${formatUpdateStatusLine(update)}`);
  console.log(`  ${formatOpenFactoryDraftsLine(await readDrafts(ghRepo, paths.config, rt))}`);
  const disk = readStatusDisk(repoRoot, ghRepo, paths, rt);
  if (disk?.low) {
    console.log(styleText('red', `  DISK LOW: free=${disk.freeGb} GB threshold=${disk.thresholdGb} GB`));
  }

  if (opts.kpis) {
    console.log(styleText('bold', '\n  Effective config:'));
    for (const line of describeEffectiveConfig({
      router,
      repo: repoConfig,
      repoConfigPath: rt.repoConfigFileFor(repoRoot, paths.config).relPath,
      mergePolicy: resolveMergePolicy(rt.configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
        auto: readRunFlagOverrides(paths.runFlags).autoMerge,
      }),
      prClassifier: resolvePrClassifierPolicy(rt.configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
        classifier: readRunFlagOverrides(paths.runFlags).prClassifier,
      }),
      runtime: rt.configLoaders.loadFactoryConfigForRepo(paths.config),
    })) {
      console.log(`    ${line}`);
    }
    console.log(
      `    ${describeDraftPrPolicy(
        resolveDraftPrPolicy(
          rt.configLoaders.loadFactoryConfigForRepo(paths.config),
          readRunFlagOverrides(paths.runFlags).draftPr,
        ),
        rt.repoConfigFileFor(repoRoot, paths.config).relPath,
      )}`,
    );
  } else {
    console.log('\n  (Effective config and KPIs hidden — run `factory status --kpis` to view)');
  }

  console.log(styleText('bold', '\n  Provider breaker:'));
  const openBreakers = await new ProviderBreaker(paths.breaker).list();
  if (openBreakers.length === 0) {
    console.log('    (closed)');
  } else {
    for (const b of openBreakers) {
      console.log(`    ${b.provider}: OPEN (${b.reason}) — ${formatBreakerRemaining(b.remainingMs)}`);
    }
  }

  console.log(styleText('bold', '\n  Sweep heartbeat:'));
  const sweepStatus = checkSweepHeartbeat(
    rt.configLoaders.loadFactoryConfigForRepo(paths.config).sweep,
    process.env,
    defaultSweepHeartbeatDeps(),
  );
  console.log(`    ${formatSweepHeartbeatStatusLine(sweepStatus)}`);

  console.log(styleText('bold', '\n  Last Events:'));
  if (existsSync(paths.events)) {
    const events = readFileSync(paths.events, 'utf-8').trim().split('\n').slice(-12);
    for (const e of events) {
      try {
        const ev = JSON.parse(e);
        console.log(`    ${ev.type} #${ev.issue}: ${ev.msg}`);
      } catch {}
    }
  } else {
    console.log('    (none)');
  }

  if (opts.kpis) {
    console.log(styleText('bold', '\n  KPIs:'));
    const kpiEvents = readEvents(paths.events, { includeSegments: true });
    const kpiCosts = existsSync(paths.costs) ? rt.readCosts(paths.costs) : [];
    for (const line of formatKpiLines(computeHealthKpis(kpiEvents, kpiCosts))) {
      console.log(`    ${line}`);
    }
  }

  const stopLine = stopSentinelStatusLine(readStopFileStatus(paths));
  if (stopLine) console.log(styleText('red', `\n!! ${stopLine}`));
}
