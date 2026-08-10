// src/kpis/defects.ts — Post-merge defect signals for merged factory PRs (#612)

import type { FactoryEvent } from '../types/index.js';
import type { PrSource } from './human.js';

export const DEFAULT_DEFECT_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A merged factory PR to watch for follow-up defect signals. */
export interface MergedPrRef {
  issue: string;
  prNumber: number;
  /** ISO merge timestamp; the window starts here. */
  mergedAt: string;
  mergeCommitSha: string | null;
}

export interface RepoCommitSource {
  sha: string;
  message: string;
  /** Commit AUTHOR date ISO string, matching CommitSource in human.ts. */
  ts: string;
}

export interface RepoIssueSource {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  /** True for pull requests, which the GitHub issues API also returns. */
  isPullRequest: boolean;
}

export interface PrCommentSource {
  prNumber: number;
  author: string;
  body: string;
  ts: string;
  isBot: boolean;
}

export interface DefectSources {
  mergedPrs: MergedPrRef[];
  commits: RepoCommitSource[];
  issues: RepoIssueSource[];
  comments: PrCommentSource[];
}

/** GitHub's revert commits open with `Revert "<original subject>"`. */
export const REVERT_SUBJECT_PATTERN = /^\s*revert[\s"']/i;

/** Closing-keyword back-reference, e.g. `Fixes #123`, `closes: #123`, `Resolved #123`. */
export const BACK_REFERENCE_PATTERN = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b\s*:?\s*#(\d+)/gi;

/** A post-merge comment only counts as a defect signal when it reads as a concern. */
export const CONCERN_PATTERN =
  /\b(?:broke|broken|breaks|regress(?:ion|ed|es)?|revert(?:ed|ing)?|bugs?|buggy|fail(?:s|ed|ing|ure)?|doesn'?t work|not working|reopen(?:ed|ing)?)\b/i;

function backReferencedNumbers(text: string): Set<number> {
  const pattern = new RegExp(BACK_REFERENCE_PATTERN.source, BACK_REFERENCE_PATTERN.flags);
  const numbers = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    numbers.add(Number(match[1]));
  }
  return numbers;
}

export function mergedPrRefs(sources: PrSource[]): MergedPrRef[] {
  return sources
    .filter((source) => source.mergedAt !== null && /^\d+$/.test(source.issue))
    .map((source) => ({
      issue: source.issue,
      prNumber: source.prNumber,
      mergedAt: source.mergedAt as string,
      mergeCommitSha: source.mergeCommitSha ?? null,
    }));
}

export function isDefectWindowClosed(mergedAt: string, now: string, windowDays: number): boolean {
  const merged = Date.parse(mergedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(merged) || Number.isNaN(nowMs)) return false;
  const end = merged + windowDays * DAY_MS;
  return end <= nowMs;
}

export function detectPostMergeDefects(
  sources: DefectSources,
  logEvents: FactoryEvent[],
  opts: { now: string; windowDays?: number },
): FactoryEvent[] {
  const windowDays = opts.windowDays ?? DEFAULT_DEFECT_WINDOW_DAYS;
  const existingKeys = new Set(logEvents.map((e) => `${e.type} ${e.issue} ${e.msg}`));
  const out: FactoryEvent[] = [];

  for (const pr of sources.mergedPrs) {
    if (!/^\d+$/.test(pr.issue)) continue;
    if (!isDefectWindowClosed(pr.mergedAt, opts.now, windowDays)) continue;

    const startMs = Date.parse(pr.mergedAt);
    const endMs = startMs + windowDays * DAY_MS;

    out.push({
      ts: new Date(endMs).toISOString(),
      type: 'defect-window-closed',
      issue: pr.issue,
      msg: `PR #${pr.prNumber} post-merge defect window closed (${windowDays}d)`,
    });

    const inWindow = (ts: string) => {
      const t = Date.parse(ts);
      return !Number.isNaN(t) && t > startMs && t <= endMs;
    };

    for (const commit of sources.commits) {
      if (!inWindow(commit.ts)) continue;
      if (!REVERT_SUBJECT_PATTERN.test(commit.message)) continue;
      const namesPr = commit.message.includes(`#${pr.prNumber}`);
      const quotesSha =
        pr.mergeCommitSha !== null &&
        commit.message.toLowerCase().includes(pr.mergeCommitSha.toLowerCase().slice(0, 7));
      if (!namesPr && !quotesSha) continue;
      out.push({
        ts: commit.ts,
        type: 'post-merge-defect',
        issue: pr.issue,
        msg: `revert commit ${commit.sha.slice(0, 7)} reverts PR #${pr.prNumber}`,
      });
    }

    for (const issue of sources.issues) {
      if (issue.isPullRequest) continue;
      if (issue.number === pr.prNumber) continue;
      if (!inWindow(issue.createdAt)) continue;
      const text = `${issue.title}\n${issue.body}`;
      const numbers = backReferencedNumbers(text);
      const referencesPr = numbers.has(pr.prNumber) || numbers.has(Number(pr.issue));
      const quotesSha =
        pr.mergeCommitSha !== null && text.toLowerCase().includes(pr.mergeCommitSha.toLowerCase().slice(0, 7));
      if (!referencesPr && !quotesSha) continue;
      out.push({
        ts: issue.createdAt,
        type: 'post-merge-defect',
        issue: pr.issue,
        msg: `issue #${issue.number} back-references PR #${pr.prNumber}`,
      });
    }

    for (const comment of sources.comments) {
      if (comment.prNumber !== pr.prNumber) continue;
      if (comment.isBot) continue;
      if (!inWindow(comment.ts)) continue;
      if (!CONCERN_PATTERN.test(comment.body)) continue;
      out.push({
        ts: comment.ts,
        type: 'post-merge-defect',
        issue: pr.issue,
        actor: comment.author,
        msg: `comment on PR #${pr.prNumber} raises a post-merge concern`,
      });
    }
  }

  const seen = new Set<string>();
  const deduped: FactoryEvent[] = [];
  for (const event of out) {
    const key = `${event.type} ${event.issue} ${event.msg}`;
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export interface DefectSourceClient {
  rest: {
    repos: {
      listCommits(params: { owner: string; repo: string; per_page: number; page: number }): Promise<{ data: any[] }>;
    };
    issues: {
      listForRepo(params: {
        owner: string;
        repo: string;
        state: 'all';
        since: string;
        per_page: number;
        page: number;
        sort: 'created';
        direction: 'desc';
      }): Promise<{ data: any[] }>;
      listComments(params: { owner: string; repo: string; issue_number: number; per_page: number }): Promise<{
        data: any[];
      }>;
    };
  };
}

export async function fetchDefectSources(
  client: DefectSourceClient,
  owner: string,
  repo: string,
  merged: MergedPrRef[],
  opts: { now: string; windowDays?: number },
): Promise<DefectSources> {
  const windowDays = opts.windowDays ?? DEFAULT_DEFECT_WINDOW_DAYS;
  const closed = merged.filter((pr) => isDefectWindowClosed(pr.mergedAt, opts.now, windowDays));

  if (closed.length === 0) {
    return { mergedPrs: merged, commits: [], issues: [], comments: [] };
  }

  const since = new Date(Math.min(...closed.map((pr) => Date.parse(pr.mergedAt)))).toISOString();

  const rawCommits: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await client.rest.repos.listCommits({ owner, repo, per_page: 100, page });
    rawCommits.push(...data);
    if (data.length < 100) break;
  }
  const commits: RepoCommitSource[] = rawCommits.map((c) => ({
    sha: c.sha,
    message: c.commit?.message ?? '',
    ts: c.commit?.author?.date ?? '',
  }));

  const rawIssues: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await client.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      since,
      per_page: 100,
      page,
      sort: 'created',
      direction: 'desc',
    });
    rawIssues.push(...data);
    if (data.length < 100) break;
  }
  const issues: RepoIssueSource[] = rawIssues.map((i) => ({
    number: i.number,
    title: i.title ?? '',
    body: i.body ?? '',
    createdAt: i.created_at,
    isPullRequest: Boolean(i.pull_request),
  }));

  const commentsPerPr = await Promise.all(
    closed.map(async (pr) => {
      const { data } = await client.rest.issues.listComments({ owner, repo, issue_number: pr.prNumber, per_page: 100 });
      return data.map((c: any): PrCommentSource => ({
        prNumber: pr.prNumber,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        ts: c.created_at,
        isBot: c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? ''),
      }));
    }),
  );
  const comments = commentsPerPr.flat();

  return { mergedPrs: merged, commits, issues, comments };
}
