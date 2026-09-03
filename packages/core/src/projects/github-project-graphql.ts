// packages/core/src/projects/github-project-graphql.ts
// gh-authenticated ProjectV2 queue GraphQL client + live daemon-ready poller (#1046).

import type { Octokit } from '@octokit/rest';
import type { FactoryLogger } from '../logger/index.js';
import type { QueueRationaleCommentClient } from '../queue/reprioritization-audit.js';
import { createProjectQueueReader } from './project-queue-reader.js';
import type { ProjectQueueStatus } from './project-queue-reader.js';
import { createProjectQueuePoller } from './project-queue-poller.js';
import type { ProjectQueuePoller } from './project-queue-poller.js';

/** The injected GraphQL port shape the ProjectV2 reader/pollers require. */
export type ProjectGraphqlClient = (
  query: string,
  variables: { projectId: string; cursor: string | null },
) => Promise<unknown>;

/** Adapts a gh-authenticated Octokit into the injected GraphQL port. The caller supplies the
 *  already-authenticated Octokit (the CLI's getOctokit() resolves `gh auth token`); core never
 *  resolves gh auth itself, matching createOctokitQueueClient / createOctokitFilingClient. */
export function createOctokitGraphqlClient(octokit: Pick<Octokit, 'graphql'>): ProjectGraphqlClient {
  return (query, variables) => octokit.graphql(query, variables) as Promise<unknown>;
}

/** Adapts a gh-authenticated Octokit into the injected rationale comment port, binding
 *  owner/repo (the record carries only the issue number). Mirrors the existing
 *  `octokit.rest.issues.createComment` call in `readiness/decompose.ts`. */
export function createOctokitReprioritizationCommentClient(
  octokit: Pick<Octokit, 'rest'>,
  ctx: { owner: string; repo: string },
): QueueRationaleCommentClient {
  return {
    async commentOnIssue({ issueNumber, body }) {
      await octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: issueNumber,
        body,
      });
    },
  };
}

export interface GithubProjectQueuePollerOptions {
  readonly octokit: Pick<Octokit, 'graphql'>;
  readonly projectId: string;
  readonly laneFieldName: string;
  readonly orderFieldName: string;
  readonly statusFieldName: string;
  readonly statusValues: Readonly<Record<string, ProjectQueueStatus>>;
  readonly logger: FactoryLogger;
  readonly pollMs?: number;
  readonly commentClient?: QueueRationaleCommentClient;
}

/** Assembles a live, gh-authenticated daemon-ready ProjectV2 queue poller by wiring the
 *  Octokit GraphQL adapter through the existing reader (#866) and poller (#866). */
export function createGithubProjectQueuePoller(options: GithubProjectQueuePollerOptions): ProjectQueuePoller {
  const graphql = createOctokitGraphqlClient(options.octokit);
  const reader = createProjectQueueReader({
    projectId: options.projectId,
    graphql,
    laneFieldName: options.laneFieldName,
    orderFieldName: options.orderFieldName,
    statusFieldName: options.statusFieldName,
    statusValues: options.statusValues,
  });
  return createProjectQueuePoller({
    reader,
    logger: options.logger,
    pollMs: options.pollMs,
    commentClient: options.commentClient,
  });
}
