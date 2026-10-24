// packages/cli/src/cli/awaiting-ci-wiring.ts — production RunLaneDeps for the awaiting-ci record and re-check (#3208)

import type { FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import { resolveMergePolicy } from '@on-par/factory-core';
import {
  awaitingCiFile,
  classifyHeadChecks,
  fetchRequiredContexts,
  listAllCheckRuns,
  resolveAwaitingCiCapMs,
  upsertAwaitingCi,
  warnNoBranchProtectionOnce,
} from '@on-par/factory-core/internal';
import type { Octokit } from '@octokit/rest';

import { recheckDueAwaitingCi, type AwaitingCiLaneOps } from './awaiting-ci-recheck.js';
import { squashMergeAndDelete } from './land-pr.js';
import type { RunLaneDeps } from './run-lane-deps.js';

/** Binds the awaiting-ci store, cap and GitHub lookups into the two RunLaneDeps that use them. */
export function awaitingCiLaneDeps(
  getOctokit: () => Octokit,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  config: FactoryConfig,
): Pick<RunLaneDeps, 'recordAwaitingCi' | 'recheckAwaitingCi'> {
  const file = awaitingCiFile(paths);
  const [owner, repo] = ghRepo.split('/');
  return {
    recordAwaitingCi: (rec) => upsertAwaitingCi(file, rec),
    recheckAwaitingCi: (ops: AwaitingCiLaneOps) => {
      const octokit = getOctokit();
      return recheckDueAwaitingCi({
        ...ops,
        file,
        now: () => Date.now(),
        capMs: resolveAwaitingCiCapMs(config),
        getPr: async (prNumber) => {
          const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
          return { state: data.state, merged: data.merged, headSha: data.head.sha, baseRef: data.base.ref };
        },
        verdict: async ({ headSha, baseRef }) => {
          const required = await fetchRequiredContexts(octokit, { owner, repo, branch: baseRef });
          const all = await listAllCheckRuns(octokit, owner, repo, headSha, 100, 10);
          const runs = all.map((r) => ({
            name: r.name ?? '',
            status: r.status ?? null,
            conclusion: r.conclusion ?? null,
          }));
          const v = classifyHeadChecks(required, runs);
          if (v.basis === 'all-on-head') {
            warnNoBranchProtectionOnce(ghRepo, baseRef, (m) => ops.emit('warn', 0, m));
          }
          return v;
        },
        merge: (rec, sha) =>
          squashMergeAndDelete(octokit, owner, repo, rec.branch, rec.prNumber, {
            admin: resolveMergePolicy(config).admin,
            sha,
          }),
      });
    },
  };
}
