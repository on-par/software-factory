import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findAdoptablePr } from './adopt-pr.js';
import { workKeyFromIssue } from '../work/work-key.js';

const REPO = 'acme/widgets';
const pr = (number: number, ref: string, repo: string | null = REPO) => ({
  number,
  head: { ref, sha: `sha${number}`, repo: repo === null ? null : { full_name: repo } },
});

function stub(pages: unknown[][] | Error) {
  const list = vi.fn(async ({ page }: { page: number }) => {
    if (pages instanceof Error) throw pages;
    return { data: pages[page - 1] ?? [] };
  });
  const octokit = { rest: { pulls: { list } } } as any;
  return { octokit, list };
}

const find = (octokit: Pick<Octokit, 'rest'>, maxPages?: number) =>
  findAdoptablePr({ octokit, repo: REPO, issue: workKeyFromIssue(2253), branchPrefix: 'factory', maxPages });

describe('findAdoptablePr', () => {
  it('finds a single same-repo PR on a title-drifted branch', async () => {
    const { octokit } = stub([[pr(7, 'factory/2253-old-title')]]);
    expect(await find(octokit)).toEqual({
      status: 'found',
      prNumber: 7,
      branch: 'factory/2253-old-title',
      headSha: 'sha7',
    });
  });

  it('finds a legacy ship-it branch under the factory prefix', async () => {
    const { octokit } = stub([[pr(8, 'ship-it/2253-x')]]);
    expect(await find(octokit)).toMatchObject({ status: 'found', prNumber: 8, branch: 'ship-it/2253-x' });
  });

  it('ignores other issues and non-factory branches', async () => {
    const { octokit } = stub([[pr(1, 'factory/22530-x'), pr(2, 'factory/253-x'), pr(3, 'feature/2253-x')]]);
    expect(await find(octokit)).toEqual({ status: 'absent' });
  });

  it('does not match a PR whose branch does not parse', async () => {
    const { octokit } = stub([[pr(4, 'main'), pr(5, '')]]);
    expect(await find(octokit)).toEqual({ status: 'absent' });
  });

  it('excludes fork PRs and PRs with a deleted head repo', async () => {
    const { octokit } = stub([[pr(1, 'factory/2253-a', 'someone/widgets'), pr(2, 'factory/2253-b', null)]]);
    expect(await find(octokit)).toEqual({ status: 'absent' });
  });

  it('lists every match sorted when ambiguous', async () => {
    const { octokit } = stub([[pr(9, 'factory/2253-b'), pr(4, 'ship-it/2253-a')]]);
    expect(await find(octokit)).toEqual({
      status: 'ambiguous',
      prs: [
        { prNumber: 4, branch: 'ship-it/2253-a' },
        { prNumber: 9, branch: 'factory/2253-b' },
      ],
    });
  });

  it('ignores payloads without a head', async () => {
    const { octokit } = stub([[{ number: 5 }, { number: 6, head: {} }]]);
    expect(await find(octokit)).toEqual({ status: 'absent' });
  });

  it('finds a match on page 2', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(1000 + i, `feature/x-${i}`));
    const { octokit, list } = stub([full, [pr(7, 'factory/2253-late')]]);
    expect(await find(octokit)).toMatchObject({ status: 'found', prNumber: 7 });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('errors when the last allowed page is still full', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(1000 + i, `feature/x-${i}`));
    const { octokit } = stub([full, full]);
    expect(await find(octokit, 2)).toEqual({
      status: 'error',
      detail: 'open PR list exceeds 200; adoption skipped',
    });
  });

  it('returns error with detail when pulls.list throws', async () => {
    const { octokit } = stub(new Error('boom'));
    expect(await find(octokit)).toEqual({ status: 'error', detail: 'boom' });
  });

  it('calls only pulls.list', async () => {
    const { octokit, list } = stub([[pr(7, 'factory/2253-x')]]);
    await find(octokit);
    expect(Object.keys(octokit.rest)).toEqual(['pulls']);
    expect(Object.keys(octokit.rest.pulls)).toEqual(['list']);
    expect(list).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', state: 'open', per_page: 100, page: 1 });
  });
});
