// packages/core/src/queue/iterate-command.ts — a trusted `/factory iterate` comment on an open factory PR queues its issue for a CHECK/rework run on the PR branch, once per comment id (#3625, ADR-0128 trust).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { factoryBranchIssue } from '../utils/index.js';
import { isTrustedApprover, type CollaboratorPermissionClient } from './approval.js';
import { IN_PROGRESS_LABEL, LANE_LABEL_PREFIX, PARKED_LABEL, type QueueGitHubClient } from './github-queue.js';
import { createEnqueuers } from './github-queue-enqueue.js';

export type FactoryCommand = 'iterate';

/** The command a comment carries: its first non-blank line must be exactly `/factory iterate` (case-insensitive). */
export function parseFactoryCommand(body: string): FactoryCommand | null {
  const first = body.split(/\r?\n/).find((line) => line.trim() !== '');
  if (first === undefined) return null;
  return first.trim().toLowerCase() === '/factory iterate' ? 'iterate' : null;
}

export type IterateOutcome = 'queued' | 'rejected' | 'ignored';

export interface IterateCommandRecord {
  commentId: number;
  pr: number;
  issue: number;
  lane?: string;
  actor: string;
  seenAt: string;
  outcome: IterateOutcome;
  detail?: string;
  /** Set when a lane claimed the record for an iterate run. */
  startedAt?: string;
}

export interface IterateCommandStore {
  has(commentId: number): boolean;
  record(entry: IterateCommandRecord): void;
  list(): IterateCommandRecord[];
  /** Stamp `startedAt` on a record; an unknown id does nothing. */
  markStarted(commentId: number, at: string): void;
}

export interface IteratePull {
  number: number;
  headRef: string;
  /** `owner/repo` of the head; undefined when unknown (deleted fork). */
  headRepo?: string;
}

export interface IterateComment {
  id: number;
  body: string;
  login: string;
  createdAt: string;
}

export interface IterateCommandGitHub {
  listOpenPulls(): Promise<IteratePull[]>;
  /** PR conversation comments, ascending id. */
  listComments(pr: number): Promise<IterateComment[]>;
  postComment(pr: number, body: string): Promise<void>;
}

export interface PollIterateOptions {
  github: IterateCommandGitHub;
  queue: QueueGitHubClient;
  owner: string;
  repo: string;
  branchPrefix?: string;
  trustedApprovers?: readonly string[];
  permissions: CollaboratorPermissionClient;
  store: IterateCommandStore;
  now?: () => Date;
}

export interface IteratePollResult {
  pr: number;
  issue: number;
  commentId: number;
  outcome: 'queued' | 'already-queued' | 'rejected' | 'error';
  actor?: string;
  lane?: string;
  detail?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function pollPull(opts: PollIterateOptions, pull: IteratePull, issue: number): Promise<IteratePollResult | null> {
  const { github, queue, owner, repo, store } = opts;
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const pending = (await github.listComments(pull.number)).filter(
    (c) => parseFactoryCommand(c.body) === 'iterate' && !store.has(c.id),
  );
  const trusted: IterateComment[] = [];
  for (const comment of pending) {
    const ok = await isTrustedApprover(comment.login, {
      owner,
      repo,
      trustedApprovers: opts.trustedApprovers,
      client: opts.permissions,
    });
    if (ok) trusted.push(comment);
    else
      store.record({
        commentId: comment.id,
        pr: pull.number,
        issue,
        actor: comment.login,
        seenAt: now,
        outcome: 'ignored',
      });
  }
  const newest = trusted.reduce<IterateComment | undefined>(
    (a, c) => (a === undefined || c.id > a.id ? c : a),
    undefined,
  );
  if (newest === undefined) return null;
  const recordAll = (outcome: IterateOutcome, lane?: string, detail?: string): void => {
    for (const c of trusted) {
      store.record({ commentId: c.id, pr: pull.number, issue, lane, actor: c.login, seenAt: now, outcome, detail });
    }
  };
  const result = (outcome: IteratePollResult['outcome'], lane?: string, detail?: string): IteratePollResult => ({
    pr: pull.number,
    issue,
    commentId: newest.id,
    outcome,
    actor: newest.login,
    lane,
    detail,
  });
  const reject = async (receipt: string, detail: string): Promise<IteratePollResult> => {
    await github.postComment(pull.number, `Factory iterate: rejected — ${receipt}`);
    recordAll('rejected', undefined, detail);
    return result('rejected', undefined, detail);
  };

  const labels = await queue.getIssueLabels({ owner, repo, issue_number: issue });
  if (labels.includes(IN_PROGRESS_LABEL)) {
    return reject(
      `a run is already in progress on #${issue}. No second claim was made. Comment again after it finishes.`,
      'in-progress',
    );
  }
  const lanes = labels.filter((l) => l.startsWith(LANE_LABEL_PREFIX)).map((l) => l.slice(LANE_LABEL_PREFIX.length));
  if (lanes.length === 0) return reject(`#${issue} has no lane label.`, 'no lane label');
  if (lanes.length > 1) {
    const detail = `several lane labels: ${lanes.join(', ')}`;
    return reject(`#${issue} has ${detail}.`, detail);
  }
  const lane = lanes[0] ?? '';
  if (labels.includes(PARKED_LABEL)) await queue.removeLabel({ owner, repo, issue_number: issue, name: PARKED_LABEL });

  const [res] = await createEnqueuers(queue, owner, repo).enqueue(lane, [issue]);
  if (res === undefined || res.outcome === 'failed') {
    return result('error', lane, res?.detail ?? 'enqueue returned nothing');
  }
  recordAll('queued', lane);
  await github.postComment(
    pull.number,
    `Factory iterate: queued #${issue} on lane '${lane}'. The next run re-runs CHECK and rework on \`${pull.headRef}\` and pushes to this PR. No new PR is opened.`,
  );
  return result(res.outcome, lane);
}

export async function pollIterateCommands(opts: PollIterateOptions): Promise<IteratePollResult[]> {
  const results: IteratePollResult[] = [];
  const pulls = await opts.github.listOpenPulls();
  for (const pull of pulls) {
    const issue = factoryBranchIssue(pull.headRef, opts.branchPrefix);
    if (issue === null || pull.headRepo !== `${opts.owner}/${opts.repo}`) continue;
    try {
      const result = await pollPull(opts, pull, issue);
      if (result) results.push(result);
    } catch (err) {
      results.push({ pr: pull.number, issue, commentId: 0, outcome: 'error', detail: errorMessage(err) });
    }
  }
  return results;
}

export function createOctokitIterateGitHub(octokit: Octokit, owner: string, repo: string): IterateCommandGitHub {
  return {
    async listOpenPulls() {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
      return pulls.map((p) => ({ number: p.number, headRef: p.head.ref, headRepo: p.head.repo?.full_name }));
    },
    async listComments(pr) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pr,
        per_page: 100,
      });
      return comments
        .map((c) => ({ id: c.id, body: c.body ?? '', login: c.user?.login ?? '', createdAt: c.created_at }))
        .sort((a, b) => a.id - b.id);
    },
    async postComment(pr, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: pr, body });
    },
  };
}

export function createFileIterateStore(file: string): IterateCommandStore {
  let entries: Map<number, IterateCommandRecord> | null = null;
  const load = (): Map<number, IterateCommandRecord> => {
    if (entries) return entries;
    entries = new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const list = typeof parsed === 'object' && parsed !== null && 'commands' in parsed ? parsed.commands : undefined;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isRecord(item)) entries.set(item.commentId, item);
        }
      }
    } catch {
      // missing file or bad JSON reads as empty
    }
    return entries;
  };
  const persist = (map: Map<number, IterateCommandRecord>): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ commands: [...map.values()] }, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  return {
    has: (commentId) => load().has(commentId),
    list: () => [...load().values()],
    record(entry) {
      const map = load();
      map.set(entry.commentId, entry);
      persist(map);
    },
    markStarted(commentId, at) {
      const map = load();
      const entry = map.get(commentId);
      if (!entry) return;
      map.set(commentId, { ...entry, startedAt: at });
      persist(map);
    },
  };
}

/** Claim the newest pending queued record for the issue (by seenAt, then commentId); older pending ones are coalesced (stamped too). */
export function claimIterateCommand(
  store: IterateCommandStore,
  issue: number,
  now: () => Date = () => new Date(),
): IterateCommandRecord | undefined {
  const pending = store.list().filter((r) => r.issue === issue && r.outcome === 'queued' && !r.startedAt);
  pending.sort((a, b) => (a.seenAt === b.seenAt ? b.commentId - a.commentId : a.seenAt < b.seenAt ? 1 : -1));
  const picked = pending[0];
  if (!picked) return undefined;
  const startedAt = now().toISOString();
  for (const r of pending) store.markStarted(r.commentId, startedAt);
  return { ...picked, startedAt };
}

function isRecord(value: unknown): value is IterateCommandRecord {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'commentId' in value &&
    typeof value.commentId === 'number' &&
    'pr' in value &&
    typeof value.pr === 'number' &&
    'issue' in value &&
    typeof value.issue === 'number' &&
    'actor' in value &&
    typeof value.actor === 'string' &&
    'seenAt' in value &&
    typeof value.seenAt === 'string' &&
    'outcome' in value &&
    (value.outcome === 'queued' || value.outcome === 'rejected' || value.outcome === 'ignored')
  );
}
