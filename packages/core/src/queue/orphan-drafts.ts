// packages/core/src/queue/orphan-drafts.ts — hourly sweep: close stale orphan factory drafts and requeue their issues at the front of the lane (#3552).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { resolveBranchPrefix } from '../config/index.js';
import type { EventKind } from '../events/kinds.js';
import { factoryBranchIssue } from '../utils/index.js';
import type { OpenPrDraftSummary } from '../utils/open-factory-drafts.js';
import {
  CLAIMED_BY_LABEL_PREFIX,
  createGithubQueue,
  IN_PROGRESS_LABEL,
  LANE_LABEL_PREFIX,
  PARKED_LABEL,
  type QueueGitHubClient,
} from './github-queue.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';

export const ORPHAN_DRAFT_MIN_AGE_MS = 24 * 3_600_000;
export const ORPHAN_DRAFT_SWEEP_INTERVAL_MS = 3_600_000;
export const ORPHAN_DRAFT_SWEEP_CAP = 10;

const HOUR_MS = 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const COMMENT_MARKER = '<!-- factory:orphan-draft-sweep -->';

export interface StaleFactoryDraft {
  pr: number;
  issue: number;
  branch: string;
  ageHours: number;
}

export type OrphanDraftSkipReason =
  'claimed' | 'issue-closed' | 'no-lane' | 'multiple-lanes' | 'requeue-failed' | 'close-failed';

export interface OrphanDraftSweepReport {
  throttled: boolean;
  closed: Array<{ pr: number; issue: number; lane: string; order: number }>;
  skipped: Array<{ pr: number; issue: number; reason: OrphanDraftSkipReason }>;
  /** PR numbers that qualify but exceeded the per-sweep cap. */
  deferred: number[];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Open factory drafts on `<prefix>/<n>-…` older than `minAgeMs`, oldest first. An unparsable date is not stale. */
export function selectStaleFactoryDrafts(
  prs: ReadonlyArray<OpenPrDraftSummary & { number: number }>,
  opts: { prefix: string; now: number; minAgeMs?: number },
): StaleFactoryDraft[] {
  const minAge = opts.minAgeMs ?? ORPHAN_DRAFT_MIN_AGE_MS;
  const found: Array<{ created: number; draft: StaleFactoryDraft }> = [];
  for (const pr of prs) {
    if (!pr.draft || !pr.branch.startsWith(`${opts.prefix}/`)) continue;
    const issue = factoryBranchIssue(pr.branch, opts.prefix);
    const created = Date.parse(pr.createdAt);
    if (issue === null || !Number.isFinite(created) || opts.now - created <= minAge) continue;
    const ageHours = Math.floor((opts.now - created) / HOUR_MS);
    found.push({ created, draft: { pr: pr.number, issue, branch: pr.branch, ageHours } });
  }
  return found.sort((a, b) => a.created - b.created || a.draft.pr - b.draft.pr).map((f) => f.draft);
}

export function renderOrphanDraftComment(input: {
  issue: number;
  branch: string;
  lane: string;
  ageHours: number;
}): string {
  return (
    `The factory's orphan-draft sweep closed this draft: it is older than 24h (${input.ageHours}h) and #${input.issue} ` +
    `has no \`factory:in-progress\` or \`factory:claimed-by\` label. #${input.issue} is requeued at the front of lane ` +
    `\`${input.lane}\`; branch \`${input.branch}\` is kept so the work can be resumed or reopened.\n\n${COMMENT_MARKER}`
  );
}

async function isDue(stateFile: string, now: number): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
    const raw =
      parsed !== null && typeof parsed === 'object' ? (parsed as { lastSweepAt?: unknown }).lastSweepAt : undefined;
    const last = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    return !Number.isFinite(last) || now - last >= ORPHAN_DRAFT_SWEEP_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function listOpenPrs(
  octokit: Pick<Octokit, 'rest'>,
  owner: string,
  repo: string,
): Promise<Array<OpenPrDraftSummary & { number: number }>> {
  const all: Array<OpenPrDraftSummary & { number: number }> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: PAGE_SIZE, page });
    for (const pr of data) {
      all.push({
        number: pr.number,
        branch: pr.head?.ref ?? '',
        draft: Boolean(pr.draft),
        createdAt: pr.created_at ?? '',
      });
    }
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

export async function sweepOrphanDrafts(
  input: { owner: string; repo: string; stateFile: string; prefix?: string; now?: () => number; cap?: number },
  ports: {
    octokit: Pick<Octokit, 'rest'>;
    client: QueueGitHubClient;
    log: (type: EventKind, scope: string | number, msg: string) => void;
  },
): Promise<OrphanDraftSweepReport> {
  const { owner, repo, stateFile } = input;
  const { octokit, client, log } = ports;
  const cap = input.cap ?? ORPHAN_DRAFT_SWEEP_CAP;
  const now = (input.now ?? Date.now)();
  const report: OrphanDraftSweepReport = { throttled: false, closed: [], skipped: [], deferred: [] };

  if (!(await isDue(stateFile, now))) return { ...report, throttled: true };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastSweepAt: new Date(now).toISOString() }));

  const prs = await listOpenPrs(octokit, owner, repo);
  const candidates = selectStaleFactoryDrafts(prs, { prefix: input.prefix ?? resolveBranchPrefix(), now });
  const queue = createGithubQueue({ client, owner, repo });
  const requeued = new Map<number, { lane: string; order: number }>();

  for (const draft of candidates) {
    const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: draft.issue });
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const skip = (reason: OrphanDraftSkipReason): void => {
      report.skipped.push({ pr: draft.pr, issue: draft.issue, reason });
    };
    if (issue.state !== 'open') {
      skip('issue-closed');
      continue;
    }
    if (labels.some((l) => l === IN_PROGRESS_LABEL || l.startsWith(CLAIMED_BY_LABEL_PREFIX))) {
      skip('claimed');
      continue;
    }
    const lanes = labels.filter((l) => l.startsWith(LANE_LABEL_PREFIX));
    if (lanes.length !== 1) {
      skip(lanes.length === 0 ? 'no-lane' : 'multiple-lanes');
      continue;
    }
    if (report.closed.length >= cap) {
      report.deferred.push(draft.pr);
      continue;
    }
    const lane = (lanes[0] ?? '').slice(LANE_LABEL_PREFIX.length);

    let placed = requeued.get(draft.issue);
    if (!placed) {
      try {
        for (const label of labels.filter((l) => l.startsWith(QUEUE_ORDER_LABEL_PREFIX))) {
          await client.removeLabel({ owner, repo, issue_number: draft.issue, name: label });
        }
        const { results } = await queue.enqueueFront(lane, [draft.issue]);
        const result = results[0];
        if (result?.outcome !== 'queued' || result.position === undefined) {
          throw new Error(result?.detail ?? `enqueue outcome ${result?.outcome ?? 'none'}`);
        }
        if (labels.includes(PARKED_LABEL)) {
          await client.removeLabel({ owner, repo, issue_number: draft.issue, name: PARKED_LABEL });
        }
        placed = { lane, order: result.position };
        requeued.set(draft.issue, placed);
      } catch (err) {
        log('warn', draft.issue, `orphan draft sweep could not requeue #${draft.issue}: ${errorMessage(err)}`);
        skip('requeue-failed');
        continue;
      }
    }

    try {
      await octokit.rest.pulls.update({ owner, repo, pull_number: draft.pr, state: 'closed' });
    } catch (err) {
      log('warn', draft.issue, `orphan draft sweep could not close PR #${draft.pr}: ${errorMessage(err)}`);
      skip('close-failed');
      continue;
    }
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: draft.pr,
        body: renderOrphanDraftComment({ issue: draft.issue, branch: draft.branch, lane, ageHours: draft.ageHours }),
      });
    } catch (err) {
      log('warn', draft.issue, `orphan draft sweep could not comment on PR #${draft.pr}: ${errorMessage(err)}`);
    }
    report.closed.push({ pr: draft.pr, issue: draft.issue, lane, order: placed.order });
    log(
      'orphan_draft_closed',
      draft.issue,
      `closed orphan draft PR #${draft.pr} (${draft.ageHours}h old, no active claim); #${draft.issue} requeued at the front of lane ${lane}`,
    );
  }

  if (report.deferred.length > 0) {
    log(
      'orphan_draft_sweep_capped',
      'all',
      `orphan draft sweep closed ${report.closed.length} PR(s); ${report.deferred.length} more qualify and are left for the next sweep: ${report.deferred.map((n) => `#${n}`).join(', ')}`,
    );
  }
  return report;
}
