import { describe, expect, it, vi } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import {
  DEFAULT_DEFECT_WINDOW_DAYS,
  type DefectSourceClient,
  type DefectSources,
  detectPostMergeDefects,
  fetchDefectSources,
  isDefectWindowClosed,
  type MergedPrRef,
  mergedPrRefs,
  type PrCommentSource,
  type RepoCommitSource,
  type RepoIssueSource,
} from './defects.js';
import type { PrSource } from './human.js';

const MERGED_AT = '2026-07-01T00:00:00.000Z';
const NOW_CLOSED = '2026-08-01T00:00:00.000Z'; // 31 days later — window (14d) long closed
const NOW_OPEN = '2026-07-05T00:00:00.000Z'; // 4 days later — still inside 14d window

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    type: 'issue-title',
    issue: '1',
    msg: '',
    ...overrides,
  };
}

function mergedPr(overrides: Partial<MergedPrRef> = {}): MergedPrRef {
  return {
    issue: '1',
    prNumber: 77,
    mergedAt: MERGED_AT,
    mergeCommitSha: null,
    ...overrides,
  };
}

function commit(overrides: Partial<RepoCommitSource> = {}): RepoCommitSource {
  return {
    sha: 'deadbeef1234567',
    message: 'chore: unrelated commit',
    ts: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function repoIssue(overrides: Partial<RepoIssueSource> = {}): RepoIssueSource {
  return {
    number: 200,
    title: '',
    body: '',
    createdAt: '2026-07-10T00:00:00.000Z',
    isPullRequest: false,
    ...overrides,
  };
}

function prComment(overrides: Partial<PrCommentSource> = {}): PrCommentSource {
  return {
    prNumber: 77,
    author: 'someone',
    body: '',
    ts: '2026-07-10T00:00:00.000Z',
    isBot: false,
    ...overrides,
  };
}

function sources(overrides: Partial<DefectSources> = {}): DefectSources {
  return {
    mergedPrs: [mergedPr()],
    commits: [],
    issues: [],
    comments: [],
    ...overrides,
  };
}

describe('isDefectWindowClosed', () => {
  it('is true at exactly mergedAt + windowDays', () => {
    const end = new Date(Date.parse(MERGED_AT) + 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(isDefectWindowClosed(MERGED_AT, end, 14)).toBe(true);
  });

  it('is false one ms before the window closes', () => {
    const almost = new Date(Date.parse(MERGED_AT) + 14 * 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(isDefectWindowClosed(MERGED_AT, almost, 14)).toBe(false);
  });

  it('is false for an unparseable mergedAt or now', () => {
    expect(isDefectWindowClosed('not-a-date', NOW_CLOSED, 14)).toBe(false);
    expect(isDefectWindowClosed(MERGED_AT, 'not-a-date', 14)).toBe(false);
  });
});

describe('mergedPrRefs', () => {
  it('keeps merged numeric-issue PRs with mergeCommitSha carried through', () => {
    const source: PrSource = {
      issue: '5',
      prNumber: 10,
      commits: [],
      approvals: [],
      mergedAt: MERGED_AT,
      closedAt: null,
      mergeCommitSha: 'abc123',
    };

    expect(mergedPrRefs([source])).toEqual([
      { issue: '5', prNumber: 10, mergedAt: MERGED_AT, mergeCommitSha: 'abc123' },
    ]);
  });

  it('drops unmerged PRs and non-numeric issues', () => {
    const unmerged: PrSource = {
      issue: '5',
      prNumber: 10,
      commits: [],
      approvals: [],
      mergedAt: null,
      closedAt: null,
    };
    const nonNumeric: PrSource = {
      issue: 'abc',
      prNumber: 11,
      commits: [],
      approvals: [],
      mergedAt: MERGED_AT,
      closedAt: null,
    };

    expect(mergedPrRefs([unmerged, nonNumeric])).toEqual([]);
  });
});

describe('detectPostMergeDefects', () => {
  it('emits exactly one defect-window-closed event and no signals when the window is closed with no signals', () => {
    const result = detectPostMergeDefects(sources(), [], { now: NOW_CLOSED });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'defect-window-closed', issue: '1' });
  });

  it('emits nothing at all when the window is still open, even with a revert commit present', () => {
    const result = detectPostMergeDefects(
      sources({ commits: [commit({ message: 'Revert "fix thing" (#77)', ts: '2026-07-03T00:00:00.000Z' })] }),
      [],
      { now: NOW_OPEN },
    );

    expect(result).toEqual([]);
  });

  it('flags a revert commit inside the window naming the PR number', () => {
    const result = detectPostMergeDefects(
      sources({ commits: [commit({ message: 'Revert "fix thing (#77)"', ts: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
  });

  it('flags a revert commit inside the window quoting the merge SHA', () => {
    const result = detectPostMergeDefects(
      sources({
        mergedPrs: [mergedPr({ mergeCommitSha: 'abcdef1234567890' })],
        commits: [
          commit({
            message: 'Revert "fix thing"\n\nThis reverts commit abcdef1234567890.',
            ts: '2026-07-10T00:00:00.000Z',
          }),
        ],
      }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
  });

  it('does not flag a non-revert commit that merely mentions the PR number', () => {
    const result = detectPostMergeDefects(
      sources({ commits: [commit({ message: 'follow-up for #77', ts: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('flags a new issue inside the window with Fixes #<prNumber>', () => {
    const result = detectPostMergeDefects(
      sources({ issues: [repoIssue({ title: 'Fixes #77', createdAt: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
  });

  it('flags a new issue inside the window with Closes #<original issue number>', () => {
    const result = detectPostMergeDefects(
      sources({ issues: [repoIssue({ title: 'Closes #1', createdAt: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
  });

  it('does not flag a pull request returned by the issues API', () => {
    const result = detectPostMergeDefects(
      sources({
        issues: [repoIssue({ title: 'Fixes #77', createdAt: '2026-07-10T00:00:00.000Z', isPullRequest: true })],
      }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('does not flag a bare #77 with no closing keyword', () => {
    const result = detectPostMergeDefects(
      sources({ issues: [repoIssue({ title: 'see #77', createdAt: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('flags a non-bot comment inside the window matching the concern pattern, carrying actor', () => {
    const result = detectPostMergeDefects(
      sources({
        comments: [prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z', author: 'alice' })],
      }),
      [],
      { now: NOW_CLOSED },
    );

    const signal = result.find((e) => e.type === 'post-merge-defect');
    expect(signal).toMatchObject({ actor: 'alice' });
  });

  it('does not flag a bot comment with the same concerning body', () => {
    const result = detectPostMergeDefects(
      sources({ comments: [prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z', isBot: true })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('does not flag a non-bot comment with no concern keyword', () => {
    const result = detectPostMergeDefects(
      sources({ comments: [prComment({ body: 'nice work, thanks', ts: '2026-07-10T00:00:00.000Z' })] }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('does not flag a comment on a different PR number', () => {
    const result = detectPostMergeDefects(
      sources({
        comments: [prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z', prNumber: 99 })],
      }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('excludes signals dated outside the window: a late revert, an early issue, and a comment exactly at mergedAt', () => {
    const result = detectPostMergeDefects(
      sources({
        commits: [commit({ message: 'Revert "fix thing" (#77)', ts: '2026-07-21T00:00:00.000Z' })], // mergedAt + 20d
        issues: [repoIssue({ title: 'Fixes #77', createdAt: '2026-06-30T00:00:00.000Z' })], // mergedAt - 1d
        comments: [prComment({ body: 'this broke the build', ts: MERGED_AT })], // exactly at mergedAt
      }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('defect-window-closed');
  });

  it('dedups an identical signal appearing twice in sources, and drops one already present in logEvents', () => {
    const dup = detectPostMergeDefects(
      sources({
        comments: [
          prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z', author: 'alice' }),
          prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z', author: 'alice' }),
        ],
      }),
      [],
      { now: NOW_CLOSED },
    );
    expect(dup.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);

    const alreadyLogged: FactoryEvent[] = [
      event({
        issue: '1',
        type: 'post-merge-defect',
        msg: 'comment on PR #77 raises a post-merge concern',
      }),
    ];
    const suppressed = detectPostMergeDefects(
      sources({ comments: [prComment({ body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z' })] }),
      alreadyLogged,
      { now: NOW_CLOSED },
    );
    expect(suppressed.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);
  });

  it('attributes signals per-run across two merged PRs', () => {
    const result = detectPostMergeDefects(
      sources({
        mergedPrs: [mergedPr({ issue: '1', prNumber: 77 }), mergedPr({ issue: '2', prNumber: 88 })],
        comments: [prComment({ prNumber: 77, body: 'this broke the build', ts: '2026-07-10T00:00:00.000Z' })],
      }),
      [],
      { now: NOW_CLOSED },
    );

    expect(result.filter((e) => e.type === 'defect-window-closed')).toHaveLength(2);
    expect(result.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
    expect(result.find((e) => e.type === 'post-merge-defect')?.issue).toBe('1');
  });

  it('windowDays override changes what counts as in-window', () => {
    const twoDaysLater = new Date(Date.parse(MERGED_AT) + 2 * 24 * 60 * 60 * 1000).toISOString();
    const nowFarEnough = new Date(Date.parse(MERGED_AT) + 3 * 24 * 60 * 60 * 1000).toISOString();

    const withOverride = detectPostMergeDefects(
      sources({ comments: [prComment({ body: 'this broke the build', ts: twoDaysLater })] }),
      [],
      { now: nowFarEnough, windowDays: 1 },
    );
    expect(withOverride.filter((e) => e.type === 'post-merge-defect')).toHaveLength(0);

    const withDefault = detectPostMergeDefects(
      sources({ comments: [prComment({ body: 'this broke the build', ts: twoDaysLater })] }),
      [],
      { now: NOW_CLOSED, windowDays: DEFAULT_DEFECT_WINDOW_DAYS },
    );
    expect(withDefault.filter((e) => e.type === 'post-merge-defect')).toHaveLength(1);
  });
});

describe('fetchDefectSources', () => {
  function client(overrides: Partial<DefectSourceClient['rest']> = {}): DefectSourceClient {
    return {
      rest: {
        repos: { listCommits: vi.fn(async () => ({ data: [] })) },
        issues: {
          listForRepo: vi.fn(async () => ({ data: [] })),
          listComments: vi.fn(async () => ({ data: [] })),
        },
        ...overrides,
      },
    } as unknown as DefectSourceClient;
  }

  it('makes zero API calls when no merged PR has a closed window', async () => {
    const c = client();
    const result = await fetchDefectSources(c, 'o', 'r', [mergedPr({ mergedAt: NOW_OPEN })], { now: NOW_OPEN });

    expect(result).toEqual({ mergedPrs: [mergedPr({ mergedAt: NOW_OPEN })], commits: [], issues: [], comments: [] });
    expect(c.rest.repos.listCommits).not.toHaveBeenCalled();
    expect(c.rest.issues.listForRepo).not.toHaveBeenCalled();
    expect(c.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it('fetches commits, issues (with the correct since), and comments only for window-closed PRs', async () => {
    const listCommits = vi.fn(async () => ({
      data: [{ sha: 'abc', commit: { message: 'msg', author: { date: '2026-07-10T00:00:00.000Z' } } }],
    }));
    const listForRepo = vi.fn(async () => ({
      data: [{ number: 5, title: 't', body: 'b', created_at: '2026-07-10T00:00:00.000Z', pull_request: undefined }],
    }));
    const listComments = vi.fn(async () => ({
      data: [
        { user: { login: 'alice', type: 'User' }, body: 'hi', created_at: '2026-07-10T00:00:00.000Z' },
        { user: { login: 'renovate[bot]' }, body: 'hi', created_at: '2026-07-10T00:00:00.000Z' },
        { user: { login: 'bot-account', type: 'Bot' }, body: 'hi', created_at: '2026-07-10T00:00:00.000Z' },
      ],
    }));
    const c = client({ repos: { listCommits }, issues: { listForRepo, listComments } });

    const merged = [mergedPr({ prNumber: 77, mergedAt: MERGED_AT })];
    const result = await fetchDefectSources(c, 'owner', 'repo', merged, { now: NOW_CLOSED });

    expect(listCommits).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', per_page: 100, page: 1 });
    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', since: MERGED_AT, state: 'all' }),
    );
    expect(listComments).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 77, per_page: 100 });

    expect(result.commits).toEqual([{ sha: 'abc', message: 'msg', ts: '2026-07-10T00:00:00.000Z' }]);
    expect(result.issues).toEqual([
      { number: 5, title: 't', body: 'b', createdAt: '2026-07-10T00:00:00.000Z', isPullRequest: false },
    ]);
    expect(result.comments).toEqual([
      { prNumber: 77, author: 'alice', body: 'hi', ts: '2026-07-10T00:00:00.000Z', isBot: false },
      { prNumber: 77, author: 'renovate[bot]', body: 'hi', ts: '2026-07-10T00:00:00.000Z', isBot: true },
      { prNumber: 77, author: 'bot-account', body: 'hi', ts: '2026-07-10T00:00:00.000Z', isBot: true },
    ]);
  });

  it('stops paging commits and issues after a short page', async () => {
    const listCommits = vi.fn(async () => ({ data: [{ sha: 'a', commit: { message: '', author: { date: '' } } }] }));
    const listForRepo = vi.fn(async () => ({ data: [] }));
    const c = client({
      repos: { listCommits },
      issues: { listForRepo, listComments: vi.fn(async () => ({ data: [] })) },
    });

    await fetchDefectSources(c, 'o', 'r', [mergedPr({ mergedAt: MERGED_AT })], { now: NOW_CLOSED });

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(1);
  });
});
