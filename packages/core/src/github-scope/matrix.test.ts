import { describe, expect, it } from 'vitest';
import { isMergeRequest, PHASE_GITHUB_SCOPES, scopeForPhase, type GitHubPhase } from './matrix.js';

describe('github phase scope matrix', () => {
  it('plan scope grants read issues and contents and write issue comments and labels only', () => {
    const scope = scopeForPhase('plan');
    expect(scope?.permissions).toEqual({ metadata: 'read', contents: 'read', issues: 'write', pull_requests: 'read' });
    expect(scope?.writesLimitedToIssues).toBe(true);
  });

  it('build phase has no GitHub credential', () => {
    expect(scopeForPhase('build')).toBeNull();
  });

  it('unknown phases have no credential', () => {
    expect(scopeForPhase('deploy' as GitHubPhase)).toBeNull();
  });

  it('ship scope grants contents and pull request write and no administration', () => {
    const permissions = scopeForPhase('ship')?.permissions ?? {};
    expect(permissions.contents).toBe('write');
    expect(permissions.pull_requests).toBe('write');
    expect(Object.keys(permissions)).not.toContain('administration');
    expect(Object.keys(permissions)).not.toContain('workflows');
  });

  it('only the land phase may merge', () => {
    const mergeable = Object.values(PHASE_GITHUB_SCOPES)
      .filter((scope) => scope !== null && scope.mayMerge)
      .map((scope) => scope?.phase);
    expect(mergeable).toEqual(['land']);
    expect(scopeForPhase('land')?.permissions).toEqual(scopeForPhase('ship')?.permissions);
  });
});

describe('isMergeRequest', () => {
  it('detects the templated REST merge route', () => {
    expect(isMergeRequest('PUT', '/repos/{owner}/{repo}/pulls/{pull_number}/merge')).toBe(true);
  });

  it('detects a concrete REST merge url', () => {
    expect(isMergeRequest('put', 'https://api.github.com/repos/o/r/pulls/12/merge')).toBe(true);
  });

  it('detects graphql merge mutations', () => {
    const body = { query: 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }' };
    expect(isMergeRequest('POST', '/graphql', body)).toBe(true);
    expect(
      isMergeRequest('POST', '/graphql', { query: 'mutation { enablePullRequestAutoMerge(input: {}) { x } }' }),
    ).toBe(true);
  });

  it('ignores a non-merge PUT, a graphql read and a GET on the merge route', () => {
    expect(isMergeRequest('PUT', '/repos/o/r/pulls/12/update-branch')).toBe(false);
    expect(isMergeRequest('POST', '/graphql', { query: 'query { viewer { login } }' })).toBe(false);
    expect(isMergeRequest('GET', '/repos/o/r/pulls/12/merge')).toBe(false);
    expect(isMergeRequest('POST', '/graphql')).toBe(false);
  });
});
