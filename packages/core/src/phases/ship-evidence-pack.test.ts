import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { shipPhase } from './ship.js';

function createOctokit() {
  const calls: any[] = [];
  const octokit = {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 123 } }),
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Self-heal committed work' } }),
        createComment: async (args: any) => {
          calls.push(['issues.createComment', args]);
          return { data: { id: 1 } };
        },
      },
    },
  };
  return { octokit, calls };
}

const STUB_HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** stdout for the remote-head verification commands SHIP runs before opening a PR (#735). */
function remoteHeadStub(command: string): { stdout: string } | undefined {
  if (command === 'git rev-parse HEAD') return { stdout: `${STUB_HEAD_SHA}\n` };
  const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
  if (match) return { stdout: `${STUB_HEAD_SHA}\trefs/heads/${match[1]}\n` };
  return undefined;
}

describe('shipPhase evidence pack', () => {
  it('posts no evidence pack comment unless opted in', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: workKeyFromIssue(23),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).not.toContainEqual(['issues.createComment', expect.anything()]);
    expect(logs.some(([type]) => type === 'evidence')).toBe(false);
  });

  it('posts an evidence pack comment when opted in and logs evidence', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const checkSummary = { failures: 0, passes: 3, skips: 0, total: 3, results: [] };

    const result = await shipPhase({
      issue: workKeyFromIssue(23),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      evidenceComment: true,
      checkSummary,
      reworkRounds: 1,
      specPath: '/nonexistent/spec.md',
      eventsFile: '/nonexistent/events.ndjson',
      startedAt: new Date().toISOString(),
      logsDir: '/nonexistent/logs',
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual([
      'issues.createComment',
      expect.objectContaining({
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 123,
        body: expect.stringContaining('Evidence pack'),
      }),
    ]);
    expect(logs).toContainEqual(['evidence', 'posted evidence pack to PR #123']);
  });

  it('includes rework rounds in the posted comment body (AC-2)', async () => {
    const { octokit, calls } = createOctokit();
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };
    const checkSummary = { failures: 0, passes: 3, skips: 0, total: 3, results: [] };

    await shipPhase({
      issue: workKeyFromIssue(23),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      evidenceComment: true,
      checkSummary,
      reworkRounds: 2,
    });

    expect(calls).toContainEqual([
      'issues.createComment',
      expect.objectContaining({ body: expect.stringContaining('Rework rounds: 2') }),
    ]);
  });

  it('never blocks the ship when posting the evidence pack throws', async () => {
    const { octokit, calls } = createOctokit();
    octokit.rest.issues.createComment = async (args: any) => {
      calls.push(['issues.createComment', args]);
      throw new Error('comment failed');
    };
    const logs: Array<[string, string]> = [];
    const run = async (command: string) => {
      const remote = remoteHeadStub(command);
      if (remote) return remote;
      if (command === 'git status --porcelain') return { stdout: '' };
      if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
      if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
      if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++++++++++\n' };
      return { stdout: '' };
    };

    const result = await shipPhase({
      issue: workKeyFromIssue(23),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-23',
      branch: 'ship-it/23-self-heal',
      octokit: octokit as any,
      watchCI: false,
      log: (type, msg) => logs.push([type, msg]),
      run,
      evidenceComment: true,
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(calls).toContainEqual(['issues.createComment', expect.anything()]);
    expect(logs).toContainEqual(['ready', 'PR #123 ready for review']);
    expect(logs.some(([type]) => type === 'evidence')).toBe(false);
  });
});
