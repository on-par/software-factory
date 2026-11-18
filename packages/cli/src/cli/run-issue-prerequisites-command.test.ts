import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

function withPrerequisiteBody(state: 'OPEN' | 'CLOSED') {
  h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', body: 'Depends on: #4' } }));
  h.octokit.graphql = vi.fn(async (query: string) =>
    query.includes('QueuePrerequisite')
      ? {
          repository: {
            issue: {
              state,
              stateReason: null,
              closedByPullRequestsReferences: { nodes: [{ merged: true }], pageInfo: { hasNextPage: false } },
            },
          },
        }
      : { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } },
  );
}

async function runJson(...args: string[]) {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  const res = await runMainWith(undefined, 'run-issue', '5', '--json', ...args);
  vi.mocked(process.stdout.write).mockRestore();
  return { res, result: JSON.parse(out.at(-1) ?? '{}') };
}

describe('run-issue on an open Depends-on prerequisite (#4270)', () => {
  it('parks before PLAN and lists the prerequisite in --json', async () => {
    withPrerequisiteBody('OPEN');
    const { res, result } = await runJson('--no-pr');

    expect(res.exited).toBe(false);
    expect(result.phases).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'parked',
      exitReason: 'waiting for prerequisites: #4',
      prerequisites: [4],
    });
  });

  it('parks without --json too', async () => {
    withPrerequisiteBody('OPEN');
    const res = await runMainWith(undefined, 'run-issue', '5', '--no-pr');

    expect(res.exited).toBe(false);
    expect(readFileSync(paths().events, 'utf8')).toContain('"type":"issue_deferred"');
  });

  it('runs as usual when the prerequisite is closed', async () => {
    withPrerequisiteBody('CLOSED');
    const { result } = await runJson('--no-pr');

    expect(result.outcome).not.toBe('parked');
    expect(result.prerequisites).toEqual([]);
  });
});
