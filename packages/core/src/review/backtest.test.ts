// packages/core/src/review/backtest.test.ts — classifier backtest over merged PRs (#1728)

import { describe, expect, it, vi } from 'vitest';

import { MAX_DIFF_CHARS } from '../checkers/design-smells.js';
import { classifierOutcomeBucket } from '../kpis/classifier-outcomes.js';
import { detectPostMergeDefects } from '../kpis/defects.js';
import type { PrSource } from '../kpis/human.js';
import type { ModelRouter } from '../router/index.js';
import type { FactoryEvent } from '../types/index.js';
import {
  backtestFileName,
  buildBacktestRecord,
  parseBacktestLabels,
  runClassifierBacktest,
  selectBacktestPrs,
  type BacktestPorts,
} from './backtest.js';
import type { classifyPrShadow, PrShadowVerdict } from './classifier.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from './floor.js';

const NOW = '2026-10-05T00:00:00.000Z';
const WINDOW = 14;

function src(n: number, mergedAt: string | null, extra: Partial<PrSource> = {}): PrSource {
  return {
    issue: String(n),
    prNumber: n,
    commits: [],
    approvals: [],
    mergedAt,
    closedAt: null,
    mergeCommitSha: mergedAt ? `abc${String(n).padStart(4, '0')}` : null,
    ...extra,
  };
}

function verdict(extra: Partial<PrShadowVerdict> = {}): PrShadowVerdict {
  return {
    modelClass: 'A',
    floorClass: 'A',
    finalClass: 'A',
    model: 'm',
    promptVersion: 'p1',
    policyVersion: 'v1',
    diffSha: 'd',
    adrIds: [],
    costUsd: 0.4,
    claims: [],
    unsupportedClaims: [],
    notInspected: [],
    droppedClaims: 0,
    ...extra,
  };
}

function ports(extra: Partial<BacktestPorts> = {}): BacktestPorts {
  return {
    numstat: async () => '3\t1\tdocs/readme.md\n',
    diff: async () => 'diff --git a/docs/readme.md b/docs/readme.md\n',
    getIssue: async (n) => ({ title: `t${n}`, body: `b${n}` }),
    specPath: (i) => `/plans/issue-${i}.md`,
    worktree: '/repo',
    router: {} as ModelRouter,
    classify: (async () => verdict()) as typeof classifyPrShadow,
    ...extra,
  };
}

function run(sources: PrSource[], p: BacktestPorts, extra: Record<string, unknown> = {}) {
  return runClassifierBacktest(
    {
      sources,
      events: [],
      labels: new Map(),
      rules: DEFAULT_REVIEW_FLOOR_RULES,
      now: NOW,
      windowDays: WINDOW,
      ...extra,
    },
    p,
  );
}

describe('selectBacktestPrs', () => {
  it('keeps merged PRs since the date, oldest first, capped by limit', () => {
    const merged = Array.from({ length: 25 }, (_, i) =>
      src(100 + i, `2026-08-${String(25 - i).padStart(2, '0')}T00:00:00.000Z`),
    );
    const sources = [...merged, src(1, '2026-07-01T00:00:00.000Z'), src(2, '2026-07-15T00:00:00.000Z'), src(3, null)];
    const picked = selectBacktestPrs(sources, { since: '2026-08-01', limit: 20 });
    expect(picked).toHaveLength(20);
    const times = picked.map((s) => Date.parse(s.mergedAt!));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(picked.every((s) => s.prNumber >= 100)).toBe(true);
    expect(selectBacktestPrs(sources, { since: '2026-08-01' })).toHaveLength(25);
  });

  it('breaks merge-time ties on PR number', () => {
    const t = '2026-08-02T00:00:00.000Z';
    expect(selectBacktestPrs([src(9, t), src(4, t)], { since: '2026-08-01' }).map((s) => s.prNumber)).toEqual([4, 9]);
  });
});

describe('runClassifierBacktest', () => {
  it('classifies 20 PRs and streams each record', async () => {
    const sources = selectBacktestPrs(
      Array.from({ length: 25 }, (_, i) => src(100 + i, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)),
      { since: '2026-08-01', limit: 20 },
    );
    const onRecord = vi.fn();
    const res = await run(sources, ports({ onRecord }));
    expect(res.records).toHaveLength(20);
    expect(onRecord).toHaveBeenCalledTimes(20);
    expect(res.candidates).toBe(20);
    expect(res.budgetReached).toBe(false);
  });

  it('computes the floor from numstat and feeds the merge diff to the classifier', async () => {
    let seen: Parameters<typeof classifyPrShadow> | undefined;
    const classify = (async (...args: Parameters<typeof classifyPrShadow>) => {
      seen = args;
      return verdict();
    }) as typeof classifyPrShadow;
    await run([src(5, '2026-08-01T00:00:00.000Z')], ports({ classify, modelPin: 'pin' }));
    expect(seen![0].floor).toBe('A');
    expect(seen![0].issueTitle).toBe('t5');
    expect(seen![0].specPath).toBe('/plans/issue-5.md');
    expect(seen![0].modelPin).toBe('pin');
    const diff = await seen![1]!.collectDiff!('/repo');
    expect(diff).toEqual({
      text: 'diff --git a/docs/readme.md b/docs/readme.md\n',
      baseRef: 'abc0005^1',
      truncated: false,
    });
  });

  it('truncates over-long diffs and reports a diff failure as a skip', async () => {
    let collect: NonNullable<NonNullable<Parameters<typeof classifyPrShadow>[1]>['collectDiff']> | undefined;
    const classify = (async (_i: unknown, d: Parameters<typeof classifyPrShadow>[1]) => {
      collect = d!.collectDiff;
      return verdict();
    }) as typeof classifyPrShadow;
    await run(
      [src(5, '2026-08-01T00:00:00.000Z')],
      ports({ classify, diff: async () => 'x'.repeat(MAX_DIFF_CHARS + 10) }),
    );
    const long = await collect!('/repo');
    expect(long.truncated).toBe(true);
    expect(long.text).toContain('[diff truncated');
    await run(
      [src(5, '2026-08-01T00:00:00.000Z')],
      ports({
        classify,
        diff: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(await collect!('/repo')).toMatchObject({ text: '', skipReason: 'merge diff unavailable: boom' });
  });

  it('skips the diff with a reason when the issue fetch fails', async () => {
    let collect: NonNullable<NonNullable<Parameters<typeof classifyPrShadow>[1]>['collectDiff']> | undefined;
    const classify = (async (_i: unknown, d: Parameters<typeof classifyPrShadow>[1]) => {
      collect = d!.collectDiff;
      return verdict();
    }) as typeof classifyPrShadow;
    await run(
      [src(5, '2026-08-01T00:00:00.000Z')],
      ports({
        classify,
        getIssue: async () => {
          throw new Error('rate limited');
        },
      }),
    );
    expect(await collect!('/repo')).toMatchObject({ text: '', skipReason: 'issue unavailable: rate limited' });
  });

  it('stops at the cost budget', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => src(100 + i, '2026-08-01T00:00:00.000Z'));
    const res = await run(sources, ports(), { maxCostUsd: 1 });
    expect(res.records).toHaveLength(3);
    expect(res.budgetReached).toBe(true);
    expect(res.spentUsd).toBeCloseTo(1.2);
    expect((await run(sources, ports())).records).toHaveLength(10);
  });

  it('counts null costs as unpriced', async () => {
    const classify = (async () => verdict({ costUsd: null })) as typeof classifyPrShadow;
    const res = await run([src(1, '2026-08-01T00:00:00.000Z')], ports({ classify }));
    expect(res.unpricedCalls).toBe(1);
    expect(res.spentUsd).toBe(0);
  });

  it('fails closed to a null floor when numstat throws', async () => {
    const res = await run(
      [src(1, '2026-08-01T00:00:00.000Z')],
      ports({
        numstat: async () => {
          throw new Error('no git');
        },
        classify: (async (i) => verdict({ floorClass: i.floor })) as typeof classifyPrShadow,
      }),
    );
    expect(res.records[0].floorClass).toBeNull();
  });

  it('writes a null-class verdict as pending with its reason', async () => {
    const classify = (async () => verdict({ modelClass: null, reason: 'unparseable' })) as typeof classifyPrShadow;
    const res = await run([src(1, '2026-08-01T00:00:00.000Z')], ports({ classify }));
    expect(res.records[0]).toMatchObject({
      modelClass: null,
      reason: 'unparseable',
      verdict: 'pending',
      slipped: false,
    });
  });
});

describe('buildBacktestRecord outcomes', () => {
  const build = (source: PrSource, events: FactoryEvent[], handLabel?: 'defect' | 'clean' | 'gated') =>
    buildBacktestRecord({
      source,
      verdict: verdict(),
      events,
      handLabel,
      now: NOW,
      windowDays: WINDOW,
      classifiedAt: NOW,
    })!;
  const mergedAt = '2026-08-01T00:00:00.000Z';

  const revertEvents = (): FactoryEvent[] =>
    detectPostMergeDefects(
      {
        mergedPrs: [{ issue: '7', prNumber: 7, mergedAt, mergeCommitSha: 'abc0007' }],
        commits: [{ sha: 'f'.repeat(40), message: 'Revert "feat: x (#7)"', ts: '2026-08-03T00:00:00.000Z' }],
        issues: [],
        comments: [],
      },
      [],
      { now: NOW, windowDays: WINDOW },
    );

  it('labels a reverted PR as a heuristic defect and a slipped A', () => {
    const events = revertEvents();
    expect(events.some((e) => e.type === 'post-merge-defect')).toBe(true);
    const rec = build(src(7, mergedAt), events);
    expect(rec).toMatchObject({ outcomeLabel: 'defect', labelSource: 'heuristic', defectFired: true, slipped: true });
    expect(rec.mergeCommitSha).toBe('abc0007');
  });

  it('labels clean, pending and human-edited PRs', () => {
    expect(build(src(8, mergedAt), [])).toMatchObject({ outcomeLabel: 'clean', labelSource: 'heuristic' });
    expect(build(src(8, '2026-10-01T00:00:00.000Z'), [])).toMatchObject({ outcomeLabel: 'pending' });
    const edited: FactoryEvent = { ts: '2026-07-31T00:00:00.000Z', type: 'human-edited', issue: '8', msg: 'e' };
    expect(build(src(8, mergedAt), [edited])).toMatchObject({ outcomeLabel: 'gated', humanEdited: true });
  });

  it('lets a hand label win over heuristic events', () => {
    const rec = build(src(7, mergedAt), revertEvents(), 'clean');
    expect(rec).toMatchObject({ outcomeLabel: 'clean', labelSource: 'hand', defectFired: false });
    expect(classifierOutcomeBucket({ ...rec, modelClass: 'A' })).toBe('mergedClean');
    const defect = build(src(8, '2026-10-01T00:00:00.000Z'), [], 'defect');
    expect(classifierOutcomeBucket({ ...defect, modelClass: 'A' })).toBe('slippedDefect');
    expect(build(src(8, mergedAt), [], 'gated').outcomeLabel).toBe('gated');
  });

  it('returns null for an unmerged PR', () => {
    expect(build(src(3, null), [])).toBeNull();
  });

  it('backtest hand labels run end to end', async () => {
    const res = await run([src(7, mergedAt)], ports(), { events: revertEvents(), labels: new Map([[7, 'clean']]) });
    expect(res.records[0]).toMatchObject({ outcomeLabel: 'clean', labelSource: 'hand' });
  });
});

describe('parseBacktestLabels', () => {
  it('skips header, blanks and comments, accepts #N and any case, later duplicate wins', () => {
    const m = parseBacktestLabels('PR,Class\n\n# note\n#12,DEFECT\n5,clean\n5, gated\n');
    expect([...m]).toEqual([
      [12, 'defect'],
      [5, 'gated'],
    ]);
  });

  it('throws with the line number on a bad class or PR', () => {
    expect(() => parseBacktestLabels('pr,class\n1,clean\n2,maybe')).toThrow(/labels line 3: invalid class/);
    expect(() => parseBacktestLabels('x,clean')).toThrow(/labels line 1: invalid PR/);
    expect(() => parseBacktestLabels('0,clean')).toThrow(/labels line 1/);
    expect(() => parseBacktestLabels('1')).toThrow(/labels line 1/);
  });
});

describe('backtestFileName', () => {
  it('replaces colons and dots', () => {
    expect(backtestFileName('2026-10-05T12:00:00.000Z')).toBe('classifier-backtest-2026-10-05T12-00-00-000Z.jsonl');
  });
});
