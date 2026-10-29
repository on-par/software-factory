import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';
import { fakeOctokit } from '../harness/fake-octokit.js';

import { shipPhase } from './ship.js';

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function octokitFixture() {
  const bodies: string[] = [];
  const { octokit } = fakeOctokit({
    graphql: async () => ({}),
    'pulls.list': async () => ({ data: [{ number: 123 }] }),
    'pulls.get': async () => ({ data: { draft: false, node_id: 'PR_1' } }),
    'issues.get': async () => ({ data: { title: 'Name the checked commit' } }),
    'issues.createComment': async (args: { body: string }) => {
      bodies.push(args.body);
      return { data: { id: 1 } };
    },
  });
  return { octokit, bodies };
}

async function ship(run: (command: string) => Promise<{ stdout: string }>) {
  const { octokit, bodies } = octokitFixture();
  const logs: Array<[string, string]> = [];
  const result = await shipPhase({
    issue: workKeyFromIssue(1812),
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-1812',
    branch: 'ship-it/1812-checked-commit',
    octokit: octokit as any,
    watchCI: false,
    log: (type, msg) => logs.push([type, msg]),
    run,
    evidenceComment: true,
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
    const { result, bodies } = await ship(async (command) => {
      if (command === 'git rev-parse HEAD') return { stdout: `${HEAD_SHA}\n` };
      if (command.startsWith('git ls-remote --heads origin')) {
        return { stdout: `${HEAD_SHA}\trefs/heads/ship-it/1812-checked-commit\n` };
      }
      return { stdout: '' };
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`Checked commit: \`${HEAD_SHA}\``);
  });

  it('still posts the evidence pack without a SHA when git rev-parse HEAD fails at evidence time', async () => {
    let revParseCalls = 0;
    const { result, bodies, logs } = await ship(async (command) => {
      // The first call is the remote-head sync check; the evidence-time call is the one that fails.
      if (command === 'git rev-parse HEAD' && ++revParseCalls > 1) throw new Error('rev-parse failed');
      if (command === 'git rev-parse HEAD') return { stdout: `${HEAD_SHA}\n` };
      if (command.startsWith('git ls-remote --heads origin')) {
        return { stdout: `${HEAD_SHA}\trefs/heads/ship-it/1812-checked-commit\n` };
      }
      return { stdout: '' };
    });

    expect(result).toEqual({ ok: true, prNumber: 123 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Checked commit');
    expect(logs).toContainEqual(['evidence', 'posted evidence pack to PR #123']);
  });
});
