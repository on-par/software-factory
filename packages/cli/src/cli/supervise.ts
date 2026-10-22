// packages/cli/src/cli/supervise.ts — the factory supervise handler, moved out of index.ts (#2797)

import { existsSync, readFileSync } from 'node:fs';

import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, parseQueue, resolveIngestConfig } from '@on-par/factory-core';
import type { QueueDiagnostic } from '@on-par/factory-core';
import { createGithubQueue, createOctokitQueueClient, resolveQueueClaimSettleMs } from '@on-par/factory-core/internal';

import type {
  CliDeps,
  CliExitError,
  UsageKnobs,
  createIngestHook,
  createSuperviseRunQueue,
  resolveUsageKnobs,
  superviseLoop,
  withRepoRunLock,
} from './index.js';

export interface SuperviseOptions {
  now?: boolean;
  localQueue?: boolean;
  autoMerge?: boolean;
  usageWatch?: boolean;
  usageThreshold?: string;
  usagePoll?: string;
  branchPrefix?: string;
  notify?: string;
}

/** index.ts's helpers for `factory supervise`, built at call time so main() deps injection reaches the handler. */
export interface SuperviseRuntime {
  configLoaders: Required<Pick<CliDeps, 'loadFactoryConfigForRepo' | 'loadRepoConfig'>>;
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  branchPrefixOrExit: (raw: string | undefined) => string;
  warnQueueDiagnostics: (diagnostics: QueueDiagnostic[]) => void;
  resolveUsageKnobs: typeof resolveUsageKnobs;
  usageFlagOverrides: (opts: SuperviseOptions, threshold: 'resumeAt') => Parameters<typeof resolveUsageKnobs>[2];
  withRepoRunLock: typeof withRepoRunLock;
  superviseLoop: typeof superviseLoop;
  createSuperviseRunQueue: typeof createSuperviseRunQueue;
  createIngestHook: typeof createIngestHook;
  cmdRun: (opts: Omit<SuperviseOptions, 'now'>) => Promise<void>;
  CliExitError: typeof CliExitError;
  /** Resolves the repo config file's display path, so messages name the file actually loaded (#2570). */
  repoConfigFileFor: (repoRoot: string, absPath: string) => { absPath: string; relPath: string };
}

export async function cmdSupervise(opts: SuperviseOptions, rt: SuperviseRuntime): Promise<void> {
  const branchPrefix = rt.branchPrefixOrExit(opts.branchPrefix);
  const repoRoot = await rt.getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
  const ingestCfg = resolveIngestConfig(factoryConfig);

  const countPending = async (): Promise<number> => {
    if (opts.localQueue === true) {
      const content = existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : '';
      const parsed = parseQueue(content);
      rt.warnQueueDiagnostics(parsed.diagnostics);
      return parsed.entries.length;
    }
    const [owner, repo] = (await rt.getGitHubRepo()).split('/');
    const gq = createGithubQueue({
      client: createOctokitQueueClient(rt.getOctokit()),
      owner,
      repo,
      claimSettleMs: resolveQueueClaimSettleMs(factoryConfig),
    });
    const lanes = await gq.lanes();
    const counts = await Promise.all(lanes.map((lane) => gq.list(lane)));
    return counts.reduce((total, issues) => total + issues.length, 0);
  };

  if ((await countPending()) === 0 && !ingestCfg.enabled) {
    throw new rt.CliExitError('queue empty — run factory init + triage first', 2);
  }

  let knobs: UsageKnobs;
  try {
    knobs = rt.resolveUsageKnobs(
      process.env,
      rt.configLoaders.loadRepoConfig(repoRoot),
      rt.usageFlagOverrides(opts, 'resumeAt'),
    );
  } catch (err: any) {
    throw new rt.CliExitError(`factory: ${err.message}`, 2);
  }

  await rt.withRepoRunLock(paths, 'factory supervise', () =>
    rt.superviseLoop({
      repoConfigLabel: rt.repoConfigFileFor(repoRoot, paths.config).relPath,
      cap: knobs.cap,
      resumeAt: knobs.resumeAt,
      pollMs: knobs.pollMs,
      watch: knobs.watch,
      watchSource: knobs.watchSource,
      resumeAtSource: knobs.resumeAtSource,
      pollSource: knobs.pollSource,
      estimator: knobs.estimator,
      stopFile: paths.stop,
      eventsFile: paths.events,
      now: opts.now,
      runQueue: rt.createSuperviseRunQueue(paths, ingestCfg, {
        cmdRunFn: () =>
          rt.cmdRun({
            localQueue: opts.localQueue,
            autoMerge: opts.autoMerge,
            usageWatch: opts.usageWatch,
            usageThreshold: opts.usageThreshold,
            usagePoll: opts.usagePoll,
            branchPrefix: opts.branchPrefix,
            notify: opts.notify,
          }),
        pendingCount: countPending,
      }),
      ingest: ingestCfg.enabled ? rt.createIngestHook(repoRoot, paths, ingestCfg, { branchPrefix }) : undefined,
    }),
  );
}
