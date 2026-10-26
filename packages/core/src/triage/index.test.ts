import { describe, expect, it } from 'vitest';

import {
  buildTriagePrompt,
  closingKeywordIssues,
  dropQueuedIssues,
  normalizeTriageQueue,
  parseOpenPrIssues,
  parseParentReference,
  parseTriageCandidates,
  preferStartedParents,
  TRIAGE_BODY_MAX_CHARS,
  triageParentCoverage,
  truncateTriageBody,
} from './index.js';
import { validateQueue } from '../queue/index.js';
import type { TriageCandidate } from './index.js';

describe('truncateTriageBody', () => {
  it('keeps short bodies and caps long ones at the limit', () => {
    expect(truncateTriageBody('  hi  ')).toBe('hi');
    const cut = truncateTriageBody('y'.repeat(10_000));
    expect(cut.length).toBe(TRIAGE_BODY_MAX_CHARS);
    expect(cut.endsWith('[truncated]')).toBe(true);
  });
});

describe('buildTriagePrompt', () => {
  it('caps every one of 100 10k-character bodies at 1.5k characters', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `t${i}`,
      labels: [],
      body: 'z'.repeat(10_000),
    }));
    const prompt = buildTriagePrompt({ repo: 'o/r', candidates });
    for (const block of prompt.split('### #').slice(1)) {
      const body = block.split('\n').slice(1).join('\n').trim();
      expect(body.length).toBeLessThanOrEqual(TRIAGE_BODY_MAX_CHARS);
    }
    expect(prompt).toContain('Reply with ONLY the queue');
  });

  it('names the constitution and handles no issues', () => {
    const prompt = buildTriagePrompt({ repo: 'o/r', product: 'web', candidates: [] });
    expect(prompt).toContain('Active constitution: web.');
    expect(prompt).toContain('(no open issues)');
    expect(buildTriagePrompt({ repo: 'o/r', candidates: [{ number: 1, title: 'a', labels: [], body: '' }] })).toContain(
      '(no body)',
    );
  });
});

describe('parseTriageCandidates', () => {
  it('normalizes gh JSON and skips malformed rows', () => {
    const parsed = parseTriageCandidates(
      JSON.stringify([
        { number: 1, title: 'a', labels: [{ name: 'bug' }, 'x', 3], body: 'b' },
        { number: 2 },
        { title: 'no number' },
        null,
      ]),
    );
    expect(parsed).toEqual([
      { number: 1, title: 'a', labels: ['bug', 'x'], body: 'b' },
      { number: 2, title: '', labels: [], body: '' },
    ]);
    expect(parseTriageCandidates('{}')).toEqual([]);
  });
});

describe('normalizeTriageQueue', () => {
  it('produces a queue validateQueue accepts from messy model output', () => {
    const out = normalizeTriageQueue(
      'Here is the queue:\n```\n# Triage queue\n\n- app 5\napp #6\napp 5\ndocs 0\n```\n',
    );
    expect(out).toBe('# Triage queue\napp 5\napp 6\n');
    expect(validateQueue(out).ok).toBe(true);
  });

  it('returns empty when no entry survives', () => {
    expect(normalizeTriageQueue('# only comments\nnothing here')).toBe('');
  });
});

describe('parseOpenPrIssues', () => {
  it('collects issue numbers from factory and legacy branches only', () => {
    const json = JSON.stringify([
      { headRefName: 'factory/1-foo' },
      { headRefName: 'factory/3-bar' },
      { headRefName: 'feature/5-x' },
      { headRefName: 'ship-it/7-old' },
      {},
      null,
    ]);
    expect(parseOpenPrIssues(json, 'factory')).toEqual(new Set([1, 3, 7]));
  });

  it('returns null for malformed input', () => {
    expect(parseOpenPrIssues('not json', 'factory')).toBeNull();
    expect(parseOpenPrIssues('{}', 'factory')).toBeNull();
  });
});

describe('dropQueuedIssues', () => {
  const queue = '# Triage queue\napp 1\napp 3\napp 5\ndocs 6\n';

  it('drops #1 and #3 with open factory PRs and keeps #5 (#2981)', () => {
    const issues = parseOpenPrIssues(
      JSON.stringify([{ headRefName: 'factory/1-a' }, { headRefName: 'factory/3-b' }]),
      'factory',
    );
    const out = dropQueuedIssues(queue, issues ?? new Set());
    expect(out.queue).toBe('# Triage queue\napp 5\ndocs 6\n');
    expect(out.dropped).toEqual([1, 3]);
    expect(validateQueue(out.queue).ok).toBe(true);
  });

  it('returns the queue unchanged for an empty set', () => {
    expect(dropQueuedIssues(queue, new Set())).toEqual({ queue, dropped: [] });
  });

  it('returns an empty string when every entry is dropped', () => {
    expect(dropQueuedIssues(queue, new Set([1, 3, 5, 6])).queue).toBe('');
  });
});

describe('closingKeywordIssues (#2983)', () => {
  it('matches all nine keywords, the colon form, and multiple refs', () => {
    for (const k of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'RESOLVED']) {
      expect(closingKeywordIssues(`${k} #5`)).toEqual([5]);
    }
    expect(closingKeywordIssues('Closes: #7')).toEqual([7]);
    expect(closingKeywordIssues('Closes #7, fixes #9')).toEqual([7, 9]);
  });

  it('ignores bare refs, keyword-in-word, cross-repo refs and empty text', () => {
    for (const t of ['see #7', 'prefixes #7', 'unresolved #7', 'closes o/r#7', '']) {
      expect(closingKeywordIssues(t)).toEqual([]);
    }
  });
});

describe('parseOpenPrIssues closing keywords (#2983)', () => {
  const parse = (rows: unknown[]) => parseOpenPrIssues(JSON.stringify(rows), 'factory');
  it('links by body or title on any branch', () => {
    expect(parse([{ headRefName: 'feature/x', body: 'Closes #7' }, { title: 'fix #4' }])).toEqual(new Set([7, 4]));
  });
  it('skips non-OPEN rows and counts OPEN ones', () => {
    expect(parse([{ state: 'CLOSED', body: 'Closes #8', headRefName: 'factory/9-a' }])).toEqual(new Set());
    expect(parse([{ state: 'OPEN', body: 'Closes #8' }])).toEqual(new Set([8]));
  });
  it('ignores null and non-string title/body', () => {
    expect(parse([{ title: null, body: 5 }])).toEqual(new Set());
  });
});

const cand = (number: number, body = '', labels: string[] = []): TriageCandidate => ({
  number,
  title: `t${number}`,
  labels,
  body,
});
const startedSetup = (labels20: string[] = []) => {
  const open = [
    cand(1),
    cand(2),
    cand(20, 'Part of #2', labels20),
    cand(12, 'Decomposed from #1 by the factory size gate.'),
  ];
  const closed = [{ number: 11, body: 'Decomposed from #1' }];
  return { open, coverage: triageParentCoverage(open, closed) };
};

describe('parseParentReference', () => {
  it('reads Decomposed from and Part of references', () => {
    expect(parseParentReference('Decomposed from #12 by the factory size gate.')).toBe(12);
    expect(parseParentReference('intro\nPart of #3104.')).toBe(3104);
  });
  it('returns null without a reference or for #0', () => {
    expect(parseParentReference('nothing here')).toBeNull();
    expect(parseParentReference('Part of #0')).toBeNull();
  });
});

describe('triageParentCoverage', () => {
  it('splits built and unbuilt children per open parent', () => {
    const { coverage } = startedSetup();
    expect(coverage).toEqual([
      { parent: 1, built: [11], unbuilt: [12] },
      { parent: 2, built: [], unbuilt: [20] },
    ]);
  });
  it('ignores closed parents and self references', () => {
    const open = [cand(5, 'Part of #5'), cand(6, 'Part of #99')];
    expect(triageParentCoverage(open, [{ number: 7, body: 'Part of #99' }])).toEqual([]);
  });
});

describe('preferStartedParents (#3109)', () => {
  it("picks the unbuilt child of a started open parent ahead of a new parent's child and records why", () => {
    const { open, coverage } = startedSetup();
    const res = preferStartedParents('app 20\napp 12\n', open, coverage);
    expect(
      res.queue.startsWith(
        '# Finish before start: #12 (open parent #1, 1 of 2 children built) ahead of #20 (new parent #2)\n',
      ),
    ).toBe(true);
    expect(res.queue.endsWith('app 12\napp 20\n')).toBe(true);
    expect(res.reasons).toHaveLength(1);
    expect(validateQueue(res.queue).ok).toBe(true);
  });

  it('never moves a child ahead of an issue with an explicit factory:order label', () => {
    const { open, coverage } = startedSetup(['factory:order:1']);
    expect(preferStartedParents('app 20\napp 12\n', open, coverage)).toEqual({
      queue: 'app 20\napp 12\n',
      reasons: [],
    });
    const withBarrier = [...open, cand(30, '', ['factory:order:2'])];
    const queue = 'app 20\napp 30\napp 12\n';
    expect(preferStartedParents(queue, withBarrier, coverage).queue).toBe(queue);
    const barrierOnly = [...startedSetup().open, cand(30, '', ['factory:order:2'])];
    expect(preferStartedParents('app 20\napp 30\napp 12\n', barrierOnly, startedSetup().coverage).reasons).toEqual([]);
  });

  it('returns the queue unchanged when no parent is started', () => {
    const open = [cand(1), cand(2), cand(20, 'Part of #2'), cand(12, 'Part of #1')];
    const coverage = triageParentCoverage(open, []);
    expect(preferStartedParents('app 20\napp 12\n', open, coverage)).toEqual({
      queue: 'app 20\napp 12\n',
      reasons: [],
    });
    expect(preferStartedParents('', [], [])).toEqual({ queue: '', reasons: [] });
  });

  it('keeps comment lines, non-child entries and the entry multiset', () => {
    const { open, coverage } = startedSetup();
    const queue = '# Skipped (a PR is open): #9\napp 20\napp 40\napp 12\n';
    const res = preferStartedParents(queue, open, coverage);
    expect(res.queue).toContain('# Skipped (a PR is open): #9\n');
    const entries = (q: string) =>
      q
        .split('\n')
        .filter((l) => !l.startsWith('#') && l)
        .sort();
    expect(entries(res.queue)).toEqual(entries(queue));
    expect(res.queue.endsWith('app 12\napp 40\napp 20\n')).toBe(true);
  });
});
