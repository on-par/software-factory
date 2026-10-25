import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { toWorkKey, workKeyFromIssue } from '../work/work-key.js';
import { designCheckpointMessage, NEEDS_DESIGN_LABEL, readNeedsDesignLabel } from './design-checkpoint.js';

function octokitWith(get: () => Promise<{ data: { labels: unknown[] } }>): Octokit {
  return Object.assign({} as Octokit, { rest: { issues: { get: vi.fn(get) } } });
}

describe('readNeedsDesignLabel', () => {
  it('is present for a label object', async () => {
    const o = octokitWith(async () => ({ data: { labels: [{ name: NEEDS_DESIGN_LABEL }] } }));
    expect(await readNeedsDesignLabel(o, 'o/r', workKeyFromIssue(1))).toEqual({ present: true });
    expect(o.rest.issues.get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 1 });
  });

  it('is present for a string label', async () => {
    const o = octokitWith(async () => ({ data: { labels: ['bug', NEEDS_DESIGN_LABEL] } }));
    expect((await readNeedsDesignLabel(o, 'o/r', workKeyFromIssue(1))).present).toBe(true);
  });

  it('is present for a mixed-case label with whitespace', async () => {
    const o = octokitWith(async () => ({ data: { labels: [{ name: ' Factory:Needs-Design ' }] } }));
    expect((await readNeedsDesignLabel(o, 'o/r', workKeyFromIssue(1))).present).toBe(true);
  });

  it('is absent for an empty list and for a nameless label', async () => {
    expect(
      (
        await readNeedsDesignLabel(
          octokitWith(async () => ({ data: { labels: [] } })),
          'o/r',
          workKeyFromIssue(1),
        )
      ).present,
    ).toBe(false);
    expect(
      (
        await readNeedsDesignLabel(
          octokitWith(async () => ({ data: { labels: [{}] } })),
          'o/r',
          workKeyFromIssue(1),
        )
      ).present,
    ).toBe(false);
  });

  it('returns the error message when issues.get throws', async () => {
    const o = octokitWith(async () => {
      throw new Error('boom');
    });
    expect(await readNeedsDesignLabel(o, 'o/r', workKeyFromIssue(1))).toEqual({ present: false, error: 'boom' });
  });
});

describe('readNeedsDesignLabel with a non-numeric key', () => {
  it('fails open with an error and never calls issues.get', async () => {
    const o = octokitWith(async () => ({ data: { labels: [] } }));
    const result = await readNeedsDesignLabel(o, 'o/r', toWorkKey('PROJ-1'));
    expect(result.present).toBe(false);
    expect(result.error).toContain('PROJ-1');
    expect(o.rest.issues.get).not.toHaveBeenCalled();
  });
});

describe('designCheckpointMessage', () => {
  it('names the label, the plan artifact, the branch and the approval steps', () => {
    const msg = designCheckpointMessage({
      key: workKeyFromIssue(42),
      specPath: '/wt/plans/issue-42.md',
      branch: 'issue-42-x',
    });
    expect(msg).toContain('factory:needs-design');
    expect(msg).toContain('/wt/plans/issue-42.md');
    expect(msg).toContain('issue-42-x');
    expect(msg).toContain('remove the factory:needs-design label');
    expect(msg).toContain('factory unpark 42');
  });
});
