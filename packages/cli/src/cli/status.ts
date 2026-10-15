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
  resolveMergePolicy,
} from '@on-par/factory-core';
import type { QueueDiagnostic } from '@on-par/factory-core';
import {
  createGithubQueue,
  createOctokitQueueClient,
  daemonRuntimePaths,
  formatWorktreeLocation,
  recordLocalAuthFailure,
  resolveEffectiveConfig,
  resolvePrClassifierPolicy,
  resolveWorktreeRoot,
} from '@on-par/factory-core/internal';

import { formatBaseHoldStatus, readBaseHold } from './base-hold.js';
import { notInitializedMessage } from './first-run.js';
import type { CliDeps, CliExitError, readActiveProduct } from './index.js';
import { readRunFlagOverrides } from './run-flags.js';
import { readStopFileStatus, stopSentinelStatusLine } from './stop-sentinel.js';
import { buildStatusJson } from './status-json.js';
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

export async function cmdStatus(opts: StatusOptions, rt: StatusRuntime): Promise<void> {
  if (opts.json) {
    // `--kpis` is deliberately ignored here: the JSON shape is fixed (#1101).
    const repoRoot = await rt.getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    if (!existsSync(paths.root)) throw new rt.CliExitError(`factory: ${notInitializedMessage()}`, 2);
    const ghRepo = await rt.getGitHubRepo();
    let active: Awaited<ReturnType<typeof partitionLocalQueueByActivity>>['active'] = [];
    if (existsSync(paths.queue)) {
      const { entries, diagnostics } = parseQueue(readFileSync(paths.queue, 'utf-8'));
      if (entries.length > 0) ({ active } = await partitionLocalQueueByActivity(entries, paths.runs));
      rt.warnQueueDiagnostics(diagnostics);
    }
    console.log(
      JSON.stringify(
        buildStatusJson({
          repo: ghRepo,
          product: rt.readActiveProduct(paths.product) ?? null,
          stop: existsSync(paths.stop),
          breakers: await new ProviderBreaker(paths.breaker).list(),
          active,
          update: buildStatusUpdateJson(readUpdateState(updateStatePath(daemonRuntimePaths().dir))),
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
  router.setLocalAuthSink?.(recordLocalAuthFailure);
  const product = rt.readActiveProduct(paths.product) ?? '(none)';

  console.log(styleText('bold', `== ${ghRepo} ==`));
  console.log(`Product: ${product}`);
  const worktreeParent = rt.configLoaders.loadFactoryConfigForRepo(paths.config).worktree.parent;
  console.log(
    formatWorktreeLocation(resolveWorktreeRoot({ repoRoot, parent: worktreeParent, repo: ghRepo }), worktreeParent),
  );

  console.log(styleText('bold', '\n== Active =='));
  if (existsSync(paths.queue)) {
    const { entries, diagnostics } = parseQueue(readFileSync(paths.queue, 'utf-8'));
    if (entries.length > 0) {
      const { active, staleCount } = await partitionLocalQueueByActivity(entries, paths.runs);
      if (active.length === 0) {
        console.log('  (idle — no active claims)');
      } else {
        const now = Date.now();
        for (const e of active) {
          console.log(`  ${e.lane} ${e.issue}  [${e.phase}, ${formatClaimAge(e.lastActivityAt, now)} ago]`);
        }
      }
      if (staleCount > 0) {
        console.log(`  (${staleCount} stale entr${staleCount === 1 ? 'y' : 'ies'} hidden — no recent activity)`);
      }
    } else if (diagnostics.length === 0) {
      console.log('  (idle — no active claims)');
    }
    rt.warnQueueDiagnostics(diagnostics);
  } else {
    console.log('  (no queue file)');
  }

  const baseHold = readBaseHold(paths.baseHold);
  if (baseHold !== null && baseHold.repo === ghRepo) {
    console.log(styleText('bold', '\n== Base hold =='));
    for (const line of formatBaseHoldStatus(baseHold)) console.log(line);
  }

  console.log(styleText('bold', '\n== Queue =='));
  if (!rt.hasGitHubToken()) {
    console.log('  (no GitHub token — run `gh auth login`)');
  } else {
    const [owner, repoName] = ghRepo.split('/');
    const githubQueue = createGithubQueue({ client: createOctokitQueueClient(rt.getOctokit()), owner, repo: repoName });
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

  if (opts.kpis) {
    console.log(styleText('bold', '\n  Effective config:'));
    for (const line of describeEffectiveConfig({
      router,
      repo: repoConfig,
      repoConfigPath: '.factory/config.json',
      mergePolicy: resolveMergePolicy(rt.configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
        auto: readRunFlagOverrides(paths.runFlags).autoMerge,
      }),
      prClassifier: resolvePrClassifierPolicy(rt.configLoaders.loadFactoryConfigForRepo(paths.config), process.env, {
        classifier: readRunFlagOverrides(paths.runFlags).prClassifier,
      }),
    })) {
      console.log(`    ${line}`);
    }
  } else {
    console.log('\n  (Effective config and KPIs hidden — run `factory status --kpis` to view)');
  }

  console.log(styleText('bold', '\n  Provider breaker:'));
  const openBreakers = await new ProviderBreaker(paths.breaker).list();
  if (openBreakers.length === 0) {
    console.log('    (closed)');
  } else {
    for (const b of openBreakers) {
      console.log(`    ${b.provider}: OPEN (${b.reason}) — ${Math.ceil(b.remainingMs / 60_000)}m remaining`);
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
    const kpiEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    const kpiCosts = existsSync(paths.costs) ? rt.readCosts(paths.costs) : [];
    for (const line of formatKpiLines(computeHealthKpis(kpiEvents, kpiCosts))) {
      console.log(`    ${line}`);
    }
  }

  const stopLine = stopSentinelStatusLine(readStopFileStatus(paths));
  if (stopLine) console.log(styleText('red', `\n!! ${stopLine}`));
}
