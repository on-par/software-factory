// packages/cli/src/cli/run-queue.ts — the QueueBackend factory run hands its lanes: GitHub labels, or Linear when tracker.kind is linear (#3918)

import { styleText } from 'node:util';

import { resolveMergePolicy, resolveSizeGateMode, type FactoryConfig, type WorkKey } from '@on-par/factory-core';
import {
  createOctokitQueueClient,
  logEvent,
  resolveQueueClaimSettleMs,
  resolveQueueStackOnOpenPrerequisite,
  resolveTrackerConfig,
  withAdmissionGuard,
  type GithubQueueBackendOptions,
  type QueueBackend,
} from '@on-par/factory-core/internal';

import { admissionStateReaderFor } from './admission.js';
import type { getFactoryPaths } from '@on-par/factory-core';
import { laneFileHoldLookup } from './lane-file-hold.js';
import { selectQueueBackend } from './queue-backend-select.js';
import type { createDeferralTracker } from './queue-startup.js';
import { reportQueueOrderConflict } from './run-order-conflict.js';
import type { RunRuntime } from './run.js';

export function createRunQueue(input: {
  rt: Pick<RunRuntime, 'getOctokit' | 'preflightQueuedIssue' | 'createQueuePreflightOps'>;
  paths: ReturnType<typeof getFactoryPaths>;
  ghRepo: string;
  factoryConfig: FactoryConfig;
  autoMerge: boolean | undefined;
  deferrals: ReturnType<typeof createDeferralTracker>;
}): {
  queue: () => QueueBackend;
  /** Linear mode only: releases claims whose lease expired, in place of the GitHub reap. */
  startupLinearReap: () => Promise<void>;
  onUnshippable: (key: WorkKey) => void;
} {
  const { rt, paths, ghRepo, factoryConfig } = input;
  const githubQueueOptions = (): GithubQueueBackendOptions => {
    const [owner, repo] = ghRepo.split('/');
    const octokit = rt.getOctokit();
    return {
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
                resolveMergePolicy(factoryConfig, process.env, { auto: input.autoMerge }).auto,
              stackMode: resolveSizeGateMode(factoryConfig) === 'stack',
              stackOnOpenPrerequisite: resolveQueueStackOnOpenPrerequisite(factoryConfig),
              laneFileHold: laneFileHoldLookup(paths.laneFiles, ghRepo),
              onDeferred: input.deferrals.onDeferred,
            }),
          ),
        onConflict: (issue, verdict) => {
          const line = `#${issue} refused — ${verdict.reason} | repair: ${verdict.repair}`;
          console.error(styleText('yellow', `factory: ${line}`));
          logEvent(paths.events, 'queue_admission_conflict', String(issue), line);
        },
      }),
      onOrderConflict: (conflict) => reportQueueOrderConflict(paths.events, conflict),
    };
  };

  let selected: ReturnType<typeof selectQueueBackend> | undefined;
  const select = () =>
    (selected ??= selectQueueBackend({
      factoryConfig,
      ghRepo,
      env: process.env,
      github: githubQueueOptions,
      warn: (m) => logEvent(paths.events, 'warn', '-', m),
    }));

  return {
    queue: () => select().backend,
    startupLinearReap: async () => {
      if (resolveTrackerConfig(factoryConfig).kind !== 'linear') return;
      try {
        for (const row of await select().backend.reap()) {
          if (row.released && 'key' in row) {
            logEvent(paths.events, 'claim_expired_released', row.key, `released expired Linear claim ${row.key}`);
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logEvent(paths.events, 'warn', '-', `Linear claim reap failed: ${detail}`);
      }
    },
    onUnshippable: (key) =>
      logEvent(
        paths.events,
        'warn',
        key,
        `lane claimed Linear issue ${key}; lanes ship only GitHub issue numbers yet — released back to the queue`,
      ),
  };
}
