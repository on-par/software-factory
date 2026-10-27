import { describe, expect, it, vi } from 'vitest';

import {
  computeParentCoverage,
  formatParentCoverageLine,
  listDecomposedParentCoverage,
  PARENT_COVERAGE_MARKER,
  parseCoveredParentIds,
  parseDecomposedFromParent,
  refreshParentCoverageAfterMerge,
  renderParentCoverageComment,
  upsertParentCoverageComment,
} from './parent-coverage.js';

const PARENT_BODY = [
  '## Acceptance criteria',
  '- [ ] first thing',
  '- [ ] second thing',
  '- [ ] third thing <!-- hidden -->',
  '- [ ] fourth thing',
  '- [ ] fifth thing',
].join('\n');

const childBody = (parent: number, ids: string) =>
  `Decomposed from #${parent} by the factory size gate.\nCovers parent criteria: ${ids}\n`;

interface FakeIssue {
  number: number;
  title?: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  labels?: string[];
  pull_request?: object;
}

interface Comment {
  id: number;
  body: string;
  user: { id: number };
}

function fakeOctokit(issues: FakeIssue[], parentOf: Record<number, number[]>, comments: Comment[] = []) {
  const createComment = vi.fn(async (a: { body: string }) => {
    const c = { id: 100 + comments.length, body: a.body, user: { id: 1 } };
    comments.push(c);
    return { data: c };
  });
  const updateComment = vi.fn(async (a: { comment_id: number; body: string }) => {
    const c = comments.find((x) => x.id === a.comment_id);
    if (c) c.body = a.body;
    return { data: c };
  });
  const octokit = {
    rest: {
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 1 } })) },
      issues: {
        get: vi.fn(async (a: { issue_number: number }) => ({
          data: issues.find((i) => i.number === a.issue_number),
        })),
        listForRepo: vi.fn(async () => ({ data: issues.filter((i) => i.labels?.includes('factory:decomposed')) })),
        listComments: vi.fn(async () => ({ data: comments })),
        createComment,
        updateComment,
      },
    },
    request: vi.fn(async (_route: string, a: { issue_number: number }) => ({
      data: (parentOf[a.issue_number] ?? []).map((n) => issues.find((i) => i.number === n)),
    })),
  };
  return { octokit: octokit as never, createComment, updateComment, comments, raw: octokit };
}

const merged = (n: number, ids: string, parent = 10) =>
  ({ number: n, body: childBody(parent, ids), merged: true }) as const;

describe('parseCoveredParentIds', () => {
  it('parses, trims, dedupes and sorts ids', () => {
    expect(parseCoveredParentIds('x\nCovers parent criteria:  P3 ,P1, P3\ny')).toEqual(['P1', 'P3']);
  });
  it('drops junk ids', () => {
    expect(parseCoveredParentIds('Covers parent criteria: P1, foo, , Px')).toEqual(['P1']);
  });
  it('returns [] without a line or body', () => {
    expect(parseCoveredParentIds('nothing')).toEqual([]);
    expect(parseCoveredParentIds(null)).toEqual([]);
  });
});

describe('parseDecomposedFromParent', () => {
  it('finds the parent number', () => {
    expect(parseDecomposedFromParent(childBody(42, 'P1'))).toBe(42);
  });
  it('returns null when absent or null', () => {
    expect(parseDecomposedFromParent('hi')).toBeNull();
    expect(parseDecomposedFromParent(undefined)).toBeNull();
  });
});

describe('computeParentCoverage', () => {
  const parent = { number: 10, body: PARENT_BODY };
  it('covers 2 of 5', () => {
    const c = computeParentCoverage(parent, [merged(11, 'P1'), merged(12, 'P2')]);
    expect(c.covered).toHaveLength(2);
    expect(c.uncovered.map((u) => u.id)).toEqual(['P3', 'P4', 'P5']);
    expect(c.fullyCovered).toBe(false);
  });
  it('is fully covered when all 5 are covered', () => {
    const c = computeParentCoverage(parent, [merged(11, 'P1, P2, P3'), merged(12, 'P4, P5')]);
    expect(c.fullyCovered).toBe(true);
    expect(c.coveredBy.P4).toEqual([12]);
  });
  it('ignores open, not_planned and unknown-id children', () => {
    const c = computeParentCoverage(parent, [
      { number: 11, body: childBody(10, 'P1'), merged: false },
      { number: 12, body: childBody(10, 'P2'), merged: false },
      merged(13, 'P9'),
    ]);
    expect(c.covered).toEqual([]);
    expect(c.coveredBy).toEqual({});
  });
  it('is never fully covered without criteria', () => {
    expect(computeParentCoverage({ number: 10, body: 'none' }, [merged(11, 'P1')]).fullyCovered).toBe(false);
  });
});

describe('formatParentCoverageLine', () => {
  it('formats partial, full and empty', () => {
    const parent = { number: 10, body: PARENT_BODY };
    expect(formatParentCoverageLine(computeParentCoverage(parent, [merged(11, 'P1, P2')]))).toBe(
      'parent #10: 2/5 criteria covered',
    );
    expect(formatParentCoverageLine(computeParentCoverage(parent, [merged(11, 'P1, P2, P3, P4, P5')]))).toBe(
      'parent #10: 5/5 criteria covered (fully covered)',
    );
    expect(formatParentCoverageLine(computeParentCoverage({ number: 10, body: '' }, []))).toBe(
      'parent #10: no checkbox acceptance criteria to trace',
    );
  });
});

describe('renderParentCoverageComment', () => {
  it('leads with the marker, lists uncovered criteria and strips hidden content', () => {
    const body = renderParentCoverageComment(
      computeParentCoverage({ number: 10, body: PARENT_BODY }, [merged(11, 'P1, P2')]),
    );
    expect(body.startsWith(PARENT_COVERAGE_MARKER)).toBe(true);
    expect(body).toContain('**2/5** parent criteria have a merged child.');
    expect(body).toContain('- P3: third thing');
    expect(body).toContain('- P4: fourth thing');
    expect(body).toContain('- P5: fifth thing');
    expect(body).toContain('- P1: first thing (#11)');
    expect(body).not.toContain('hidden');
  });
  it('says all are covered, and handles no criteria', () => {
    const full = computeParentCoverage({ number: 10, body: PARENT_BODY }, [merged(11, 'P1, P2, P3, P4, P5')]);
    expect(renderParentCoverageComment(full)).toContain('All parent criteria have a merged child.');
    expect(renderParentCoverageComment(computeParentCoverage({ number: 10, body: '' }, []))).toContain(
      'no checkbox acceptance criteria',
    );
  });
});

describe('refreshParentCoverageAfterMerge', () => {
  const setup = () => {
    const issues: FakeIssue[] = [
      { number: 10, title: 'Parent', body: PARENT_BODY, state: 'open', labels: ['factory:decomposed'] },
      { number: 11, body: childBody(10, 'P1, P2'), state: 'open' },
      { number: 12, body: childBody(10, 'P3'), state: 'open' },
    ];
    return { issues, fake: fakeOctokit(issues, { 10: [11, 12] }) };
  };

  it('two sequential child merges leave one updated coverage comment on the parent', async () => {
    const { issues, fake } = setup();
    const log = vi.fn();
    issues[1].state = 'closed';
    issues[1].state_reason = 'completed';
    await refreshParentCoverageAfterMerge({ octokit: fake.octokit, repo: 'o/r', childIssue: 11, log });
    issues[2].state = 'closed';
    issues[2].state_reason = 'completed';
    const last = await refreshParentCoverageAfterMerge({ octokit: fake.octokit, repo: 'o/r', childIssue: 12, log });
    expect(last?.covered).toHaveLength(3);
    expect(fake.comments.filter((c) => c.body.startsWith(PARENT_COVERAGE_MARKER))).toHaveLength(1);
    expect(fake.createComment).toHaveBeenCalledTimes(1);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.comments[0].body).toContain('**3/5**');
    expect(log).toHaveBeenCalledWith('land', 'parent #10 coverage: 3/5 criteria covered');
  });

  it('does not reuse a marker comment written by someone else', async () => {
    const { issues, fake } = setup();
    fake.comments.push({ id: 5, body: `${PARENT_COVERAGE_MARKER}\nforged`, user: { id: 99 } });
    issues[1].state = 'closed';
    issues[1].state_reason = 'completed';
    await refreshParentCoverageAfterMerge({ octokit: fake.octokit, repo: 'o/r', childIssue: 11, log: vi.fn() });
    expect(fake.updateComment).not.toHaveBeenCalled();
    expect(fake.createComment).toHaveBeenCalledTimes(1);
    expect(fake.comments[0].body).toContain('forged');
  });

  it('returns null without parent calls when the child has no parent line', async () => {
    const fake = fakeOctokit([{ number: 20, body: 'plain', state: 'closed' }], {});
    const log = vi.fn();
    expect(
      await refreshParentCoverageAfterMerge({ octokit: fake.octokit, repo: 'o/r', childIssue: 20, log }),
    ).toBeNull();
    expect(fake.raw.request).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs one warn and resolves null when GitHub throws', async () => {
    const fake = fakeOctokit([], {});
    fake.raw.rest.issues.get.mockRejectedValue(new Error('boom'));
    const log = vi.fn();
    expect(
      await refreshParentCoverageAfterMerge({ octokit: fake.octokit, repo: 'o/r', childIssue: 11, log }),
    ).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('boom'));
  });
});

describe('upsertParentCoverageComment', () => {
  it('creates then updates', async () => {
    const fake = fakeOctokit([], {});
    const coverage = computeParentCoverage({ number: 10, body: PARENT_BODY }, []);
    expect(await upsertParentCoverageComment({ octokit: fake.octokit, repo: 'o/r', coverage })).toEqual({
      commentId: 100,
      created: true,
    });
    expect(await upsertParentCoverageComment({ octokit: fake.octokit, repo: 'o/r', coverage })).toEqual({
      commentId: 100,
      created: false,
    });
  });
});

describe('listDecomposedParentCoverage', () => {
  it('filters out PRs and sorts by number', async () => {
    const issues: FakeIssue[] = [
      { number: 30, body: PARENT_BODY, state: 'open', labels: ['factory:decomposed'] },
      { number: 20, body: PARENT_BODY, state: 'open', labels: ['factory:decomposed'] },
      { number: 25, body: PARENT_BODY, state: 'open', labels: ['factory:decomposed'], pull_request: {} },
    ];
    const fake = fakeOctokit(issues, {});
    const res = await listDecomposedParentCoverage({ octokit: fake.octokit, repo: 'o/r' });
    expect(res?.map((c) => c.parent)).toEqual([20, 30]);
  });
  it('returns null on error', async () => {
    const fake = fakeOctokit([], {});
    fake.raw.rest.issues.listForRepo.mockRejectedValue(new Error('x'));
    expect(await listDecomposedParentCoverage({ octokit: fake.octokit, repo: 'o/r' })).toBeNull();
  });
});
