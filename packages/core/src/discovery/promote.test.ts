import { describe, expect, it } from 'vitest';

import type { DraftStory, EpicView } from './promote.js';
import {
  advanceDraftEpic,
  ARCHIVED_MARKER,
  classifyLifecycle,
  ensureMarker,
  isFactoryComment,
  parseCycleTime,
  PROMOTED_MARKER,
  READY_LABEL,
  renderStoryBody,
  renderStoryChecklist,
  seedStories,
  setCycleMarker,
  storyMarker,
  upsertSection,
} from './promote.js';

interface FakeRunOpts {
  view?: {
    number: number;
    title: string;
    body: string;
    labels?: string[];
    comments?: Array<{ author: string; body: string; createdAt: string }>;
  };
  viewOk?: boolean;
  existingChildren?: Array<{ number: number; title: string; body: string }>;
  existingLabels?: string[];
  createOk?: boolean;
  createUrl?: string;
}

function fakeRun(opts: FakeRunOpts) {
  const calls: (readonly string[])[] = [];
  let createCounter = 500;
  const run = async (argv: readonly string[]) => {
    calls.push(argv);
    if (argv[1] === 'issue' && argv[2] === 'view') {
      if (opts.viewOk === false) return { stdout: 'boom', ok: false };
      const v = opts.view!;
      return {
        stdout: JSON.stringify({
          number: v.number,
          title: v.title,
          body: v.body,
          labels: (v.labels ?? []).map((name) => ({ name })),
          comments: (v.comments ?? []).map((c) => ({
            author: { login: c.author },
            body: c.body,
            createdAt: c.createdAt,
          })),
        }),
        ok: true,
      };
    }
    if (argv[1] === 'label' && argv[2] === 'list') {
      return { stdout: JSON.stringify((opts.existingLabels ?? []).map((name) => ({ name }))), ok: true };
    }
    if (argv[1] === 'label' && argv[2] === 'create') {
      return { stdout: '', ok: true };
    }
    if (argv[1] === 'issue' && argv[2] === 'list') {
      return { stdout: JSON.stringify(opts.existingChildren ?? []), ok: true };
    }
    if (argv[1] === 'issue' && argv[2] === 'create') {
      if (opts.createOk === false) return { stdout: 'boom', ok: false };
      createCounter += 1;
      return { stdout: opts.createUrl ?? `https://github.com/o/r/issues/${createCounter}`, ok: true };
    }
    if (argv[1] === 'issue' && argv[2] === 'edit') {
      return { stdout: '', ok: true };
    }
    if (argv[1] === 'issue' && argv[2] === 'close') {
      return { stdout: '', ok: true };
    }
    return { stdout: '', ok: true };
  };
  return { run, calls };
}

function findCall(calls: (readonly string[])[], sub1: string, sub2: string): readonly string[] | undefined {
  return calls.find((c) => c[1] === sub1 && c[2] === sub2);
}

function findCalls(calls: (readonly string[])[], sub1: string, sub2: string): (readonly string[])[] {
  return calls.filter((c) => c[1] === sub1 && c[2] === sub2);
}

function flagValue(call: readonly string[], flag: string): string | undefined {
  const idx = call.indexOf(flag);
  return idx === -1 ? undefined : call[idx + 1];
}

describe('classifyLifecycle', () => {
  it('wontfix -> archive', () => {
    expect(classifyLifecycle(['wontfix'])).toBe('archive');
  });
  it('validated (no wontfix) -> promote', () => {
    expect(classifyLifecycle(['validated'])).toBe('promote');
  });
  it('validated + wontfix -> archive (precedence)', () => {
    expect(classifyLifecycle(['validated', 'wontfix'])).toBe('archive');
  });
  it('only exploring -> refine', () => {
    expect(classifyLifecycle(['status:exploring'])).toBe('refine');
  });
});

describe('isFactoryComment', () => {
  it('marker body -> true', () => {
    expect(isFactoryComment('hello <!-- factory:cycle="x" -->')).toBe(true);
  });
  it('"Owner review needed" -> true', () => {
    expect(isFactoryComment('📌 **Owner review needed**')).toBe(true);
  });
  it('plain owner comment -> false', () => {
    expect(isFactoryComment('Yes, this is worth doing.')).toBe(false);
  });
});

describe('parseCycleTime / setCycleMarker', () => {
  it('parseCycleTime returns undefined when absent', () => {
    expect(parseCycleTime('no marker here')).toBeUndefined();
  });
  it('parseCycleTime returns the captured ISO string', () => {
    expect(parseCycleTime('body\n\n<!-- factory:cycle="2026-01-01T00:00:00.000Z" -->')).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
  it('setCycleMarker appends when absent', () => {
    const result = setCycleMarker('body text', '2026-02-02T00:00:00.000Z');
    expect(result).toContain('body text');
    expect(result).toContain('<!-- factory:cycle="2026-02-02T00:00:00.000Z" -->');
  });
  it('setCycleMarker replaces an existing marker', () => {
    const before = 'body\n\n<!-- factory:cycle="2026-01-01T00:00:00.000Z" -->';
    const result = setCycleMarker(before, '2026-02-02T00:00:00.000Z');
    expect(result).not.toContain('2026-01-01T00:00:00.000Z');
    expect(result).toContain('2026-02-02T00:00:00.000Z');
  });
});

describe('ensureMarker', () => {
  it('appends when absent', () => {
    expect(ensureMarker('body', PROMOTED_MARKER)).toBe(`body\n\n${PROMOTED_MARKER}`);
  });
  it('returns unchanged when already present', () => {
    const body = `body\n\n${PROMOTED_MARKER}`;
    expect(ensureMarker(body, PROMOTED_MARKER)).toBe(body);
  });
});

describe('upsertSection', () => {
  it('appends a new section when the heading is absent', () => {
    const result = upsertSection('## Hypothesis\nsomething', '## Stories', '- [ ] #1 — Title');
    expect(result).toContain('## Stories');
    expect(result).toContain('- [ ] #1 — Title');
  });
  it('replaces content up to the next heading', () => {
    const before = '## Stories\n\nold content\n\n## Other\n\nunrelated';
    const result = upsertSection(before, '## Stories', 'new content');
    expect(result).toContain('new content');
    expect(result).not.toContain('old content');
    expect(result).toContain('## Other');
    expect(result).toContain('unrelated');
  });
  it('replaces content to EOF when no following heading exists', () => {
    const before = '## Stories\n\nold content';
    const result = upsertSection(before, '## Stories', 'new content');
    expect(result).toContain('new content');
    expect(result).not.toContain('old content');
  });
});

describe('renderStoryBody', () => {
  const story: DraftStory = {
    title: 'Ship the smallest slice',
    role: 'product owner',
    want: 'a minimal slice',
    soThat: 'we validate the idea',
    investNote: 'Independent, Small, Testable',
    scenarios: [
      {
        name: 'Slice ships',
        given: ['the validated Epic #10'],
        when: ['the slice is implemented'],
        then: ['it passes', 'it merges'],
      },
    ],
  };

  it('renders all required sections', () => {
    const body = renderStoryBody(story, 10);
    expect(body).toContain('## User Story');
    expect(body).toContain('As a product owner, I want a minimal slice, so that we validate the idea.');
    expect(body).toContain('**INVEST check:** Independent, Small, Testable');
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('Scenario: Slice ships');
    expect(body).toContain('  Given the validated Epic #10');
    expect(body).toContain('  When the slice is implemented');
    expect(body).toContain('  Then it passes');
    expect(body).toContain('  And it merges');
    expect(body).toContain('Epic: #10');
    expect(body).toContain(storyMarker(10, 'ship-the-smallest-slice'));
  });

  it('omits the INVEST line when investNote is absent', () => {
    const noInvest: DraftStory = { ...story, investNote: undefined };
    const body = renderStoryBody(noInvest, 10);
    expect(body).not.toContain('**INVEST check:**');
  });
});

describe('seedStories', () => {
  it('returns at least one story', () => {
    const epic: EpicView = {
      number: 1,
      title: 'Draft Epic: Something',
      body: 'no hypothesis section',
      labels: [],
      comments: [],
    };
    expect(seedStories(epic).length).toBeGreaterThanOrEqual(1);
  });

  it('pulls the hypothesis from the ## Hypothesis section', () => {
    const epic: EpicView = {
      number: 1,
      title: 'Draft Epic: Fallback title',
      body: '## Hypothesis\nImprove observability dashboards\n\n## Other\ntext',
      labels: [],
      comments: [],
    };
    const [story] = seedStories(epic);
    expect(story.want).toContain('Improve observability dashboards');
  });

  it('falls back to the title with the Draft Epic: prefix stripped', () => {
    const epic: EpicView = {
      number: 1,
      title: 'Draft Epic: Fallback title',
      body: 'no hypothesis here',
      labels: [],
      comments: [],
    };
    const [story] = seedStories(epic);
    expect(story.want).toContain('Fallback title');
  });
});

describe('renderStoryChecklist', () => {
  it('renders checklist lines', () => {
    const result = renderStoryChecklist([
      { number: 12, title: 'First' },
      { number: 13, title: 'Second' },
    ]);
    expect(result).toBe('- [ ] #12 — First\n- [ ] #13 — Second');
  });
});

describe('advanceDraftEpic — refine', () => {
  it('incorporates new owner comments', async () => {
    const { run, calls } = fakeRun({
      view: {
        number: 5,
        title: 'Draft Epic: X',
        body: '## Hypothesis\nX',
        labels: ['status:exploring'],
        comments: [
          { author: 'alice', body: 'Yes this matters.', createdAt: '2026-02-01T00:00:00.000Z' },
          { author: 'bob', body: 'Scope looks right.', createdAt: '2026-02-01T01:00:00.000Z' },
          { author: 'bot', body: '📌 **Owner review needed**', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });

    const result = await advanceDraftEpic(
      { repoDir: '/repo', issueNumber: 5 },
      { run, now: () => new Date('2026-02-02T00:00:00.000Z') },
    );

    expect(result).toEqual({ action: 'refined', issueNumber: 5, incorporated: 2, changed: true });
    const editCall = findCall(calls, 'issue', 'edit');
    expect(editCall).toBeDefined();
    const body = flagValue(editCall!, '--body')!;
    expect(body).toContain('## Owner answers');
    expect(body).toContain('alice');
    expect(body).toContain('bob');
    expect(body).toContain('factory:cycle');
    expect(findCall(calls, 'issue', 'create')).toBeUndefined();
    expect(
      findCalls(calls, 'issue', 'edit').every((c) => !c.includes('--add-label') && !c.includes('--remove-label')),
    ).toBe(true);
  });

  it('reports no change when comments are already seen', async () => {
    const cycleTime = '2026-02-02T00:00:00.000Z';
    const { run, calls } = fakeRun({
      view: {
        number: 5,
        title: 'Draft Epic: X',
        body: `## Hypothesis\nX\n\n<!-- factory:cycle="${cycleTime}" -->`,
        labels: ['status:exploring'],
        comments: [{ author: 'alice', body: 'Old comment.', createdAt: '2026-02-01T00:00:00.000Z' }],
      },
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 5 }, { run });

    expect(result).toEqual({ action: 'refined', issueNumber: 5, incorporated: 0, changed: false });
    expect(findCall(calls, 'issue', 'edit')).toBeUndefined();
  });
});

describe('advanceDraftEpic — promote', () => {
  const oneStory: DraftStory = {
    title: 'Ship the smallest slice',
    role: 'product owner',
    want: 'a minimal slice',
    soThat: 'we validate the idea',
    scenarios: [{ name: 'Ships', given: ['a validated Epic'], when: ['built'], then: ['it merges'] }],
  };

  it('creates stories, ensures the ready label, and updates the Epic body', async () => {
    const { run, calls } = fakeRun({
      view: { number: 20, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['validated'] },
      existingLabels: [],
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 20, stories: [oneStory] }, { run });

    expect(result.action).toBe('promoted');
    if (result.action !== 'promoted') throw new Error('expected promoted');
    expect(result.storyNumbers).toHaveLength(1);
    expect(result.reusedNumbers).toEqual([]);

    const createCall = findCall(calls, 'issue', 'create')!;
    expect(flagValue(createCall, '--label')).toBe(READY_LABEL);
    expect(flagValue(createCall, '--body')).toContain('## User Story');

    const labelCreateCalls = findCalls(calls, 'label', 'create');
    expect(labelCreateCalls.some((c) => c.includes(READY_LABEL))).toBe(true);

    const editCalls = findCalls(calls, 'issue', 'edit');
    const bodyEdit = editCalls.find((c) => c.includes('--body'));
    const body = flagValue(bodyEdit!, '--body')!;
    expect(body).toContain('## Stories');
    expect(body).toContain(`- [ ] #${result.storyNumbers[0]}`);
    expect(body).toContain(PROMOTED_MARKER);

    const removeLabelEdit = editCalls.find((c) => c.includes('--remove-label'));
    expect(flagValue(removeLabelEdit!, '--remove-label')).toBe('status:exploring');
  });

  it('reuses an existing child story instead of creating a duplicate', async () => {
    const key = 'ship-the-smallest-slice';
    const marker = storyMarker(20, key);
    const { run, calls } = fakeRun({
      view: { number: 20, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['validated'] },
      existingChildren: [{ number: 99, title: 'Ship the smallest slice', body: `body\n${marker}` }],
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 20, stories: [oneStory] }, { run });

    expect(result.action).toBe('promoted');
    if (result.action !== 'promoted') throw new Error('expected promoted');
    expect(result.reusedNumbers).toEqual([99]);
    expect(result.storyNumbers).toEqual([]);
    expect(findCall(calls, 'issue', 'create')).toBeUndefined();
  });

  it('caps created stories at maxStories using the seed path', async () => {
    const { run, calls } = fakeRun({
      view: { number: 20, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['validated'] },
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 20, maxStories: 1 }, { run });

    expect(result.action).toBe('promoted');
    if (result.action !== 'promoted') throw new Error('expected promoted');
    expect(result.storyNumbers.length).toBeLessThanOrEqual(1);
    expect(findCalls(calls, 'issue', 'create')).toHaveLength(1);
  });

  it('already-promoted: no writes', async () => {
    const { run, calls } = fakeRun({
      view: {
        number: 20,
        title: 'Draft Epic: X',
        body: `## Hypothesis\nX\n\n${PROMOTED_MARKER}`,
        labels: ['validated'],
      },
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 20 }, { run });

    expect(result).toEqual({ action: 'already-promoted', issueNumber: 20 });
    expect(findCall(calls, 'issue', 'create')).toBeUndefined();
    expect(findCall(calls, 'issue', 'edit')).toBeUndefined();
  });
});

describe('advanceDraftEpic — archive', () => {
  it('archives a wontfix Epic', async () => {
    const { run, calls } = fakeRun({
      view: { number: 30, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['wontfix', 'status:exploring'] },
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 30 }, { run });

    expect(result).toEqual({ action: 'archived', issueNumber: 30 });
    const editCalls = findCalls(calls, 'issue', 'edit');
    const labelEdit = editCalls.find((c) => c.includes('--add-label'));
    expect(flagValue(labelEdit!, '--add-label')).toBe('status:archived');
    expect(flagValue(labelEdit!, '--remove-label')).toBe('status:exploring');
    const bodyEdit = editCalls.find((c) => c.includes('--body'));
    expect(flagValue(bodyEdit!, '--body')).toContain(ARCHIVED_MARKER);
    const closeCall = findCall(calls, 'issue', 'close');
    expect(flagValue(closeCall!, '--reason')).toBe('not planned');
  });

  it('already-archived: no close call', async () => {
    const { run, calls } = fakeRun({
      view: {
        number: 30,
        title: 'Draft Epic: X',
        body: `## Hypothesis\nX\n\n${ARCHIVED_MARKER}`,
        labels: ['wontfix'],
      },
    });

    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 30 }, { run });

    expect(result).toEqual({ action: 'already-archived', issueNumber: 30 });
    expect(findCall(calls, 'issue', 'close')).toBeUndefined();
  });
});

describe('advanceDraftEpic — view failure', () => {
  it('returns an error action', async () => {
    const { run } = fakeRun({ viewOk: false });
    const result = await advanceDraftEpic({ repoDir: '/repo', issueNumber: 40 }, { run });
    expect(result).toEqual({ action: 'error', detail: 'boom' });
  });
});

describe('advanceDraftEpic — nothing-queued invariant', () => {
  it('exploring-only Epics never create a ready story', async () => {
    const { run, calls } = fakeRun({
      view: { number: 50, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['status:exploring'] },
    });
    await advanceDraftEpic({ repoDir: '/repo', issueNumber: 50 }, { run });
    expect(calls.some((c) => c[1] === 'issue' && c[2] === 'create' && c.includes(READY_LABEL))).toBe(false);
  });

  it('wontfix Epics never create a ready story', async () => {
    const { run, calls } = fakeRun({
      view: { number: 51, title: 'Draft Epic: X', body: '## Hypothesis\nX', labels: ['wontfix'] },
    });
    await advanceDraftEpic({ repoDir: '/repo', issueNumber: 51 }, { run });
    expect(calls.some((c) => c[1] === 'issue' && c[2] === 'create' && c.includes(READY_LABEL))).toBe(false);
  });
});
