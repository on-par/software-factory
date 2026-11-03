import { describe, expect, it } from 'vitest';

import { createFakeGitHub } from '../fakes/fake-github.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { shipPhase } from './ship.js';

const SHA = 'c'.repeat(40);
const REPO = '/repos/on-par/software-factory';
const BRANCH = 'ship-it/11-ci-unknown';

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/${BRANCH}\n` };
  if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++\n' };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

const brokenWatch = async (): Promise<never> => {
  throw new Error('GitHub 502');
};

async function shipWithBrokenWatch(extra: { draft?: boolean } = {}) {
  const github = createFakeGitHub([
    [`GET ${REPO}/pulls`, () => []],
    [`POST ${REPO}/pulls`, () => ({ number: 123 })],
    [`GET ${REPO}/pulls/123`, () => ({ draft: true, node_id: 'PR_1' })],
    [`GET ${REPO}/issues/11`, () => ({ title: 'CI unknown' })],
    ['POST /graphql', () => ({ data: {} })],
  ]);
  const logs: Array<[string, string]> = [];
  const result = await shipPhase({
    issue: workKeyFromIssue(11),
    repo: 'on-par/software-factory',
    worktree: '/repo-factory-11',
    branch: BRANCH,
    octokit: github.octokit,
    watchCI: true,
    log: (type, msg) => logs.push([type, msg]),
    run,
    ciWatch: brokenWatch,
    ...extra,
  });
  const readyFlips = github.requests.filter((r) => r.method === 'POST' && r.path === '/graphql');
  return { result, logs, readyFlips };
}

const ciUnknown = {
  ok: false,
  prNumber: 123,
  reason: 'CI unknown for PR #123: the CI watch failed (GitHub 502); leaving PR as draft',
  ciPending: true,
  draft: true,
};

describe('shipPhase when the CI watch fails', () => {
  it('never marks the PR ready and fails SHIP as CI unknown when there is no preview gate', async () => {
    const { result, logs, readyFlips } = await shipWithBrokenWatch();
    expect(readyFlips).toEqual([]);
    expect(result).toMatchObject(ciUnknown);
    expect(result.ciOutcome).toBeUndefined();
    expect(logs).toContainEqual(['warn', 'CI watch for PR #123 failed: GitHub 502; treating CI as pending']);
    expect(logs.some(([type]) => type === 'ready')).toBe(false);
  });

  it('fails SHIP as CI unknown in draft mode too, instead of reporting a successful draft', async () => {
    const { result, readyFlips } = await shipWithBrokenWatch({ draft: true });
    expect(readyFlips).toEqual([]);
    expect(result).toMatchObject(ciUnknown);
  });
});
