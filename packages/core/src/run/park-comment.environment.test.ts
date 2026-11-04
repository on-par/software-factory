import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { EnvironmentFailure } from '../phases/check.js';
import { renderEnvironmentReleaseComment } from '../phases/environment-release.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { environmentReleaseMarker, postEnvironmentReleaseComment } from './park-comment.js';

const K7 = workKeyFromIssue(7);
const env: EnvironmentFailure = { baseSha: 'abc123', failingChecks: ['tests'], cause: 'environment', logPaths: [] };

function fakeOctokit(createComment: (args: { body: string }) => Promise<{ data: { id: number } }>) {
  const create = vi.fn(createComment);
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 99 } })) },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment: create, updateComment: vi.fn() },
    },
  });
  return { octokit, create };
}

describe('postEnvironmentReleaseComment', () => {
  it('posts the rendered environment-failure comment with its marker', async () => {
    const { octokit, create } = fakeOctokit(async () => ({ data: { id: 1 } }));
    const warn = vi.fn();
    await postEnvironmentReleaseComment({ octokit, repo: 'o/r', issue: K7, env, warn });
    const marker = environmentReleaseMarker(K7);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: `${renderEnvironmentReleaseComment(env)}\n${marker}` }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when GitHub rejects the comment', async () => {
    const { octokit } = fakeOctokit(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    await expect(
      postEnvironmentReleaseComment({ octokit, repo: 'o/r', issue: K7, env, warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('could not post the environment-failure comment: boom');
  });
});
