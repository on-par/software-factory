import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { toWorkKey } from '../work/work-key.js';
import { findOwnParkComment, issueStateMarker, parkUnblockHint } from './park-comment.js';

describe('non-numeric work keys', () => {
  const key = toWorkKey('PROJ-12');

  it('render into the marker and hint without a number', () => {
    expect(issueStateMarker(key)).toBe('<!-- factory-issue-state v1 issue:PROJ-12 -->');
    expect(parkUnblockHint('fail', key)).toContain('PROJ-12');
  });

  it('are rejected at the Octokit boundary before any listComments call', async () => {
    const listComments = vi.fn(async () => ({ data: [] }));
    const octokit = Object.assign({} as Octokit, {
      rest: { users: { getAuthenticated: vi.fn(async () => ({ data: { id: 1 } })) }, issues: { listComments } },
    });
    await expect(findOwnParkComment({ octokit, repo: 'o/r', issue: key })).rejects.toThrow(/not a numeric/);
    expect(listComments).not.toHaveBeenCalled();
  });
});
