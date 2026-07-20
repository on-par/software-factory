import { describe, expect, it } from 'vitest';

import {
  authorDraftEpic,
  DEFAULT_OWNER_QUESTIONS,
  DISCOVERY_LABEL,
  draftEpicTitle,
  EXPLORING_LABEL,
  findDuplicate,
  ideaMarker,
  ideaSlug,
  parseIssueNumber,
} from './author.js';
import type { DiscoveryCandidate } from './index.js';

function fakeRun(opts: {
  existingIssues?: Array<{ number: number; title: string; body: string }>;
  existingLabels?: string[];
  createOk?: boolean;
  createUrl?: string;
  commentOk?: boolean;
}) {
  const calls: (readonly string[])[] = [];
  const run = async (argv: readonly string[]) => {
    calls.push(argv);
    if (argv[1] === 'issue' && argv[2] === 'list') {
      return { stdout: JSON.stringify(opts.existingIssues ?? []), ok: true };
    }
    if (argv[1] === 'label' && argv[2] === 'list') {
      return { stdout: JSON.stringify((opts.existingLabels ?? []).map((name) => ({ name }))), ok: true };
    }
    if (argv[1] === 'label' && argv[2] === 'create') {
      return { stdout: '', ok: true };
    }
    if (argv[1] === 'issue' && argv[2] === 'create') {
      return {
        stdout: opts.createOk === false ? 'boom' : (opts.createUrl ?? 'https://github.com/o/r/issues/376'),
        ok: opts.createOk !== false,
      };
    }
    if (argv[1] === 'issue' && argv[2] === 'comment') {
      return { stdout: '', ok: opts.commentOk !== false };
    }
    return { stdout: '', ok: true };
  };
  return { run, calls };
}

const candidate: DiscoveryCandidate = {
  hypothesis: 'Advance roadmap item: Improve observability dashboards',
  score: 6,
  signals: [{ source: 'roadmap', reference: 'ROADMAP.md', detail: 'Improve observability dashboards' }],
};

function findCall(calls: (readonly string[])[], sub1: string, sub2: string): readonly string[] | undefined {
  return calls.find((c) => c[1] === sub1 && c[2] === sub2);
}

function flagValue(call: readonly string[], flag: string): string | undefined {
  const idx = call.indexOf(flag);
  return idx === -1 ? undefined : call[idx + 1];
}

describe('authorDraftEpic', () => {
  it('happy path: creates issue, ensures labels, posts owner comment', async () => {
    const { run, calls } = fakeRun({});
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toEqual({
      created: true,
      issueNumber: 376,
      issueUrl: 'https://github.com/o/r/issues/376',
      labels: [DISCOVERY_LABEL, EXPLORING_LABEL],
      commentPosted: true,
    });

    const createCall = findCall(calls, 'issue', 'create');
    expect(createCall).toBeDefined();
    const body = flagValue(createCall!, '--body')!;
    expect(body).toContain('## Hypothesis');
    expect(body).toContain('## User problem');
    expect(body).toContain('## Why now');
    expect(body).toContain('## Rough wedge / scope');
    expect(body).toContain('## Open Questions');
    expect(body).toContain('## Signals');
    expect(body).toContain(ideaMarker(candidate.hypothesis));
    expect(body).toContain('ROADMAP.md');

    const commentCall = findCall(calls, 'issue', 'comment');
    expect(commentCall).toBeDefined();
    const commentBody = flagValue(commentCall!, '--body')!;
    for (const q of DEFAULT_OWNER_QUESTIONS) {
      expect(commentBody).toContain(q);
    }
    expect(commentBody).toContain('validated');
    expect(commentBody).toContain('needs-work');
    expect(commentBody).toContain('wontfix');

    expect(calls.every((a) => a[0] === 'gh')).toBe(true);
  });

  it('dedup by marker: skips creation entirely', async () => {
    const marker = ideaMarker(candidate.hypothesis);
    const { run, calls } = fakeRun({
      existingIssues: [{ number: 42, title: 'Unrelated title', body: `some body\n${marker}\nmore text` }],
    });
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toEqual({ created: false, reason: 'duplicate', duplicateOf: 42 });
    expect(findCall(calls, 'issue', 'create')).toBeUndefined();
    expect(findCall(calls, 'issue', 'comment')).toBeUndefined();
    expect(findCall(calls, 'label', 'create')).toBeUndefined();
  });

  it('dedup by normalized title: skips creation entirely', async () => {
    const { run, calls } = fakeRun({
      existingIssues: [
        { number: 7, title: 'Epic: advance roadmap item: improve observability dashboards', body: 'no marker here' },
      ],
    });
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toEqual({ created: false, reason: 'duplicate', duplicateOf: 7 });
    expect(findCall(calls, 'issue', 'create')).toBeUndefined();
    expect(findCall(calls, 'issue', 'comment')).toBeUndefined();
    expect(findCall(calls, 'label', 'create')).toBeUndefined();
  });

  it('creates only the missing label when one already exists', async () => {
    const { run, calls } = fakeRun({ existingLabels: ['discovery'] });
    await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    const createLabelCalls = calls.filter((c) => c[1] === 'label' && c[2] === 'create');
    expect(createLabelCalls).toHaveLength(1);
    expect(createLabelCalls[0]).toContain(EXPLORING_LABEL);
  });

  it('creates both labels when none exist', async () => {
    const { run, calls } = fakeRun({ existingLabels: [] });
    await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    const createLabelCalls = calls.filter((c) => c[1] === 'label' && c[2] === 'create');
    expect(createLabelCalls).toHaveLength(2);
  });

  it('create-failed: gh issue create fails, no comment posted', async () => {
    const { run, calls } = fakeRun({ createOk: false });
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toEqual({ created: false, reason: 'create-failed', detail: 'boom' });
    expect(findCall(calls, 'issue', 'comment')).toBeUndefined();
  });

  it('create-failed: unparseable create URL', async () => {
    const { run } = fakeRun({ createUrl: 'not-a-url' });
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toEqual({ created: false, reason: 'create-failed', detail: 'not-a-url' });
  });

  it('commentPosted is false when the comment call fails', async () => {
    const { run } = fakeRun({ commentOk: false });
    const result = await authorDraftEpic({ repoDir: '/repo', candidate }, { run });

    expect(result).toMatchObject({ created: true, commentPosted: false });
  });

  it('honors overrides for userProblem/whyNow/wedge/questions', async () => {
    const { run, calls } = fakeRun({});
    const questions = ['Custom question one?', 'Custom question two?'];
    await authorDraftEpic(
      {
        repoDir: '/repo',
        candidate,
        userProblem: 'Custom user problem text',
        whyNow: 'Custom why-now text',
        wedge: 'Custom wedge text',
        questions,
      },
      { run },
    );

    const createCall = findCall(calls, 'issue', 'create')!;
    const body = flagValue(createCall, '--body')!;
    expect(body).toContain('Custom user problem text');
    expect(body).toContain('Custom why-now text');
    expect(body).toContain('Custom wedge text');

    const commentCall = findCall(calls, 'issue', 'comment')!;
    const commentBody = flagValue(commentCall, '--body')!;
    expect(commentBody).toContain('Custom question one?');
    expect(commentBody).toContain('Custom question two?');
  });
});

describe('ideaSlug', () => {
  it('slugifies deterministically', () => {
    expect(ideaSlug('Advance Roadmap Item: Improve Observability!')).toBe('advance-roadmap-item-improve-observability');
  });

  it('caps length and trims trailing separators', () => {
    const long = 'a'.repeat(100);
    const slug = ideaSlug(long);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('parseIssueNumber', () => {
  it('parses trailing number from a URL', () => {
    expect(parseIssueNumber('https://github.com/o/r/issues/376')).toBe(376);
  });

  it('returns null when unparseable', () => {
    expect(parseIssueNumber('not-a-url')).toBeNull();
  });
});

describe('findDuplicate', () => {
  it('matches by marker', () => {
    const marker = ideaMarker(candidate.hypothesis);
    const result = findDuplicate(
      [{ number: 1, title: 'x', body: marker }],
      candidate,
      draftEpicTitle(candidate.hypothesis),
    );
    expect(result).toBe(1);
  });

  it('matches by normalized title', () => {
    const result = findDuplicate(
      [{ number: 2, title: 'epic: advance roadmap item: improve observability dashboards', body: 'no marker' }],
      candidate,
      draftEpicTitle(candidate.hypothesis),
    );
    expect(result).toBe(2);
  });

  it('returns null when nothing matches', () => {
    const result = findDuplicate(
      [{ number: 3, title: 'totally unrelated', body: 'nothing here' }],
      candidate,
      draftEpicTitle(candidate.hypothesis),
    );
    expect(result).toBeNull();
  });
});

describe('draftEpicTitle', () => {
  it('prefixes with Draft Epic:', () => {
    expect(draftEpicTitle('Short hypothesis')).toBe('Draft Epic: Short hypothesis');
  });

  it('truncates long hypotheses to ~120 chars for the title', () => {
    const long = 'x'.repeat(200);
    const title = draftEpicTitle(long);
    expect(title.length).toBeLessThan(140);
    expect(title.startsWith('Draft Epic: ')).toBe(true);
  });
});
