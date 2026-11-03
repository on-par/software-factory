import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import { shipPhase } from './ship.js';

const SHA = 'a'.repeat(40);

function createOctokit(checkRuns: any[]) {
  const graphqlCalls: string[] = [];
  const octokit = {
    graphql: async (query: string) => {
      graphqlCalls.push(query);
      return {};
    },
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 123 } }),
        get: async () => ({ data: { draft: true, node_id: 'PR_1' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Preview' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: checkRuns } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: SHA } }) },
    },
  };
  return { octokit, graphqlCalls };
}

const run = async (command: string) => {
  if (command === 'git rev-parse HEAD') return { stdout: `${SHA}\n` };
  if (command.startsWith('git ls-remote --heads origin')) return { stdout: `${SHA}\trefs/heads/ship-it/9-preview\n` };
  if (command === 'git status --porcelain') return { stdout: '' };
  if (command === 'git diff --stat origin/main...HEAD') return { stdout: ' ship.ts | 12 ++++\n' };
  if (command === 'git rev-list --count origin/main..HEAD') return { stdout: '1\n' };
  if (command === 'git diff --quiet origin/main..HEAD') throw new Error('trees differ');
  return { stdout: '' };
};

const evidence = { headSha: SHA, command: ['smoke'], durationMs: 5, artifacts: [] as string[] };
const result = (
  status: PreviewCheckResult['status'],
  extra: Partial<PreviewCheckResult['evidence']> = {},
): PreviewCheckResult => ({
  status,
  evidence: { ...evidence, url: 'https://p.example.com', ...extra },
});

async function ship(checkRuns: any[], previewGate: (pr: any) => Promise<PreviewCheckResult>) {
  const { octokit, graphqlCalls } = createOctokit(checkRuns);
  const logs: Array<[string, string]> = [];
  vi.useFakeTimers();
  try {
    const promise = shipPhase({
      issue: workKeyFromIssue(9),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-9',
      branch: 'ship-it/9-preview',
      octokit: octokit as any,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run,
      previewGate,
    });
    await vi.runAllTimersAsync();
    return { result: await promise, logs, graphqlCalls };
  } finally {
    vi.useRealTimers();
  }
}

const green = [{ name: 'build', status: 'completed', conclusion: 'success' }];
const red = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
const pending = [{ name: 'build', status: 'in_progress', conclusion: null }];

describe('shipPhase preview gate (#3880)', () => {
  it('runs the preview gate only after a green CI watch', async () => {
    const gate = vi.fn(async () => result('pass'));
    const { result: r, logs } = await ship(green, gate);
    expect(gate).toHaveBeenCalledWith({ prNumber: 123, headSha: SHA });
    expect(r).toMatchObject({ ok: true, prNumber: 123, previewCheck: { status: 'pass' } });
    expect(
      logs.some(([t, m]) => t === 'ship' && m.includes('preview check pass for PR #123 on https://p.example.com')),
    ).toBe(true);
  });

  it('does not call the preview gate when CI fails and returns ok false', async () => {
    const gate = vi.fn(async () => result('pass'));
    const { result: r } = await ship(red, gate);
    expect(gate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, ciOutcome: 'failure' });
    expect(r.previewCheck).toBeUndefined();
  });

  it('does not call the preview gate when the CI watch times out', async () => {
    const gate = vi.fn(async () => result('pass'));
    const { result: r } = await ship(pending, gate);
    expect(gate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, ciPending: true });
  });

  it('returns ok false before mark-ready when the preview gate is not pass', async () => {
    const failed = result('fail', { exitCode: 3 });
    const { result: r, graphqlCalls } = await ship(green, async () => failed);
    expect(graphqlCalls).toEqual([]);
    expect(r).toMatchObject({
      ok: false,
      prNumber: 123,
      headSha: SHA,
      previewCheck: failed,
      reason: 'preview check fail for PR #123: exit code 3',
    });
  });

  it('uses the unavailable reason in the failure message', async () => {
    const { result: r } = await ship(green, async () => result('preview-unavailable', { reason: 'never ready' }));
    expect(r.reason).toBe('preview check preview-unavailable for PR #123: never ready');
  });

  it('turns a throwing gate into preview-unavailable', async () => {
    const { result: r, graphqlCalls } = await ship(green, async () => {
      throw new Error('gate exploded');
    });
    expect(graphqlCalls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.previewCheck?.status).toBe('preview-unavailable');
    expect(r.previewCheck?.evidence.reason).toBe('gate exploded');
  });
});
