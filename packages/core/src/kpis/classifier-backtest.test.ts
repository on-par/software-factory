import { describe, expect, it, vi } from 'vitest';
import type { DiffRunner } from '../checkers/design-smells.js';
import { MAX_DIFF_CHARS } from '../checkers/design-smells.js';
import type { PrShadowVerdict } from '../review/classifier.js';
import { DEFAULT_REVIEW_FLOOR_RULES, type ReviewClass } from '../review/floor.js';
import type { ModelRouter } from '../router/index.js';
import type { FactoryEvent } from '../types/index.js';
import {
  type ClassifierBacktestDeps,
  type ClassifierBacktestInput,
  collectMergeCommitDiff,
  parseHandLabels,
  readMergeCommitChanges,
  runClassifierBacktest,
  selectBacktestPrs,
} from './classifier-backtest.js';
import { type DefectSources, detectPostMergeDefects } from './defects.js';
import type { PrSource } from './human.js';

const NOW = '2026-10-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

function pr(n: number, o: Partial<PrSource> = {}): PrSource {
  return {
    issue: String(n),
    prNumber: n + 1000,
    commits: [],
    approvals: [],
    mergedAt: daysAgo(30),
    closedAt: null,
    mergeCommitSha: `sha${n}`,
    ...o,
  };
}

function verdict(o: Partial<PrShadowVerdict> = {}): PrShadowVerdict {
  return {
    modelClass: 'A',
    floorClass: 'A',
    finalClass: 'A',
    model: 'm',
    promptVersion: 'p1',
    policyVersion: 'v1',
    diffSha: 'd',
    adrIds: [],
    costUsd: 0.1,
    claims: [],
    unsupportedClaims: [],
    notInspected: [],
    droppedClaims: 0,
    ...o,
  };
}

const defectEvent = (issue: string): FactoryEvent => ({
  ts: daysAgo(20),
  type: 'post-merge-defect',
  issue,
  msg: 'revert',
});

function setup(
  prs: PrSource[],
  o: {
    events?: FactoryEvent[];
    classify?: (...a: any[]) => Promise<PrShadowVerdict>;
    handLabels?: Map<number, ReviewClass>;
    maxCostUsd?: number;
    deps?: Partial<ClassifierBacktestDeps>;
  } = {},
) {
  const classify = vi.fn(o.classify ?? (async () => verdict()));
  const onRecord = vi.fn();
  const collectDiff = vi.fn(async (_r: string, sha: string) => ({
    text: `diff ${sha}`,
    baseRef: `${sha}^`,
    truncated: false,
  }));
  const input: ClassifierBacktestInput = {
    repoRoot: '/repo',
    prs,
    outcomeEvents: o.events ?? [],
    rules: DEFAULT_REVIEW_FLOOR_RULES,
    router: {} as ModelRouter,
    specPathFor: (i) => `/plans/issue-${i}.md`,
    handLabels: o.handLabels,
    maxCostUsd: o.maxCostUsd,
    now: NOW,
    windowDays: 14,
  };
  const deps: ClassifierBacktestDeps = {
    getIssue: async (i) => ({ title: `t${i}`, body: `b${i}` }),
    readChanges: async () => [{ path: 'src/a.ts', added: 1, removed: 0 }],
    collectDiff,
    classify: classify as any,
    onRecord,
    ...o.deps,
  };
  return { input, deps, classify, onRecord, collectDiff };
}

describe('parseHandLabels', () => {
  it('accepts header, #pr, lowercase class, blanks and comments; later duplicate wins', () => {
    const m = parseHandLabels('pr,class\n\n# note\n#12, b\n13,C\n#14,a\n');
    expect([...m].sort()).toEqual([
      [12, 'B'],
      [13, 'C'],
      [14, 'A'],
    ]);
  });

  it('throws with the line number on bad input', () => {
    expect(() => parseHandLabels('1,A\n2,Z')).toThrow(
      'labels line 2: expected "pr,class" with class A, B or C, got "2,Z"',
    );
    expect(parseHandLabels('1,A\n1,B').get(1)).toBe('B');
    expect(() => parseHandLabels('abc,A')).toThrow('labels line 1');
    expect(() => parseHandLabels('0,A')).toThrow('labels line 1');
  });
});

describe('selectBacktestPrs', () => {
  it('drops unmerged, shaless, issueless and too-old PRs, dedupes, sorts oldest first and limits', () => {
    const sources = [
      pr(1, { mergedAt: daysAgo(5) }),
      pr(2, { mergedAt: null }),
      pr(3, { mergeCommitSha: null }),
      pr(4, { mergedAt: daysAgo(100) }),
      pr(5, { mergedAt: daysAgo(10) }),
      pr(6, { issue: 'x' }),
      pr(5, { mergedAt: daysAgo(10) }),
    ];
    const since = daysAgo(50);
    expect(selectBacktestPrs(sources, { since }).map((s) => s.issue)).toEqual(['5', '1']);
    expect(selectBacktestPrs(sources, { since, limit: 1 }).map((s) => s.issue)).toEqual(['5']);
  });
});

describe('merge commit readers', () => {
  it('diffs <sha>^ against <sha> and truncates', async () => {
    const run = vi.fn<DiffRunner>(async () => ({ ok: true, stdout: 'x'.repeat(MAX_DIFF_CHARS + 5) }));
    const d = await collectMergeCommitDiff('/r', 'abc', run);
    expect(run.mock.calls[0][0].slice(0, 5)).toEqual(['git', 'diff', '--unified=3', 'abc^', 'abc']);
    expect(run.mock.calls[0][1]).toBe('/r');
    expect(d).toMatchObject({ baseRef: 'abc^', truncated: true });
    expect(d.text).toContain('[diff truncated');
  });

  it('skips when the merge commit is unavailable', async () => {
    const d = await collectMergeCommitDiff('/r', 'abc', async () => ({ ok: false, stdout: '' }));
    expect(d.skipReason).toContain('merge commit abc not available locally');
    expect(d.baseRef).toBeNull();
  });

  it('reads numstat and throws on failure', async () => {
    const run = vi.fn<DiffRunner>(async () => ({ ok: true, stdout: '3\t1\tsrc/a.ts\n' }));
    expect(await readMergeCommitChanges('/r', 'abc', run)).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
    expect(run.mock.calls[0][0]).toEqual(['git', 'diff', '--numstat', '--no-renames', 'abc^', 'abc']);
    await expect(readMergeCommitChanges('/r', 'abc', async () => ({ ok: false, stdout: '' }))).rejects.toThrow(
      'git diff --numstat for merge commit abc failed',
    );
  });
});

describe('runClassifierBacktest', () => {
  it('classifies each selected PR and reports each record', async () => {
    const prs = selectBacktestPrs(
      Array.from({ length: 25 }, (_, i) => pr(i + 1)),
      { since: daysAgo(60), limit: 20 },
    );
    const { input, deps, onRecord } = setup(prs);
    const res = await runClassifierBacktest(input, deps);
    expect(res.records).toHaveLength(20);
    expect(onRecord).toHaveBeenCalledTimes(20);
    expect(res).toMatchObject({ covered: 20, stopped: null, notRun: 0 });
    expect(res.spentUsd).toBeCloseTo(2);
    expect(res.records[0]).toMatchObject({ backtest: true, mergeCommitSha: 'sha1', labelSource: 'heuristic' });
  });

  it('attaches a post-merge defect outcome', async () => {
    const { input, deps } = setup([pr(1)], { events: [defectEvent('1')] });
    const [r] = (await runClassifierBacktest(input, deps)).records;
    expect(r).toMatchObject({ defectFired: true, outcome: 'slippedDefect', slipped: true, labelSource: 'heuristic' });
  });

  it('attaches a revert detected by the real defect detector', async () => {
    const sources: DefectSources = {
      mergedPrs: [{ issue: '1', prNumber: 1001, mergedAt: daysAgo(30), mergeCommitSha: 'sha1' }],
      commits: [
        {
          sha: 'rev1',
          ts: daysAgo(20),
          message: 'Revert "x"\n\nThis reverts commit sha1.',
        },
      ],
      issues: [],
      comments: [],
    };
    const events = detectPostMergeDefects(sources, [], { now: NOW, windowDays: 14 });
    expect(events.some((e) => e.type === 'post-merge-defect')).toBe(true);
    const { input, deps } = setup([pr(1)], { events });
    const [r] = (await runClassifierBacktest(input, deps)).records;
    expect(r.outcome).toBe('slippedDefect');
  });

  it('lets hand labels override heuristics and keeps the heuristic facts', async () => {
    const labels = new Map<number, ReviewClass>([
      [1001, 'A'],
      [1002, 'C'],
    ]);
    const { input, deps } = setup([pr(1), pr(2)], { events: [defectEvent('1')], handLabels: labels });
    const [a, c] = (await runClassifierBacktest(input, deps)).records;
    expect(a).toMatchObject({ outcome: 'mergedClean', labelSource: 'hand', handLabel: 'A', slipped: false });
    expect(a.heuristic.defectFired).toBe(true);
    expect(c).toMatchObject({
      defectFired: true,
      labelSource: 'hand',
      handLabel: 'C',
      verdict: 'disagree',
      slipped: true,
    });
  });

  it('stops before the next PR once the budget is spent', async () => {
    const { input, deps, classify } = setup(
      [1, 2, 3, 4, 5].map((n) => pr(n)),
      {
        classify: async () => verdict({ costUsd: 0.6 }),
        maxCostUsd: 1,
      },
    );
    const res = await runClassifierBacktest(input, deps);
    expect(res).toMatchObject({ stopped: 'budget', covered: 2, notRun: 3 });
    expect(res.records).toHaveLength(2);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('fails closed on an unpriced call under a budget, and only notes it without one', async () => {
    const unpriced = async () => verdict({ costUsd: null });
    const budgeted = setup([pr(1), pr(2), pr(3)], { classify: unpriced, maxCostUsd: 5 });
    const res = await runClassifierBacktest(budgeted.input, budgeted.deps);
    expect(res).toMatchObject({ stopped: 'unpriced', covered: 1, notRun: 2, unpricedCalls: 1 });
    expect(res.records).toHaveLength(1);

    const free = setup([pr(1), pr(2)], { classify: unpriced });
    const res2 = await runClassifierBacktest(free.input, free.deps);
    expect(res2).toMatchObject({ stopped: null, covered: 2, unpricedCalls: 2, spentUsd: 0 });
  });

  it('classifies with a null floor when the floor read throws', async () => {
    const { input, deps, classify } = setup([pr(1)], {
      deps: {
        readChanges: async () => {
          throw new Error('boom');
        },
      },
    });
    const res = await runClassifierBacktest(input, deps);
    expect(res.records).toHaveLength(1);
    expect(classify.mock.calls[0][0]).toMatchObject({ floor: null, floorRules: [] });
  });

  it('skips a null classification with its reason', async () => {
    const { input, deps } = setup([pr(1)], {
      classify: async () => verdict({ modelClass: null, model: null, costUsd: null, reason: 'no diff to classify' }),
    });
    const res = await runClassifierBacktest(input, deps);
    expect(res.records).toHaveLength(0);
    expect(res.skipped).toEqual([{ issue: '1', prNumber: 1001, reason: 'no diff to classify' }]);
    expect(res.covered).toBe(1);
  });

  it('skips a PR whose issue cannot be fetched without counting it covered', async () => {
    const { input, deps, classify } = setup([pr(1)], {
      deps: {
        getIssue: async () => {
          throw new Error('404');
        },
      },
    });
    const res = await runClassifierBacktest(input, deps);
    expect(res).toMatchObject({ covered: 0, skipped: [{ issue: '1', prNumber: 1001, reason: '404' }] });
    expect(classify).not.toHaveBeenCalled();
  });

  it('ignores live pr-classified events', async () => {
    const live: FactoryEvent = {
      ts: daysAgo(1),
      type: 'pr-classified',
      issue: '1',
      msg: 'live',
      prClassification: { ...verdict({ modelClass: 'C' }), adrIds: [] } as any,
    };
    const { input, deps } = setup([pr(1)], { events: [live] });
    const [r] = (await runClassifierBacktest(input, deps)).records;
    expect(r.modelClass).toBe('A');
  });

  it('passes the spec path and routes the diff to the merge sha', async () => {
    const { input, deps, classify, collectDiff } = setup([pr(7)]);
    await runClassifierBacktest(input, deps);
    const [classifyInput, classifyDeps] = classify.mock.calls[0];
    expect(classifyInput).toMatchObject({
      specPath: '/plans/issue-7.md',
      issueTitle: 't7',
      issueBody: 'b7',
      worktree: '/repo',
    });
    await classifyDeps.collectDiff();
    expect(collectDiff).toHaveBeenCalledWith('/repo', 'sha7');
  });
});
