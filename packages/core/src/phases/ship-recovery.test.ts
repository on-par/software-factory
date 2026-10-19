import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const headSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function octokitFixture() {
  const calls: string[] = [];
  const octokit = {
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          calls.push('pulls.create');
          return { data: { number: 123 } };
        },
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Recovery test' } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    },
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
  };
  return { octokit, calls };
}

function remoteHead(command: string): { stdout: string } | undefined {
  if (command === 'git rev-parse HEAD') return { stdout: `${headSha}\n` };
  const match = /^git ls-remote --heads origin '(.+)'$/.exec(command);
  return match ? { stdout: `${headSha}\trefs/heads/${match[1]}\n` } : undefined;
}

function makeRunner(options: {
  status?: (count: number) => string;
  probe?: () => Promise<{ stdout: string }>;
  add?: () => Promise<{ stdout: string }>;
  commit?: () => Promise<{ stdout: string }>;
}) {
  const commands: string[] = [];
  let statusCount = 0;
  const run = async (command: string) => {
    commands.push(command);
    const remote = remoteHead(command);
    if (remote) return remote;
    if (command === 'git status --porcelain') return { stdout: options.status?.(++statusCount) ?? '' };
    if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
    if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
    if (command === 'git diff --cached --quiet') return options.probe ? options.probe() : { stdout: '' };
    if (command === 'git add -A') return options.add ? options.add() : { stdout: '' };
    if (command.startsWith('git commit')) return options.commit ? options.commit() : { stdout: '' };
    if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 1 +\n' };
    return { stdout: '' };
  };
  return { run, commands };
}

async function ship(
  octokit: ReturnType<typeof octokitFixture>['octokit'],
  run: ReturnType<typeof makeRunner>['run'],
  logs: Array<[string, string]> = [],
) {
  return shipPhase({
    issue: 23,
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-23',
    branch: 'ship-it/23-self-heal',
    octokit: octokit as never,
    watchCI: false,
    log: (type, message) => logs.push([type, message]),
    run,
  });
}

describe('SHIP leftover-output recovery', () => {
  it('commits modified and untracked build output after a green check and proceeds to the PR', async () => {
    const { octokit, calls } = octokitFixture();
    const logs: Array<[string, string]> = [];
    let committed = false;
    const { run, commands } = makeRunner({
      status: () => (committed ? '' : ' M packages/core/src/phases/ship.ts\n?? new.test.ts\n'),
      probe: async () => {
        throw Object.assign(new Error('diff found'), { code: 1 });
      },
      commit: async () => {
        committed = true;
        return { stdout: '' };
      },
    });
    const result = await ship(octokit, run, logs);
    const addIndex = commands.indexOf('git add -A');
    const probeIndex = commands.indexOf('git diff --cached --quiet');
    const commitIndex = commands.findIndex((command) => command.startsWith('git commit -m'));
    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(addIndex).toBeLessThan(probeIndex);
    expect(probeIndex).toBeLessThan(commitIndex);
    expect(commands[commitIndex]).toBe("git commit -m 'chore(ship): commit build output left after check (#23)'");
    expect(calls).toContain('pulls.create');
    expect(logs).toContainEqual(['ship', 'committed 2 uncommitted path(s) left after check on ship-it/23-self-heal']);
  });

  it('parks without staging when the worktree has unmerged entries', async () => {
    const { octokit, calls } = octokitFixture();
    const { run, commands } = makeRunner({
      status: () => 'UU packages/core/src/phases/ship.ts\nM  packages/core/src/other.ts\n',
    });
    const result = await ship(octokit, run);
    expect(result).toEqual({ ok: false, reason: 'worktree has merge conflicts in packages/core/src/phases/ship.ts' });
    expect(commands.some((command) => /^(git add|git commit|git push)/.test(command))).toBe(false);
    expect(calls).not.toContain('pulls.create');
  });

  it('reports commit stderr and parks without pushing', async () => {
    const { octokit, calls } = octokitFixture();
    const { run, commands } = makeRunner({
      status: () => '?? scratch.txt\n',
      probe: async () => {
        throw Object.assign(new Error('diff found'), { code: 1 });
      },
      commit: async () => {
        throw Object.assign(new Error('commit failed'), { stderr: 'fatal: cannot commit\n' });
      },
    });
    const result = await ship(octokit, run);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^could not commit leftover build output:/);
    expect(result.reason).toContain('fatal: cannot commit');
    expect(commands.some((command) => command.startsWith('git push'))).toBe(false);
    expect(calls).not.toContain('pulls.create');
  });

  it.each([
    ['128', Object.assign(new Error('probe failed'), { code: 128 })],
    ['missing', new Error('probe failed')],
    ['string', Object.assign(new Error('probe failed'), { code: '1' })],
  ])('fails closed when staged diff probe has %s code', async (_label, error) => {
    const { octokit, calls } = octokitFixture();
    const { run, commands } = makeRunner({
      status: () => ' M file.ts\n',
      probe: async () => {
        throw error;
      },
    });
    const result = await ship(octokit, run);
    expect(result.ok).toBe(false);
    expect(commands.some((command) => command.startsWith('git commit'))).toBe(false);
    expect(commands.some((command) => command.startsWith('git push'))).toBe(false);
    expect(calls).not.toContain('pulls.create');
  });

  it('preserves the worktree when staging fails', async () => {
    const { octokit, calls } = octokitFixture();
    const { run, commands } = makeRunner({
      status: () => ' M file.ts\n',
      add: async () => {
        throw Object.assign(new Error('index locked'), { stderr: 'fatal: index.lock exists' });
      },
    });
    const result = await ship(octokit, run);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('fatal: index.lock exists');
    expect(commands).not.toContain('git diff --cached --quiet');
    expect(commands.some((command) => command.startsWith('git commit'))).toBe(false);
    expect(commands.some((command) => command.startsWith('git push'))).toBe(false);
    expect(calls).not.toContain('pulls.create');
  });

  it('preserves a dirty worktree after a successful empty-stage skip', async () => {
    const { octokit, calls } = octokitFixture();
    const { run, commands } = makeRunner({ status: () => ' M remains.ts\n' });
    const result = await ship(octokit, run);
    expect(result).toEqual({ ok: false, reason: 'worktree still dirty after committing leftover build output' });
    expect(commands.some((command) => command.startsWith('git commit'))).toBe(false);
    expect(commands.some((command) => command.startsWith('git push'))).toBe(false);
    expect(calls).not.toContain('pulls.create');
  });

  it('uses stdout in the SHIP reason when a commit failure has empty stderr', async () => {
    const { octokit } = octokitFixture();
    const { run } = makeRunner({
      status: () => '?? scratch.txt\n',
      probe: async () => {
        throw Object.assign(new Error('diff found'), { code: 1 });
      },
      commit: async () => {
        throw Object.assign(new Error('command failed'), {
          stdout: 'nothing added to commit\n',
          stderr: '',
        });
      },
    });
    const result = await ship(octokit, run);
    expect(result.reason).toContain('nothing added to commit');
    expect(result.reason).not.toContain('command failed');
  });

  it('logs exactly five paths without a suffix at the boundary', async () => {
    const { octokit } = octokitFixture();
    const logs: Array<[string, string]> = [];
    const { run } = makeRunner({ status: () => ' M a\n M b\n M c\n M d\n M e\n' });
    await ship(octokit, run, logs);
    expect(logs.some(([, message]) => message.includes('a, b, c, d, e') && !message.includes('more'))).toBe(true);
  });
});
