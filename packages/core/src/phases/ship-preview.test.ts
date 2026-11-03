import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import { PREVIEW_RECEIPT_START } from '../checkers/preview-receipt.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { workKeyFromIssue } from '../work/work-key.js';
import type { PreviewGate } from './ship-preview.js';
import { shipPhase } from './ship.js';

const SHA = 'a'.repeat(40);
const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

function createOctokit(checkRuns: CheckRun[]) {
  const graphqlCalls: string[] = [];
  const bodyUpdates: string[] = [];
  const rest = {
    pulls: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: { number: 123 } }),
      get: async () => ({ data: { draft: true, node_id: 'PR_1', body: 'Implements #9.' } }),
      update: async ({ body }: { body: string }) => {
        bodyUpdates.push(body);
        return { data: {} };
      },
    },
    issues: {
      get: async () => ({ data: { title: 'Preview' } }),
      createComment: async () => ({ data: { id: 1 } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: checkRuns } }) },
    repos: { getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: SHA } }) },
  };
  const graphql = async (query: string) => {
    graphqlCalls.push(query);
    return {};
  };
  const octokit: Octokit = Object.assign(Object.create(null), { graphql, rest });
  return { octokit, graphqlCalls, bodyUpdates, rest };
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

const evidence = { headSha: SHA, command: ['smoke'], readyWaitMs: 3000, commandMs: 2000, durationMs: 5000 };
const result = (
  status: PreviewCheckResult['status'],
  extra: Partial<PreviewCheckResult['evidence']> = {},
): PreviewCheckResult => ({
  status,
  evidence: { ...evidence, artifacts: [], url: 'https://p.example.com/', ...extra },
});

async function ship(
  checkRuns: CheckRun[],
  previewGate: PreviewGate,
  logsDir?: string,
  fake = createOctokit(checkRuns),
) {
  const logs: Array<[string, string]> = [];
  vi.useFakeTimers();
  try {
    const promise = shipPhase({
      issue: workKeyFromIssue(9),
      repo: 'on-par/software-factory',
      worktree: '/repo-factory-9',
      branch: 'ship-it/9-preview',
      octokit: fake.octokit,
      watchCI: true,
      log: (type, msg) => logs.push([type, msg]),
      run,
      previewGate,
      ...(logsDir ? { logsDir } : {}),
    });
    await vi.runAllTimersAsync();
    return { result: await promise, logs, ...fake };
  } finally {
    vi.useRealTimers();
  }
}

const green: CheckRun[] = [{ name: 'build', status: 'completed', conclusion: 'success' }];
const red: CheckRun[] = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
const pending: CheckRun[] = [{ name: 'build', status: 'in_progress', conclusion: null }];

describe('shipPhase preview gate (#3880)', () => {
  it('runs the preview gate only after a green CI watch and logs both timings', async () => {
    const gate = vi.fn<PreviewGate>(async () => result('pass'));
    const { result: r, logs } = await ship(green, gate);
    expect(gate).toHaveBeenCalledWith({ prNumber: 123, headSha: SHA });
    expect(r).toMatchObject({ ok: true, prNumber: 123, previewCheck: { status: 'pass' } });
    expect(logs).toContainEqual([
      'ship',
      `preview check pass for PR #123 on https://p.example.com/ (${SHA.slice(0, 12)}; ready wait 3.0s, command 2.0s)`,
    ]);
  });

  it('masks the query string of the preview URL in the log', async () => {
    const { logs } = await ship(green, async () => result('pass', { url: 'https://p.example.com/?token=secret' }));
    expect(logs.some(([, m]) => m.includes('https://p.example.com/?***'))).toBe(true);
    expect(logs.some(([, m]) => m.includes('secret'))).toBe(false);
  });

  it('writes the preview result into the PR body', async () => {
    const { bodyUpdates } = await ship(green, async () => result('pass'));
    expect(bodyUpdates).toHaveLength(1);
    expect(bodyUpdates[0]).toContain('Implements #9.');
    expect(bodyUpdates[0]).toContain(PREVIEW_RECEIPT_START);
    expect(bodyUpdates[0]).toContain('**Result: pass**');
  });

  it('still reports the verdict when the PR body cannot be updated', async () => {
    const fake = createOctokit(green);
    fake.rest.pulls.update = async () => {
      throw new Error('forbidden');
    };
    const { result: r, logs } = await ship(green, async () => result('pass'), undefined, fake);
    expect(r).toMatchObject({ ok: true, previewCheck: { status: 'pass' } });
    expect(logs).toContainEqual(['warn', 'could not write the preview result to PR #123: forbidden']);
  });

  it('does not call the preview gate when CI fails and returns ok false', async () => {
    const gate = vi.fn<PreviewGate>(async () => result('pass'));
    const { result: r } = await ship(red, gate);
    expect(gate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, ciOutcome: 'failure' });
    expect(r.previewCheck).toBeUndefined();
  });

  it('fails closed as preview-unavailable while CI is still pending, leaving the PR a draft', async () => {
    const gate = vi.fn<PreviewGate>(async () => result('pass'));
    const { result: r, graphqlCalls } = await ship(pending, gate);
    expect(gate).not.toHaveBeenCalled();
    expect(graphqlCalls).toEqual([]);
    expect(r).toMatchObject({
      ok: false,
      ciPending: true,
      draft: true,
      previewCheck: { status: 'preview-unavailable', evidence: { reason: 'CI pending, preview not checked' } },
      reason: 'preview check preview-unavailable for PR #123: CI pending, preview not checked',
    });
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

  it('turns a throwing gate into preview-unavailable and still writes the evidence file', async () => {
    const logsDir = tempDirs.makeSync('ship-preview-');
    const { result: r, graphqlCalls } = await ship(
      green,
      async () => {
        throw new Error('gate exploded');
      },
      logsDir,
    );
    expect(graphqlCalls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.previewCheck).toMatchObject({
      status: 'preview-unavailable',
      evidence: { reason: 'gate exploded', evidencePath: join(logsDir, 'preview-check.json') },
    });
    expect(existsSync(join(logsDir, 'preview-check.json'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(logsDir, 'preview-check.json'), 'utf8'));
    expect(saved).toMatchObject({ status: 'preview-unavailable', evidence: { reason: 'gate exploded' } });
  });
});
