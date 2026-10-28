import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { CheckResumeRecord } from '@on-par/factory-core/internal';
import { branchFor } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { resolveRunBranch } from './run-branch.js';
import { LaneParkError } from './index.js';
import { workKeyFromIssue } from '@on-par/factory-core';

const REPO = 'acme/widgets';
const pr = (number: number, ref: string) => ({ number, head: { ref, sha: `sha${number}`, repo: { full_name: REPO } } });

const tempDirs = createTempDirs();
let dir: string;
let eventsFile: string;
beforeEach(() => {
  dir = tempDirs.makeSync('run-branch-');
  eventsFile = join(dir, 'events.ndjson');
});
afterEach(() => tempDirs.cleanup());

function stub(result: unknown[] | Error) {
  const list = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return { data: result };
  });
  const octokit = { rest: { pulls: { list } } } as any;
  return { octokit, list };
}

const githubWork = { kind: 'github-issue', title: 'New title' } as any;
const events = () => (readFileSync(eventsFile, 'utf8').trim().split('\n') as string[]).map((l) => JSON.parse(l));

function run(octokit: Octokit, extra: Partial<Parameters<typeof resolveRunBranch>[0]> = {}) {
  return resolveRunBranch({
    issueNum: 2253,
    issueTitle: 'New title',
    ghRepo: REPO,
    branchPrefix: 'factory',
    sizeGateMode: 'off',
    work: githubWork,
    octokit,
    eventsFile,
    ...extra,
  });
}

describe('resolveRunBranch', () => {
  it("adopts the open factory PR's branch when the issue title changed since the park", async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-old-title')]);
    const branch = await run(octokit);
    expect(branch).toBe('factory/2253-old-title');
    expect(branch).not.toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
    const adopted = events().find((e) => e.type === 'pr-adopted');
    expect(adopted.msg).toContain('#7');
    expect(adopted.msg).toContain('sha7');
    expect(list.mock.calls.length).toBe(1);
    expect(Object.keys(octokit.rest.pulls)).toEqual(['list']);
  });

  it('throws LaneParkError escalate naming both PRs when two open factory PRs match the issue', async () => {
    const { octokit } = stub([pr(7, 'factory/2253-old-title'), pr(9, 'factory/2253-new-title')]);
    const err = await run(octokit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaneParkError);
    expect((err as { reason: string }).reason).toBe('escalate');
    expect((err as Error).message).toContain('#7');
    expect((err as Error).message).toContain('#9');
    expect(events().some((e) => e.type === 'pr-adopt-ambiguous')).toBe(true);
  });

  it('returns branchFor(issue, title, prefix) when no open factory PR matches', async () => {
    const { octokit } = stub([pr(1, 'factory/22530-x')]);
    expect(await run(octokit)).toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
  });

  it('falls back to branchFor and logs when the lookup fails', async () => {
    const { octokit } = stub(new Error('403'));
    expect(await run(octokit)).toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
    expect(events().find((e) => e.type === 'pr-adopt-lookup-failed').msg).toContain('403');
  });

  it('returns resumeFrom.branch without calling the lookup', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    const resumeFrom = { branch: 'factory/2253-resumed' } as CheckResumeRecord;
    expect(await run(octokit, { ctx: { resumeFrom } })).toBe('factory/2253-resumed');
    expect(list).not.toHaveBeenCalled();
  });

  it('skips the lookup for localOnly runs', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    const localOnly = { workspace: dir } as any;
    expect(await run(octokit, { ctx: { localOnly } })).toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
    expect(list).not.toHaveBeenCalled();
  });

  it('skips the lookup for --no-pr runs', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    expect(await run(octokit, { noPr: true })).toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
    expect(list).not.toHaveBeenCalled();
  });

  it('never adopts an open PR when a base branch is set (#3764)', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    expect(await run(octokit, { baseBranch: 'feat/x' })).toBe(
      branchFor(workKeyFromIssue(2253), 'New title', 'factory'),
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('skips the lookup for stack runs', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    const rest = {
      ...octokit.rest,
      users: { getAuthenticated: async () => ({ data: { id: 1 } }) },
      issues: { listComments: async () => ({ data: [] }) },
    };
    const stackOctokit = { rest } as any;
    expect(await run(stackOctokit, { sizeGateMode: 'stack' })).toBe(
      branchFor(workKeyFromIssue(2253), 'New title', 'factory'),
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('skips the lookup for non-github work', async () => {
    const { octokit, list } = stub([pr(7, 'factory/2253-x')]);
    const work = { kind: 'local', title: 'New title' } as any;
    expect(await run(octokit, { work })).toBe(branchFor(workKeyFromIssue(2253), 'New title', 'factory'));
    expect(list).not.toHaveBeenCalled();
  });
});
