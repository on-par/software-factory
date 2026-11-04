// packages/cli/src/cli/run-rework-poll.ts — one pass of the review-rework, `/factory rework` and `/factory iterate` polls a run's lanes share (#3563, #3625, #3882)

import type { Octokit } from '@octokit/rest';
import type { FactoryConfig } from '@on-par/factory-core';
import {
  createFileIterateStore,
  createFileReviewReworkStore,
  createOctokitCollaboratorPermissionClient,
  createOctokitIterateGitHub,
  createOctokitQueueClient,
  createOctokitReviewReworkGitHub,
  logEvent,
  parkPayload,
  pollCommentRework,
  pollIterateCommands,
  pollReviewRework,
  publishParkComment,
  resolveMaxReviewReworkRuns,
} from '@on-par/factory-core/internal';
import { workKeyFromIssue } from '@on-par/factory-core';

export interface ReworkPollDeps {
  octokit: Octokit;
  ghRepo: string;
  branchPrefix: string;
  factoryConfig: FactoryConfig;
  paths: { events: string; reviewRework: string; iterate: string };
}

export async function runReworkPolls(deps: ReworkPollDeps): Promise<void> {
  const { octokit, ghRepo, branchPrefix, factoryConfig, paths } = deps;
  const [owner = '', repo = ''] = ghRepo.split('/');
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
  const logReworkResults = (list: Awaited<ReturnType<typeof pollReviewRework>>): void => {
    for (const r of list) {
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
          parkPayload('escalate', workKeyFromIssue(r.issue), r.lane, []),
        );
      } else if (r.outcome === 'error') {
        logEvent(paths.events, 'warn', r.issue, `review-rework poll for PR #${r.pr} failed: ${r.detail}`);
      }
    }
  };
  logReworkResults(results);
  // #3882: `/factory rework` comments; a failure only warns so the review results above stand.
  try {
    logReworkResults(
      await pollCommentRework({
        github: createOctokitIterateGitHub(octokit, owner, repo),
        queue: createOctokitQueueClient(octokit),
        owner,
        repo,
        branchPrefix,
        trustedApprovers: factoryConfig.intake?.trustedApprovers,
        permissions: createOctokitCollaboratorPermissionClient(octokit),
        store: createFileReviewReworkStore(paths.reviewRework),
        maxRuns: resolveMaxReviewReworkRuns(factoryConfig),
        publishParkComment: (input) => publishParkComment({ octokit, repo: ghRepo, input }),
      }),
    );
  } catch (err) {
    logEvent(
      paths.events,
      'warn',
      0,
      `comment-rework poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
}
