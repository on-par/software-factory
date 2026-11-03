import { renderPreviewReceipt } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { landBaseGate } from './land-base-gate.js';
import { landOpenPullRequest } from './land-pr.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const previewPassBody = `Implements #1.\n\n${renderPreviewReceipt({
  status: 'pass',
  evidence: {
    url: 'https://p.example.com/',
    headSha: 'pr'.padEnd(40, '0'),
    command: ['npm', 'run', 'smoke'],
    exitCode: 0,
    readyWaitMs: 1000,
    commandMs: 1000,
    durationMs: 2000,
    artifacts: [],
  },
})}\n`;

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

function redMainOctokit() {
  const merge = vi.fn();
  const routes: ReadonlyArray<readonly [RegExp, () => unknown]> = [
    [
      /^GET \/repos\/o\/r\/pulls\/2$/,
      () => ({ head: { sha: 'pr' }, base: { ref: 'main' }, body: previewPassBody, merge_commit_sha: 'merge' }),
    ],
    [
      /^PUT \/repos\/o\/r\/pulls\/2\/merge$/,
      () => {
        merge();
        return { merged: true };
      },
    ],
    [/^DELETE \/repos\/o\/r\/git\/refs\//, () => ({})],
    [/^GET \/repos\/o\/r\/branches\/main$/, () => ({ commit: { sha: 'main-head' } })],
    [/\/protection\/required_status_checks$/, () => ({ contexts: ['ci'] })],
    [/^GET \/repos\/o\/r\/rules\/branches\/main$/, () => []],
    [/^GET \/repos\/o\/r\/compare\//, () => ({ status: 'ahead' })],
    [
      /^GET \/repos\/o\/r\/commits\/[^/]+\/check-runs$/,
      () => ({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }),
    ],
    [/^GET \/repos\/o\/r\/actions\/runs$/, () => ({ workflow_runs: [] })],
    [/^POST \/graphql$/, () => ({ data: { repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } } })],
  ];
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const key = `${method} ${url.pathname}`;
    const route = routes.find(([pattern]) => pattern.test(key));
    return route ? json(route[1]()) : new Response('{}', { status: 404 });
  };
  const octokit = new Octokit({ request: { fetch } });
  return { octokit, merge };
}

describe('landing after a preview pass', () => {
  it('still refuses to merge into a red main', async () => {
    const { octokit, merge } = redMainOctokit();
    const log = vi.fn();
    const baseGate = landBaseGate({ octokit, owner: 'o', repo: 'r', prNumber: 2, state: dirs.makeSync('land-'), log });
    const landing = landOpenPullRequest({
      octokit,
      owner: 'o',
      repoName: 'r',
      ghRepo: 'o/r',
      repoRoot: '/r',
      issue: 1,
      branch: 'b',
      worktree: '/w',
      prNumber: 2,
      log,
      skipCI: true,
      adminMerge: false,
      sleep: async () => {},
      run: vi.fn(),
      behindProbe: async () => false,
      baseGate,
    });
    await expect(landing).rejects.toThrow('failed');
    expect(merge).not.toHaveBeenCalled();
  });
});
