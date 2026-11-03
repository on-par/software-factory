import { describe, expect, it } from 'vitest';

import { createFakeGitHub, githubError } from './fake-github.js';

describe('createFakeGitHub', () => {
  it('answers a real Octokit call from the matching route and records the request', async () => {
    const { octokit, requests } = createFakeGitHub([['PATCH /repos/o/r/pulls/5', () => ({ number: 5 })]]);
    const { data } = await octokit.rest.pulls.update({ owner: 'o', repo: 'r', pull_number: 5, body: 'hi' });
    expect(data.number).toBe(5);
    expect(requests).toMatchObject([{ method: 'PATCH', path: '/repos/o/r/pulls/5', body: { body: 'hi' } }]);
  });

  it('matches a route by regular expression and exposes the query string', async () => {
    const { octokit, requests } = createFakeGitHub([[/^GET \/repos\/o\/r\/issues\/\d+\/comments$/, () => []]]);
    await octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 7, per_page: 100 });
    expect(requests[0]?.query.get('per_page')).toBe('100');
    expect(requests[0]?.body).toBeUndefined();
  });

  it('answers an unrouted call with a GitHub 404', async () => {
    const { octokit } = createFakeGitHub([]);
    await expect(octokit.rest.issues.get({ owner: 'o', repo: 'r', issue_number: 1 })).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    });
  });

  it('passes a scripted error response through', async () => {
    const { octokit } = createFakeGitHub([['GET /repos/o/r/pulls/5', () => githubError(403, 'forbidden')]]);
    await expect(octokit.rest.pulls.get({ owner: 'o', repo: 'r', pull_number: 5 })).rejects.toMatchObject({
      status: 403,
      message: 'forbidden',
    });
  });
});
