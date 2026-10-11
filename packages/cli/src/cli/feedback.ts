// packages/cli/src/cli/feedback.ts — `factory feedback <pr-url>`: file a human review's findings as one factory issue (#1851).
// Each review body is sanitized on its own (stripHiddenContent) before it reaches the title or body (#1852).
// The issue goes to the operator's own repo (--repo, then filing.repo, then the checkout's origin remote); there is
// no built-in fallback repo. The host name and local paths stay out of the issue unless --include-local-paths is set.

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { readEvents } from '@on-par/factory-core';
import type { FileBugResult, FilingGitHubClient, FingerprintedFailure } from '@on-par/factory-core/internal';
import { DEFAULT_BUG_LABELS, factoryBranchIssue, fileBug, stripHiddenContent } from '@on-par/factory-core/internal';
import type { Octokit } from '@octokit/rest';

export const FEEDBACK_TRIAGE_LABEL = 'factory:needs-triage';
export const FEEDBACK_LABELS = [...DEFAULT_BUG_LABELS, FEEDBACK_TRIAGE_LABEL];

export interface ReviewFinding {
  author: string;
  kind: 'review' | 'comment';
  body: string;
  at: string;
  state?: string;
  path?: string;
  line?: number;
  url?: string;
}

interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface FeedbackGitHubClient {
  getPull(input: PrRef): Promise<{ headRef: string; title: string; url: string }>;
  listReviews(
    input: PrRef,
  ): Promise<Array<{ user: string; state: string; body: string; submittedAt: string; url?: string }>>;
  listReviewComments(
    input: PrRef,
  ): Promise<Array<{ user: string; body: string; path?: string; line?: number; createdAt: string; url?: string }>>;
}

export interface FeedbackDeps {
  github: FeedbackGitHubClient;
  filing: FilingGitHubClient;
  paths: { events: string; plans: string; logs: string };
  branchPrefix?: string;
  now: () => Date;
  host?: string;
  /** Repo (owner/name) the feedback issue is filed in. Required: there is no built-in default. */
  repo?: string;
  /** true: include the host name and local design/log paths in the issue (default false). */
  shareLocal?: boolean;
}

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const FEEDBACK_NO_REPO_MESSAGE =
  "factory feedback: can't tell which repo to file the issue in; pass --repo owner/name, set filing.repo in the factory config, or run it in a checkout with an origin remote";

/**
 * Pick the feedback target: the --repo flag, then the filing.repo config key, then the checkout's origin remote.
 * Returns undefined when none is set; an explicit flag or config value that is not owner/name is an error.
 */
export function resolveFeedbackRepo(input: {
  flag?: string;
  config?: string;
  remote?: string | null;
}): string | undefined {
  const explicit: Array<[string, string | undefined]> = [
    ['--repo', input.flag],
    ['filing.repo', input.config],
  ];
  for (const [source, raw] of explicit) {
    const value = raw?.trim();
    if (!value) continue;
    if (!REPO_SLUG_RE.test(value)) throw new Error(`factory feedback: ${source} must be owner/name, got "${value}"`);
    return value;
  }
  const remote = input.remote?.trim();
  return remote && REPO_SLUG_RE.test(remote) ? remote : undefined;
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parseFeedbackPrUrl(raw: string): { owner: string; repo: string; number: number; url: string } {
  const m = PR_URL_RE.exec(raw.trim());
  if (!m) throw new Error(`factory feedback: "${raw}" is not a GitHub pull request URL`);
  const [, owner, repo, num] = m;
  const number = Number(num);
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

export async function collectReviewFindings(client: FeedbackGitHubClient, pr: PrRef): Promise<ReviewFinding[]> {
  const [reviews, comments] = await Promise.all([client.listReviews(pr), client.listReviewComments(pr)]);
  const findings: ReviewFinding[] = [];
  for (const r of reviews) {
    const body = stripHiddenContent(r.body ?? '').trim();
    if (!body) continue;
    findings.push({
      author: stripHiddenContent(r.user),
      kind: 'review',
      body,
      at: r.submittedAt,
      state: r.state,
      url: r.url,
    });
  }
  for (const c of comments) {
    const body = stripHiddenContent(c.body ?? '').trim();
    if (!body) continue;
    findings.push({
      author: stripHiddenContent(c.user),
      kind: 'comment',
      body,
      at: c.createdAt,
      path: c.path === undefined ? undefined : stripHiddenContent(c.path),
      line: c.line,
      url: c.url,
    });
  }
  return findings.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const TITLE_MAX = 80;

export function buildFeedbackTitle(findings: readonly ReviewFinding[], note?: string): string {
  const trimmedNote = note?.trim();
  if (trimmedNote) return `[feedback] ${trimmedNote}`;
  const first = findings[0];
  if (!first) throw new Error('factory feedback: the PR has no review findings; pass --note to describe the problem');
  const rawLine = first.body.split('\n').find((l) => l.trim()) ?? '';
  const line = rawLine.replace(/\s+/g, ' ').trim();
  const cut = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
  return `[feedback] ${cut}`;
}

function renderFindings(findings: readonly ReviewFinding[]): string {
  return findings
    .map((f) => {
      const where = f.kind === 'review' ? (f.state ?? 'review') : `${f.path ?? 'unknown'}${f.line ? `:${f.line}` : ''}`;
      return `### ${f.author} — ${where} (${f.at})\n${f.body}\n`;
    })
    .join('\n');
}

function runWindow(
  events: readonly FactoryEvent[],
  issue: number,
  slug: string,
): { first?: string; last?: string; count: number } {
  const mine = events.filter((e) => e.issue === String(issue) && (e.repo === undefined || e.repo === slug));
  if (mine.length === 0) return { count: 0 };
  const stamps = mine.map((e) => e.ts).sort();
  return { first: stamps[0], last: stamps[stamps.length - 1], count: mine.length };
}

export async function runFeedback(prUrl: string, opts: { note?: string }, deps: FeedbackDeps): Promise<FileBugResult> {
  const pr = parseFeedbackPrUrl(prUrl);
  const target = deps.repo?.trim();
  if (!target || !REPO_SLUG_RE.test(target)) throw new Error(FEEDBACK_NO_REPO_MESSAGE);
  const shareLocal = deps.shareLocal === true;
  const pull = await deps.github.getPull(pr);
  const findings = await collectReviewFindings(deps.github, pr);
  const title = buildFeedbackTitle(findings, opts.note);
  const issue = factoryBranchIssue(pull.headRef, deps.branchPrefix);

  const window = issue === null ? undefined : runWindow(readEvents(deps.paths.events), issue, `${pr.owner}/${pr.repo}`);
  const designPath = issue === null ? undefined : join(deps.paths.plans, `issue-${issue}.md`);
  const logPath = issue === null ? deps.paths.logs : join(deps.paths.logs, String(issue));
  const host = deps.host ?? hostname();
  const notShared = 'kept on the operator machine (not shared; pass --include-local-paths to share it)';

  const lines = [
    `Human review of ${pr.url} found factory defects the run did not catch.`,
    '',
    `- PR: ${pr.url} (${pull.title})`,
    `- Factory issue: ${issue === null ? `not a factory branch (${pull.headRef})` : `#${issue}`}`,
    `- Run events: ${
      window?.count
        ? `${window.count} between ${window.first} and ${window.last}`
        : shareLocal
          ? `none found in ${deps.paths.events}`
          : 'none found locally'
    }`,
    `- Design artifact: ${designPath ? (shareLocal ? `${host}:${designPath}` : notShared) : 'unknown'}`,
    `- Findings: ${findings.length}`,
  ];
  const note = opts.note?.trim();
  if (note) lines.push(`- Note: ${note}`);

  const fingerprint = `fb_${createHash('sha256')
    .update(`${pr.url}|${deps.now().toISOString()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const fingerprinted: FingerprintedFailure = {
    fingerprint,
    evidence: {
      repo: `${pr.owner}/${pr.repo}`,
      issue: issue === null ? pr.url : String(issue),
      phase: 'check',
      model: 'human-review',
      reason: 'unknown',
      component: 'human-review',
      origin: 'factory-internal',
      eventExcerpt: renderFindings(findings) || '(no review findings; see note)',
      logPath,
    },
  };

  return fileBug(deps.filing, {
    fingerprinted,
    now: deps.now,
    labels: FEEDBACK_LABELS,
    title,
    problem: lines.join('\n'),
    host: deps.host,
    shareLocation: shareLocal,
    internalRepo: target,
  });
}

export function createOctokitFeedbackClient(octokit: Octokit): FeedbackGitHubClient {
  return {
    async getPull({ owner, repo, number }) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
      return { headRef: data.head.ref, title: data.title, url: data.html_url };
    },
    async listReviews({ owner, repo, number }) {
      const data = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return data.map((r) => ({
        user: r.user?.login ?? 'unknown',
        state: r.state,
        body: r.body ?? '',
        submittedAt: r.submitted_at ?? '',
        url: r.html_url,
      }));
    },
    async listReviewComments({ owner, repo, number }) {
      const data = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return data.map((c) => ({
        user: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        path: c.path,
        line: c.line ?? c.original_line ?? undefined,
        createdAt: c.created_at,
        url: c.html_url,
      }));
    },
  };
}

/** Wire the real GitHub clients and run-state paths into FeedbackDeps. */
export function buildFeedbackDeps(
  octokit: Octokit,
  paths: { events: string; plans: string; logs: string },
  branchPrefix: string,
  createFilingClient: (octokit: Octokit) => FilingGitHubClient,
  options: { repo?: string; shareLocal?: boolean } = {},
): FeedbackDeps {
  return {
    repo: options.repo,
    shareLocal: options.shareLocal === true,
    github: createOctokitFeedbackClient(octokit),
    filing: createFilingClient(octokit),
    paths: { events: paths.events, plans: paths.plans, logs: paths.logs },
    branchPrefix,
    now: () => new Date(),
  };
}
