import { describe, expect, it } from 'vitest';

import { createFakeGitHub } from '../fakes/fake-github.js';
import { createOctokitPreviewGitHub } from './preview-source-octokit.js';

const SHA = 'abc1234'.padEnd(40, 'f');
const target = { owner: 'o', repo: 'r', prNumber: 7, headSha: SHA };

function previewRepo() {
  return createFakeGitHub([
    [
      'GET /repos/o/r/issues/7/comments',
      () => [{ body: 'hi', user: { login: 'bot' }, author_association: 'NONE', created_at: 'c', updated_at: 'u' }],
    ],
    ['GET /repos/o/r/deployments', () => [{ id: 5, environment: 'preview/pr-7', created_at: 'c' }]],
    [
      'GET /repos/o/r/deployments/5/statuses',
      () => [{ state: 'success', created_at: 'c', environment_url: 'https://e.example.com', target_url: '' }],
    ],
    [`GET /repos/o/r/commits/${SHA}`, () => ({ commit: { committer: { date: '2026-01-02T00:00:00Z' } } })],
  ]);
}

describe('createOctokitPreviewGitHub', () => {
  it('maps PR comments to author, association and timestamps, 100 per page', async () => {
    const { octokit, requests } = previewRepo();
    expect(await createOctokitPreviewGitHub(octokit).listComments(target)).toEqual([
      { body: 'hi', author: 'bot', authorAssociation: 'NONE', createdAt: 'c', updatedAt: 'u' },
    ]);
    expect(requests[0]?.query.get('per_page')).toBe('100');
  });

  it('lists the deployments made for the head SHA', async () => {
    const { octokit, requests } = previewRepo();
    expect(await createOctokitPreviewGitHub(octokit).listDeployments(target)).toEqual([
      { id: 5, environment: 'preview/pr-7', createdAt: 'c' },
    ]);
    expect(requests[0]?.query.get('sha')).toBe(SHA);
  });

  it('maps deployment statuses to state, time and both URLs', async () => {
    const { octokit } = previewRepo();
    expect(await createOctokitPreviewGitHub(octokit).listDeploymentStatuses(target, 5)).toEqual([
      { state: 'success', createdAt: 'c', environmentUrl: 'https://e.example.com', targetUrl: '' },
    ]);
  });

  it('reads the head commit date from the committer', async () => {
    const { octokit } = previewRepo();
    expect(await createOctokitPreviewGitHub(octokit).headCommitDate(target)).toBe('2026-01-02T00:00:00Z');
  });
});
