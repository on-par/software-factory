import { describe, expect, it } from 'vitest';

import {
  describePullRequestAccessError,
  formatPullRequestReference,
  parsePullRequestReference,
  resolvePullRequestReference,
  REVIEW_ACCESS_ERROR_EXIT_CODE,
} from './pr-reference.js';

describe('parsePullRequestReference', () => {
  it('parses a bare number and #number', () => {
    expect(parsePullRequestReference('42')).toEqual({ ok: true, ref: { repo: null, number: 42 } });
    expect(parsePullRequestReference(' #42 ')).toEqual({ ok: true, ref: { repo: null, number: 42 } });
  });

  it.each([
    ['owner/repo#42', 'owner/repo', 42],
    ['my-org/my.repo_x#7', 'my-org/my.repo_x', 7],
  ])('parses shorthand %s', (input, repo, number) => {
    expect(parsePullRequestReference(input)).toEqual({ ok: true, ref: { repo, number } });
  });

  it.each([
    'https://github.com/owner/repo/pull/42',
    'https://www.github.com/owner/repo/pull/42',
    'https://github.com/owner/repo/pull/42/',
    'https://github.com/owner/repo/pull/42/files',
    'https://github.com/owner/repo/pull/42?diff=split',
    'https://github.com/owner/repo/pull/42#discussion_r1',
    'http://github.com/owner/repo/pull/42',
    'https://GITHUB.COM/owner/repo/pull/42',
  ])('parses URL %s', (input) => {
    expect(parsePullRequestReference(input)).toEqual({ ok: true, ref: { repo: 'owner/repo', number: 42 } });
  });

  it('keeps owner/name casing from a URL', () => {
    expect(parsePullRequestReference('https://github.com/On-Par/Repo/pull/1')).toEqual({
      ok: true,
      ref: { repo: 'On-Par/Repo', number: 1 },
    });
  });

  it.each([
    '',
    'abc',
    '0',
    '-1',
    '1.5',
    'owner/repo',
    'owner/repo#',
    'owner#1',
    'owner/repo#0',
    '99999999999999999999',
    'https://github.com/owner/repo/issues/4',
    'https://github.com/owner/repo/pull/abc',
    'https://github.com/-bad-/repo/pull/4',
  ])('rejects malformed input %j naming all three forms', (input) => {
    const result = parsePullRequestReference(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('a number');
      expect(result.error).toContain('owner/repo#N');
      expect(result.error).toContain('https://github.com/owner/repo/pull/N');
    }
  });

  it.each(['https://gitlab.com/o/r/-/merge_requests/1', 'https://bitbucket.org/o/r/pull-requests/1'])(
    'rejects non-GitHub host %s',
    (input) => {
      expect(parsePullRequestReference(input)).toEqual({
        ok: false,
        error: `only github.com pull request URLs are supported: ${input}`,
      });
    },
  );
});

describe('resolvePullRequestReference', () => {
  it('resolves a bare number against the current repo', () => {
    expect(resolvePullRequestReference({ repo: null, number: 5 }, 'me/here')).toEqual({
      repo: 'me/here',
      number: 5,
      display: 'me/here#5',
    });
  });

  it('errors on a bare number without a current repo', () => {
    const result = resolvePullRequestReference({ repo: null, number: 5 }, null);
    expect(result).toHaveProperty('error');
  });

  it('ignores the current repo for an explicit repo', () => {
    expect(resolvePullRequestReference({ repo: 'other/repo', number: 9 }, 'me/here')).toEqual({
      repo: 'other/repo',
      number: 9,
      display: 'other/repo#9',
    });
  });
});

describe('formatPullRequestReference', () => {
  it('formats owner/repo#N', () => {
    expect(formatPullRequestReference('o/r', 3)).toBe('o/r#3');
  });
});

describe('describePullRequestAccessError', () => {
  const pr = { repo: 'o/r', number: 3, display: 'o/r#3' };

  it('names the PR and the detail', () => {
    const message = describePullRequestAccessError(pr, 'Not Found');
    expect(message).toContain('o/r#3');
    expect(message).toContain('Not Found');
  });

  it('falls back to access denied for a blank detail', () => {
    expect(describePullRequestAccessError(pr, '  ')).toContain('access denied');
  });

  it('uses exit code 2', () => {
    expect(REVIEW_ACCESS_ERROR_EXIT_CODE).toBe(2);
  });
});
