// src/kpis/human.ts — Reconstruct explicit human-intervention events (#420)

import type { FactoryEvent, HumanEventType } from '../types/index.js';

export const HUMAN_EVENT_TYPES: ReadonlySet<string> = new Set<HumanEventType>([
  'human-approved',
  'human-edited',
  'human-restarted',
  'human-merged',
  'human-abandoned',
]);

export function isHumanEvent(event: FactoryEvent): boolean {
  return HUMAN_EVENT_TYPES.has(event.type);
}

export interface CommitSource {
  sha: string;
  /** GitHub login when available, else git author name. */
  author: string;
  /** Commit AUTHOR date ISO string (survives factory rebases; committer date does not). */
  ts: string;
}

export interface PrSource {
  issue: string; // numeric string parsed from the ship-it/<n>- branch
  prNumber: number;
  commits: CommitSource[];
  /** Approving reviews. */
  approvals: Array<{ actor: string; ts: string }>;
  mergedAt: string | null;
  /** merged_by login; null/undefined when unknown or not merged. */
  mergedBy?: string | null;
  /** closed_at when the PR was closed WITHOUT merge, else null. */
  closedAt: string | null;
}

// 'parked'/'stuck' are lane-lifecycle wrapper events (runLane, multi-issue queues);
// 'escalate'/'timeout'/'fail'/'conflict' are the ParkReason values a single-issue
// `factory ship <issue>` run logs directly (see ParkReason/parkReasonFor in cli/index.ts).
// Both sets are checked so a retry is detected regardless of which path produced the park.
const PARK_ISH_TYPES = new Set(['parked', 'stuck', 'fail', 'escalate', 'timeout', 'conflict']);

export function reconstructHumanEvents(sources: PrSource[], logEvents: FactoryEvent[]): FactoryEvent[] {
  const eventsByIssue = new Map<string, FactoryEvent[]>();
  for (const event of logEvents) {
    const list = eventsByIssue.get(event.issue);
    if (list) {
      list.push(event);
    } else {
      eventsByIssue.set(event.issue, [event]);
    }
  }

  const existingKeys = new Set(logEvents.map((e) => `${e.type} ${e.issue} ${e.msg}`));

  const reconstructed: FactoryEvent[] = [];

  for (const source of sources) {
    if (!/^\d+$/.test(source.issue)) continue;

    const issueEvents = eventsByIssue.get(source.issue) ?? [];
    let factoryWindowEnd: number | null = null;
    let factoryMerged = false;
    for (const event of issueEvents) {
      if (event.type === 'merged') factoryMerged = true;
      if (event.phase) {
        const ts = Date.parse(event.ts);
        if (!Number.isNaN(ts) && (factoryWindowEnd === null || ts > factoryWindowEnd)) {
          factoryWindowEnd = ts;
        }
      }
    }

    if (factoryWindowEnd !== null) {
      for (const commit of source.commits) {
        const commitTs = Date.parse(commit.ts);
        if (!Number.isNaN(commitTs) && commitTs > factoryWindowEnd) {
          reconstructed.push({
            ts: commit.ts,
            type: 'human-edited',
            issue: source.issue,
            actor: commit.author,
            msg: `commit ${commit.sha.slice(0, 7)} pushed after factory work ended`,
          });
        }
      }
    }

    if (source.mergedAt !== null && !factoryMerged) {
      reconstructed.push({
        ts: source.mergedAt,
        type: 'human-merged',
        issue: source.issue,
        actor: source.mergedBy ?? 'unknown',
        msg: `PR #${source.prNumber} merged by a human, not the factory`,
      });
    }

    for (const approval of source.approvals) {
      reconstructed.push({
        ts: approval.ts,
        type: 'human-approved',
        issue: source.issue,
        actor: approval.actor,
        msg: `PR #${source.prNumber} review approved`,
      });
    }

    if (source.closedAt !== null) {
      reconstructed.push({
        ts: source.closedAt,
        type: 'human-abandoned',
        issue: source.issue,
        actor: 'unknown',
        msg: `PR #${source.prNumber} closed without merge`,
      });
    }
  }

  return reconstructed.filter((event) => !existingKeys.has(`${event.type} ${event.issue} ${event.msg}`));
}

export function hasUnresolvedPark(events: FactoryEvent[], issue: string): boolean {
  let lastParkTs: number | null = null;
  let lastMergedTs: number | null = null;

  for (const event of events) {
    if (event.issue !== issue) continue;
    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts)) continue;
    if (PARK_ISH_TYPES.has(event.type)) {
      if (lastParkTs === null || ts > lastParkTs) lastParkTs = ts;
    }
    if (event.type === 'merged') {
      if (lastMergedTs === null || ts > lastMergedTs) lastMergedTs = ts;
    }
  }

  if (lastParkTs === null) return false;
  return lastMergedTs === null || lastMergedTs < lastParkTs;
}

export interface HumanSourceClient {
  rest: {
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: 'all';
        per_page: number;
        page: number;
        sort: 'updated';
        direction: 'desc';
      }): Promise<{ data: any[] }>;
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{ data: any }>;
      listCommits(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
      }): Promise<{ data: any[] }>;
      listReviews(params: { owner: string; repo: string; pull_number: number; per_page: number }): Promise<{
        data: any[];
      }>;
    };
  };
}

export async function fetchHumanEventSources(
  client: HumanSourceClient,
  owner: string,
  repo: string,
  issues: ReadonlySet<string>,
): Promise<PrSource[]> {
  const prs: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await client.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      per_page: 100,
      page,
      sort: 'updated',
      direction: 'desc',
    });
    prs.push(...data);
    if (data.length < 100) break;
  }

  const matched = prs
    .map((pr) => ({ pr, match: /^ship-it\/(\d+)-/.exec(pr.head?.ref ?? '') }))
    .filter(({ match }) => match !== null && issues.has(match[1]));

  return Promise.all(
    matched.map(async ({ pr, match }) => {
      const issue = match![1];

      const [{ data: commitsData }, { data: reviewsData }] = await Promise.all([
        client.rest.pulls.listCommits({ owner, repo, pull_number: pr.number, per_page: 100 }),
        client.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 100 }),
      ]);

      const commits: CommitSource[] = commitsData.map((c: any) => ({
        sha: c.sha,
        author: c.author?.login ?? c.commit?.author?.name ?? 'unknown',
        ts: c.commit.author.date,
      }));

      const approvals = reviewsData
        .filter((r: any) => r.state === 'APPROVED')
        .map((r: any) => ({ actor: r.user?.login ?? 'unknown', ts: r.submitted_at }));

      const mergedAt: string | null = pr.merged_at ?? null;
      let mergedBy: string | null | undefined;
      if (mergedAt !== null) {
        const { data: prDetail } = await client.rest.pulls.get({ owner, repo, pull_number: pr.number });
        mergedBy = prDetail.merged_by?.login;
      }
      const closedAt: string | null = pr.state === 'closed' && !pr.merged_at ? pr.closed_at : null;

      return {
        issue,
        prNumber: pr.number,
        commits,
        approvals,
        mergedAt,
        mergedBy,
        closedAt,
      };
    }),
  );
}
