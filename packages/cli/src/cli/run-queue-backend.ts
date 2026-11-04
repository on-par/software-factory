// packages/cli/src/cli/run-queue-backend.ts — the memoized GitHub QueueBackend factory for `factory run` (#3920).

import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import type { FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import { resolveMergePolicy, resolveSizeGateMode } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';
import {
  createOctokitQueueClient,
  createQueueBackend,
  logEvent,
  resolveQueueClaimSettleMs,
  withAdmissionGuard,
} from '@on-par/factory-core/internal';

import { admissionStateReaderFor } from './admission.js';
import type { createQueuePreflightOps, preflightQueuedIssue } from './index.js';
import { laneFileHoldLookup } from './lane-file-hold.js';
import { reportQueueOrderConflict } from './run-order-conflict.js';
import type { createDeferralTracker } from './queue-startup.js';

export interface RunQueueBackendInput {
  ghRepo: string;
  paths: ReturnType<typeof getFactoryPaths>;
  factoryConfig: FactoryConfig;
  getOctokit: () => Octokit;
  preflightQueuedIssue: typeof preflightQueuedIssue;
  createQueuePreflightOps: typeof createQueuePreflightOps;
  autoMerge: boolean | undefined;
  deferrals: ReturnType<typeof createDeferralTracker>;
}

/** A lazy, memoized GitHub QueueBackend: built on first call (so --local-queue never builds an octokit) and reused. */
export function createRunQueueBackend(input: RunQueueBackendInput): () => QueueBackend {
  let backend: QueueBackend | undefined;
  return () => {
    if (backend) return backend;
    const { ghRepo, paths, factoryConfig, deferrals } = input;
    const [owner, repo] = ghRepo.split('/');
    const octokit = input.getOctokit();
    backend = createQueueBackend({
      kind: 'github',
      github: {
        client: createOctokitQueueClient(octokit),
        owner,
        repo,
        claimSettleMs: resolveQueueClaimSettleMs(factoryConfig),
        preflight: withAdmissionGuard({
          reader: admissionStateReaderFor(paths.state),
          preflight: (issue) =>
            input.preflightQueuedIssue(
              issue,
              input.createQueuePreflightOps(octokit, owner, repo, {
                autoMergeStack:
                  resolveSizeGateMode(factoryConfig) === 'stack' &&
                  resolveMergePolicy(factoryConfig, process.env, { auto: input.autoMerge }).auto,
                stackMode: resolveSizeGateMode(factoryConfig) === 'stack',
                laneFileHold: laneFileHoldLookup(paths.laneFiles, ghRepo),
                onDeferred: deferrals.onDeferred,
              }),
            ),
          onConflict: (issue, verdict) => {
            const line = `#${issue} refused — ${verdict.reason} | repair: ${verdict.repair}`;
            console.error(styleText('yellow', `factory: ${line}`));
            logEvent(paths.events, 'queue_admission_conflict', String(issue), line);
          },
        }),
        onOrderConflict: (conflict) => reportQueueOrderConflict(paths.events, conflict),
      },
    });
    return backend;
  };
}
