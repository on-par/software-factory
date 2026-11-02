import { describe, expect, it } from 'vitest';

import {
  classifyRequiredChecks,
  evaluatePushChecks,
  evaluateRequiredChecks,
  fetchRequiredChecksVerdict,
} from './required-checks.js';

const run = (name: string, status: string | null, conclusion: string | null) => ({ name, status, conclusion });
const args = { owner: 'o', repo: 'r', branch: 'main', sha: 'a'.repeat(40) };

function fake(opts: {
  contexts?: string[];
  runs?: Array<ReturnType<typeof run>>;
  workflowRuns?: Array<{ name: string; status: string; conclusion: string }>;
}) {
  const notFound = () => Promise.reject(Object.assign(new Error('http 404'), { status: 404 }));
  return {
    rest: {
      repos: {
        getStatusChecksProtection: opts.contexts ? async () => ({ data: { contexts: opts.contexts } }) : notFound,
        getBranchRules: notFound,
      },
      checks: { listForRef: async () => ({ data: { check_runs: opts.runs ?? [] } }) },
      actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: opts.workflowRuns ?? [] } }) },
    },
  } as never;
}

describe('skipped and neutral count as passing (#3871)', () => {
  it('counts skipped and neutral required runs as passing like GitHub (#3871)', () => {
    for (const c of ['skipped', 'neutral'])
      expect(evaluateRequiredChecks(['a'], [run('a', 'completed', c)])).toMatchObject({ green: true, state: 'green' });
    expect(
      evaluateRequiredChecks(['a', 'b'], [run('a', 'completed', 'success'), run('b', 'completed', 'skipped')]).green,
    ).toBe(true);
    expect(
      evaluateRequiredChecks(['a'], [run('a', 'completed', 'success'), run('a', 'completed', 'skipped')]).green,
    ).toBe(true);
    expect(
      evaluateRequiredChecks(['a'], [run('a', 'completed', 'skipped'), run('a', 'completed', 'failure')]),
    ).toMatchObject({ state: 'failed', reason: 'a failure' });
  });

  it('is green for skipped and neutral push runs (#3871)', () => {
    expect(evaluatePushChecks([run('a', 'completed', 'skipped'), run('b', 'completed', 'neutral')]).green).toBe(true);
  });

  it('classifies skipped and neutral required runs as green (#3871)', () => {
    expect(
      classifyRequiredChecks(['a', 'b'], [run('a', 'completed', 'skipped'), run('b', 'completed', 'neutral')]),
    ).toEqual({ state: 'green', missing: [], pending: [], failed: [] });
  });

  it('treats a skipped or neutral CI workflow without a check suite as not failed (#3871)', async () => {
    for (const conclusion of ['skipped', 'neutral']) {
      const octokit = fake({ workflowRuns: [{ name: 'CI', status: 'completed', conclusion }] });
      expect((await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).state).toBe('pending');
    }
    const octokit = fake({ workflowRuns: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] });
    expect((await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).state).toBe('failed');
  });

  it('is green for a required context whose run was skipped (#3871)', async () => {
    const octokit = fake({ contexts: ['test'], runs: [run('test', 'completed', 'skipped')] });
    expect((await fetchRequiredChecksVerdict(octokit, args, { pushFallback: true })).green).toBe(true);
  });
});
