import { describe, expect, it, vi } from 'vitest';
import { lookupOpenPrByBranch, lookupOpenPrByIssue } from './pr-lookup.js';

const REPO = 'acme/widgets';

function pr(number: number, body: string | null, opts: { ref?: string; repo?: string | null } = {}) {
  const repo = opts.repo === undefined ? REPO : opts.repo;
  return {
    number,
    body,
    head: { ref: opts.ref ?? `factory/19-${number}`, sha: `sha${number}`, repo: repo ? { full_name: repo } : null },
  };
}

function stub(pages: unknown[][] | Error) {
  const list = vi.fn(async ({ page }: { page: number }) => {
    if (pages instanceof Error) throw pages;
    return { data: pages[page - 1] ?? [] };
  });
  return { octokit: { rest: { pulls: { list } } } as any, list };
}

describe('lookupOpenPrByIssue', () => {
  it('returns ambiguous for two matching same-repo open PRs, and none for a single fork PR', async () => {
    const two = stub([[pr(9, 'Closes #19'), pr(4, 'Closes #19')]]);
    const res = await lookupOpenPrByIssue({ octokit: two.octokit, repo: REPO, issue: 19 });
    expect(res).toEqual({
      status: 'ambiguous',
      prs: [
        { prNumber: 4, branch: 'factory/19-4', headSha: 'sha4' },
        { prNumber: 9, branch: 'factory/19-9', headSha: 'sha9' },
      ],
    });
    const fork = stub([[pr(5, 'Closes #19', { repo: 'someone/widgets' })]]);
    expect(await lookupOpenPrByIssue({ octokit: fork.octokit, repo: REPO, issue: 19 })).toEqual({ status: 'none' });
  });

  it('returns found for a single same-repo match', async () => {
    const { octokit } = stub([[pr(5, 'Closes #19')]]);
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toEqual({
      status: 'found',
      prNumber: 5,
      branch: 'factory/19-5',
      headSha: 'sha5',
    });
  });

  it('excludes a null head.repo and accepts a case-different full_name', async () => {
    const { octokit } = stub([[pr(5, 'Closes #19', { repo: null }), pr(6, 'closes #19', { repo: 'Acme/Widgets' })]]);
    const res = await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 });
    expect(res).toMatchObject({ status: 'found', prNumber: 6 });
  });

  it('ignores Closes #190, Fixes #19 and a null body', async () => {
    const { octokit } = stub([[pr(1, 'Closes #190'), pr(2, 'Fixes #19'), pr(3, null)]]);
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toEqual({ status: 'none' });
  });

  it('ignores malformed payloads without a head', async () => {
    const { octokit } = stub([
      [
        { number: 1, body: 'Closes #19' },
        { number: 2, body: 'Closes #19', head: {} },
      ],
    ]);
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toEqual({ status: 'none' });
  });

  it('returns error, not none, when the list call fails', async () => {
    const { octokit } = stub(new Error('rate limited'));
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toEqual({
      status: 'error',
      detail: 'rate limited',
    });
  });

  it('stringifies a non-Error throw', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => {
            throw 'boom';
          },
        },
      },
    };
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toEqual({ status: 'error', detail: 'boom' });
  });

  it('finds a match on page 2', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => pr(1000 + i, 'nothing'));
    const { octokit, list } = stub([filler, [pr(5, 'Closes #19')]]);
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19 })).toMatchObject({
      status: 'found',
      prNumber: 5,
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the last allowed page is full', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => pr(1000 + i, 'nothing'));
    const { octokit } = stub([filler, filler]);
    expect(await lookupOpenPrByIssue({ octokit, repo: REPO, issue: 19, maxPages: 2 })).toEqual({
      status: 'error',
      detail: 'open PR list exceeds 200',
    });
  });
});

describe('lookupOpenPrByBranch', () => {
  it('sends the head filter and finds the same-repo PR', async () => {
    const { octokit, list } = stub([[pr(5, null, { ref: 'factory/19-x' })]]);
    const res = await lookupOpenPrByBranch({ octokit, repo: REPO, branch: 'factory/19-x' });
    expect(res).toMatchObject({ status: 'found', prNumber: 5 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ head: 'acme:factory/19-x', state: 'open' }));
  });

  it('excludes a same-owner fork', async () => {
    const { octokit } = stub([[pr(5, null, { ref: 'factory/19-x', repo: 'acme/widgets-fork' })]]);
    expect(await lookupOpenPrByBranch({ octokit, repo: REPO, branch: 'factory/19-x' })).toEqual({ status: 'none' });
  });

  it('returns ambiguous for two PRs on the branch', async () => {
    const { octokit } = stub([[pr(5, null, { ref: 'factory/19-x' }), pr(6, null, { ref: 'factory/19-x' })]]);
    expect(await lookupOpenPrByBranch({ octokit, repo: REPO, branch: 'factory/19-x' })).toMatchObject({
      status: 'ambiguous',
    });
  });

  it('ignores a PR whose head.ref differs from the branch', async () => {
    const { octokit } = stub([[pr(5, null, { ref: 'factory/19-other' })]]);
    expect(await lookupOpenPrByBranch({ octokit, repo: REPO, branch: 'factory/19-x' })).toEqual({ status: 'none' });
  });

  it('returns error when the list call fails', async () => {
    const { octokit } = stub(new Error('down'));
    expect(await lookupOpenPrByBranch({ octokit, repo: REPO, branch: 'factory/19-x' })).toEqual({
      status: 'error',
      detail: 'down',
    });
  });
});
