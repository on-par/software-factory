import { describe, expect, it } from 'vitest';

import { shipPhase } from './ship.js';

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function fakeOctokit() {
  const bodies: string[] = [];
  const octokit = {
    graphql: async () => ({}),
    rest: {
      pulls: {
        list: async () => ({ data: [{ number: 123 }] }),
        get: async () => ({ data: { draft: false, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Name the checked commit' } }),
        createComment: async (args: { body: string }) => {
          bodies.push(args.body);
          return { data: { id: 1 } };
        },
      },
    },
  };
  return { octokit, bodies };
}

async function ship(run: (command: string) => Promise<{ stdout: string }>) {
  const { octokit, bodies } = fakeOctokit();
  const logs: Array<[string, string]> = [];
  const result = await shipPhase({
    issue: 1812,
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-1812',
    branch: 'ship-it/1812-checked-commit',
    octokit: octokit as any,
    watchCI: false,
    log: (type, msg) => logs.push([type, msg]),
    run,
    checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
    reworkRounds: 0,
    specPath: '/nonexistent/spec.md',
    eventsFile: '/nonexistent/events.ndjson',
    startedAt: new Date().toISOString(),
    logsDir: '/nonexistent/logs',
  });
  return { result, bodies, logs };
}

describe('shipPhase evidence pack checked commit (#1812)', () => {
  it('names the local HEAD SHA the checks ran on in the posted evidence pack', async () => {
    const { result, bodies } = await ship(async (command) =>
      command === 'git rev-parse HEAD' ? { stdout: `${HEAD_SHA}\n` } : { stdout: '' },
    );

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`Checked commit: \`${HEAD_SHA}\``);
  });

  it('still posts the evidence pack without a SHA when git rev-parse HEAD fails at evidence time', async () => {
    const { result, bodies, logs } = await ship(async (command) => {
      if (command === 'git rev-parse HEAD') throw new Error('rev-parse failed');
      return { stdout: '' };
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Checked commit');
    expect(logs).toContainEqual(['evidence', 'posted evidence pack to PR #123']);
  });
});
