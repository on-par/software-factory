import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const HEAD_SHA = 'a'.repeat(40);

function createOctokit(openPr?: number) {
  const calls: Array<[string, any]> = [];
  const octokit = {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async (args: any) => {
          calls.push(['pulls.list', args]);
          return { data: openPr === undefined ? [] : [{ number: openPr }] };
        },
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: 123 } };
        },
        get: async (args: any) => {
          calls.push(['pulls.get', args]);
          return { data: { draft: true, node_id: 'PR_1' } };
        },
      },
      issues: {
        get: async () => ({ data: { title: 'Large change' } }),
        createComment: async (args: any) => {
          calls.push(['issues.createComment', args]);
          return { data: { id: 1 } };
        },
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    },
  };
  return { octokit, calls };
}

function makeRun(numstat: string | Error) {
  return async (command: string) => {
    if (command === 'git rev-parse HEAD') return { stdout: `${HEAD_SHA}\n` };
    const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
    if (match) return { stdout: `${HEAD_SHA}\trefs/heads/${match[1]}\n` };
    if (command === 'git status --porcelain') return { stdout: '' };
    if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
    if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
    if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' a.ts | 3 +++\n' };
    if (command === 'git diff --numstat origin/main...HEAD') {
      if (numstat instanceof Error) throw numstat;
      return { stdout: numstat };
    }
    return { stdout: '' };
  };
}

function numstatFor(files: number, linesEach: number): string {
  return Array.from({ length: files }, (_, i) => `${linesEach}\t0\tsrc/file-${i}.ts\n`).join('');
}

function ship(
  numstat: string | Error,
  extra: { walkthrough?: { minLines?: number; minFiles?: number }; openPr?: number } = {},
) {
  const { octokit, calls } = createOctokit(extra.openPr);
  const logs: Array<[string, string]> = [];
  const promise = shipPhase({
    issue: workKeyFromIssue(23),
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-23',
    branch: 'ship-it/23-large',
    octokit: octokit as any,
    watchCI: false,
    log: (type, msg) => logs.push([type, msg]),
    run: makeRun(numstat),
    walkthrough: extra.walkthrough,
    evidenceComment: true,
    checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
  });
  return { promise, calls, logs };
}

const bodyOf = (calls: Array<[string, any]>, name: string): string => String(calls.find(([n]) => n === name)?.[1].body);

describe('shipPhase PR walkthrough (#3623)', () => {
  it('embeds a walkthrough in the evidence pack and PR body when the diff meets both thresholds', async () => {
    const { promise, calls } = ship(numstatFor(5, 60));
    expect(await promise).toEqual({ ok: true, prNumber: 123 });

    const comment = bodyOf(calls, 'issues.createComment');
    for (const part of ['PR walkthrough', '### Intent', '### Main files', '### How to verify']) {
      expect(comment).toContain(part);
    }
    expect(bodyOf(calls, 'pulls.create')).toContain('## Walkthrough');
  });

  it('adds no walkthrough and still ships when the diff is below either threshold', async () => {
    const { promise, calls } = ship(numstatFor(4, 250));
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(bodyOf(calls, 'issues.createComment').toLowerCase()).not.toContain('walkthrough');
    expect(bodyOf(calls, 'pulls.create').toLowerCase()).not.toContain('walkthrough');
  });

  it('honours configured thresholds', async () => {
    const { promise, calls } = ship(numstatFor(1, 10), { walkthrough: { minLines: 5, minFiles: 1 } });
    await promise;
    expect(bodyOf(calls, 'issues.createComment')).toContain('PR walkthrough');
  });

  it('logs walkthrough skipped and still ships when numstat fails', async () => {
    const { promise, calls, logs } = ship(new Error('bad revision'));
    expect(await promise).toEqual({ ok: true, prNumber: 123 });
    expect(logs).toContainEqual(['warn', expect.stringContaining('walkthrough skipped')]);
    expect(bodyOf(calls, 'issues.createComment')).toContain('Evidence pack');
    expect(bodyOf(calls, 'issues.createComment')).not.toContain('PR walkthrough');
  });

  it('builds the walkthrough on the existing-PR path', async () => {
    const { promise, calls } = ship(numstatFor(5, 60), { openPr: 456 });
    expect(await promise).toEqual({ ok: true, prNumber: 456 });
    expect(bodyOf(calls, 'issues.createComment')).toContain('PR walkthrough');
  });
});
