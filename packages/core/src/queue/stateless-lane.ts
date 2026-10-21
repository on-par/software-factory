// packages/core/src/queue/stateless-lane.ts — Lane-labelled open issues with no queue state label (#3426).

import {
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  PARKED_LABEL,
  QUEUED_LABEL,
  type QueueGitHubClient,
  type QueueIssue,
} from './github-queue.js';
import { LABEL_LIST_MAX_PAGES, type LabelListClient } from './label-cache.js';

/** One open issue routed to a lane but carrying none of the queue state labels. */
export interface StatelessLaneIssue {
  issue: number;
  /** Lane slugs from its factory:lane:* labels, sorted. */
  lanes: string[];
  /** Every label on the issue, as read. */
  labels: string[];
  title?: string;
}

/** The labels that put an issue in a queue state. */
export const QUEUE_STATE_LABELS = [QUEUED_LABEL, PARKED_LABEL, IN_PROGRESS_LABEL] as const;

function isLaneLabel(name: string): boolean {
  return name.startsWith(LANE_LABEL_PREFIX) && name.length > LANE_LABEL_PREFIX.length;
}

/** Open issues that name a lane but hold none of factory:queued, factory:parked or factory:in-progress. */
export function findStatelessLaneIssues(issues: readonly QueueIssue[]): StatelessLaneIssue[] {
  const found: StatelessLaneIssue[] = [];
  for (const issue of issues) {
    const lanes = issue.labels
      .filter(isLaneLabel)
      .map((name) => name.slice(LANE_LABEL_PREFIX.length))
      .sort();
    if (lanes.length === 0) continue;
    if (QUEUE_STATE_LABELS.some((state) => issue.labels.includes(state))) continue;
    found.push({
      issue: issue.number,
      lanes,
      labels: issue.labels,
      ...(issue.title ? { title: issue.title } : {}),
    });
  }
  return found.sort((a, b) => a.issue - b.issue);
}

/** The repo's factory:lane:* label names. Unlike knownRepoLabels, a failed read throws. */
export async function listRepoLaneLabels(client: LabelListClient, owner: string, repo: string): Promise<string[]> {
  const list = client.rest.issues.listLabelsForRepo;
  if (!list) throw new Error('label listing unavailable');
  const names = new Set<string>();
  for (let page = 1; page <= LABEL_LIST_MAX_PAGES; page++) {
    const { data } = await list.call(client.rest.issues, { owner, repo, per_page: 100, page });
    for (const label of data) if (isLaneLabel(label.name)) names.add(label.name);
    if (data.length < 100) break;
  }
  return [...names].sort();
}

/** Lists open issues once per repo lane label, dedupes them, and returns those with no state label. */
export async function listStatelessLaneIssues(opts: {
  client: Pick<QueueGitHubClient, 'listOpenIssuesWithLabels'>;
  labelClient: LabelListClient;
  owner: string;
  repo: string;
}): Promise<StatelessLaneIssue[]> {
  const { client, labelClient, owner, repo } = opts;
  const labels = await listRepoLaneLabels(labelClient, owner, repo);
  const byNumber = new Map<number, QueueIssue>();
  for (const label of labels) {
    for (const issue of await client.listOpenIssuesWithLabels({ owner, repo, labels: [label] })) {
      if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
    }
  }
  return findStatelessLaneIssues([...byNumber.values()]);
}
