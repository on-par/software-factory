import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { EventKind } from '@on-par/factory-core';
import { baseChecksVerdict } from './base-health-ci.js';
import { createMergeBaseGate } from './merge-base-gate.js';

export function landBaseGate(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  state: string;
  checks?: readonly string[];
  log: (kind: EventKind, message: string) => void;
}) {
  const { octokit, owner, repo, prNumber } = opts;
  let branch = 'main';
  const gate = createMergeBaseGate({
    file: join(opts.state, 'merge-base-health.json'),
    repo: `${owner}/${repo}`,
    log: opts.log,
    head: async () => {
      const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      branch = pr.data.base.ref;
      const result = await octokit.rest.repos.getBranch({ owner, repo, branch });
      return result.data.commit.sha;
    },
    verdict: (sha) => baseChecksVerdict(octokit, owner, repo, { checks: opts.checks, branch })(sha),
    descends: async (merge, head) => {
      const result = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${merge}...${head}`,
      });
      return result.data.status === 'ahead' || result.data.status === 'identical';
    },
  });
  return {
    check: gate.check,
    record: async () => {
      const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (!pr.data.merge_commit_sha) throw new Error('merged PR has no merge commit SHA');
      gate.record(pr.data.merge_commit_sha);
    },
  };
}
