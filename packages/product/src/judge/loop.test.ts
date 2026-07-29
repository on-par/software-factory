// packages/product/src/judge/loop.test.ts (#474).

import { CONTRACTS_SCHEMA_VERSION, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { IntentDoc } from '../intent/index.js';
import { DEFAULT_JUDGE_THRESHOLD, DEFAULT_MAX_REWORK_ITERATIONS, judgeDecomposition, judgeStory } from './loop.js';
import type { JudgeVerdict } from './verdict.js';

const DOC: IntentDoc = {
  brainDump: 'brain dump',
  statements: [
    { id: 'INT-PROBLEM-01', dimension: 'problem', text: 'p', source: 'answer' },
    { id: 'INT-AUDIENCE-01', dimension: 'audience', text: 'a', source: 'answer' },
    { id: 'INT-OUTCOME-01', dimension: 'outcome', text: 'o', source: 'answer' },
    { id: 'INT-SCOPE-01', dimension: 'scope', text: 's', source: 'answer' },
  ],
  gaps: [],
  status: 'approved',
  approvedBy: 'Pat',
};

function buildStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'A story',
    role: 'user',
    want: 'a thing',
    soThat: 'value happens',
    problemStatement: 'p',
    inScope: ['s'],
    outOfScope: ['n'],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: ['INT-SCOPE-01'] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01', 'INT-OUTCOME-01'],
    ...overrides,
  };
}

const STORY = buildStory();

function scoreQueueJudge(scores: readonly number[]) {
  let i = 0;
  return vi.fn(async (): Promise<JudgeVerdict> => {
    const score = scores[Math.min(i, scores.length - 1)]!;
    i += 1;
    return { score, rationale: `score ${score}`, checks: [] };
  });
}

function passthroughRework() {
  let i = 0;
  return vi.fn(async (story: Story) => {
    i += 1;
    return { ...story, title: `${story.title} v${i}` };
  });
}

describe('judgeStory', () => {
  it('passes immediately when the judge scores at or above threshold, without reworking', async () => {
    const judge = scoreQueueJudge([90]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 80 });

    expect(judged.stopReason).toBe('passed');
    expect(judged.iterations).toBe(0);
    expect(judged.scoreHistory).toEqual([90]);
    expect(rework).not.toHaveBeenCalled();
  });

  it('reworks a below-threshold story with the story, verdict, and doc', async () => {
    const judge = scoreQueueJudge([10, 90]);
    const rework = passthroughRework();
    await judgeStory(STORY, DOC, { judge, rework }, { threshold: 80, maxIterations: 3 });

    expect(rework).toHaveBeenCalledWith(STORY, expect.objectContaining({ score: 10 }), DOC);
  });

  it('stops at max-iterations when scores improve but never reach threshold', async () => {
    const judge = scoreQueueJudge([10, 20, 30, 40]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 90, maxIterations: 3 });

    expect(judged.stopReason).toBe('max-iterations');
    expect(judged.iterations).toBe(3);
    expect(judge).toHaveBeenCalledTimes(4);
    expect(judged.scoreHistory).toEqual([10, 20, 30, 40]);
  });

  it('stops at no-improvement when a rework fails to strictly beat the best score', async () => {
    const judge = scoreQueueJudge([10, 10]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 90, maxIterations: 3 });

    expect(judged.stopReason).toBe('no-improvement');
    expect(judged.iterations).toBe(1);
    expect(judged.scoreHistory).toEqual([10, 10]);
  });

  it('keeps the best story/verdict, not the regressed candidate, on a regression', async () => {
    const judge = scoreQueueJudge([10, 5]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 90, maxIterations: 3 });

    expect(judged.stopReason).toBe('no-improvement');
    expect(judged.verdict.score).toBe(10);
    expect(judged.story).toBe(STORY);
  });

  it('passes mid-loop and keeps the reworked candidate that crossed the threshold', async () => {
    const judge = scoreQueueJudge([10, 95]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 90, maxIterations: 3 });

    expect(judged.stopReason).toBe('passed');
    expect(judged.iterations).toBe(1);
    expect(judged.story).not.toBe(STORY);
    expect(judged.story.title).toBe('A story v1');
  });

  it('cannot run indefinitely even against an adversarial always-improving judge', async () => {
    let calls = 0;
    const judge = vi.fn(async (): Promise<JudgeVerdict> => {
      calls += 1;
      return { score: calls, rationale: `score ${calls}`, checks: [] };
    });
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 100, maxIterations: 5 });

    expect(judged.stopReason).toBe('max-iterations');
    expect(judged.iterations).toBe(5);
    expect(judge).toHaveBeenCalledTimes(6);
  });

  it('never reworks and stops at max-iterations when maxIterations is 0', async () => {
    const judge = scoreQueueJudge([10]);
    const rework = passthroughRework();
    const judged = await judgeStory(STORY, DOC, { judge, rework }, { threshold: 90, maxIterations: 0 });

    expect(judged.stopReason).toBe('max-iterations');
    expect(judged.iterations).toBe(0);
    expect(rework).not.toHaveBeenCalled();
  });

  it('rejects a negative maxIterations', async () => {
    await expect(judgeStory(STORY, DOC, {}, { maxIterations: -1 })).rejects.toThrow(/judge loop:/);
  });

  it('rejects a non-integer maxIterations', async () => {
    await expect(judgeStory(STORY, DOC, {}, { maxIterations: 1.5 })).rejects.toThrow(/judge loop:/);
  });

  it('rejects a threshold above 100', async () => {
    await expect(judgeStory(STORY, DOC, {}, { threshold: 101 })).rejects.toThrow(/judge loop:/);
  });

  it('rejects a negative threshold', async () => {
    await expect(judgeStory(STORY, DOC, {}, { threshold: -1 })).rejects.toThrow(/judge loop:/);
  });

  it('rejects a NaN threshold', async () => {
    await expect(judgeStory(STORY, DOC, {}, { threshold: Number.NaN })).rejects.toThrow(/judge loop:/);
  });

  it('uses the deterministic rubric judge and mechanical reworker by default', async () => {
    const judged = await judgeStory(STORY, DOC);

    expect(judged.verdict.score).toBe(100);
    expect(judged.stopReason).toBe('passed');
    expect(judged.iterations).toBe(0);
  });
});

describe('judgeDecomposition', () => {
  it('preserves story order, echoes threshold/maxIterations, and reports allPassed', async () => {
    const storyA = buildStory({ title: 'Story A' });
    const storyB = buildStory({ title: 'Story B' });
    const epic: Epic = {
      schemaVersion: CONTRACTS_SCHEMA_VERSION,
      kind: 'epic',
      title: 'Epic',
      why: 'why',
      doneWhen: ['done'],
      children: [storyA.title, storyB.title],
      labels: [],
      tracesTo: [],
    };
    const judge = vi.fn(async (story: Story): Promise<JudgeVerdict> =>
      story.title === 'Story A'
        ? { score: 100, rationale: 'All checks passed.', checks: [] }
        : { score: 10, rationale: 'not enough', checks: [] },
    );
    const rework = passthroughRework();

    const report = await judgeDecomposition(
      { epic, stories: [storyA, storyB] },
      DOC,
      { judge, rework },
      { threshold: 80, maxIterations: 1 },
    );

    expect(report.stories.map((s) => s.story.title)).toEqual(['Story A', 'Story B']);
    expect(report.threshold).toBe(80);
    expect(report.maxIterations).toBe(1);
    expect(report.allPassed).toBe(false);
    for (const judged of report.stories) {
      expect(judged.verdict.score).toBeGreaterThanOrEqual(0);
      expect(judged.verdict.rationale.length).toBeGreaterThan(0);
      expect(['passed', 'no-improvement', 'max-iterations']).toContain(judged.stopReason);
    }
  });

  it('reports allPassed true when every story passes', async () => {
    const storyA = buildStory({ title: 'Story A' });
    const epic: Epic = {
      schemaVersion: CONTRACTS_SCHEMA_VERSION,
      kind: 'epic',
      title: 'Epic',
      why: 'why',
      doneWhen: ['done'],
      children: [storyA.title],
      labels: [],
      tracesTo: [],
    };
    const judge = scoreQueueJudge([100]);

    const report = await judgeDecomposition({ epic, stories: [storyA] }, DOC, { judge });

    expect(report.allPassed).toBe(true);
  });
});

describe('defaults', () => {
  it('exposes the default threshold and max iterations', () => {
    expect(DEFAULT_JUDGE_THRESHOLD).toBe(80);
    expect(DEFAULT_MAX_REWORK_ITERATIONS).toBe(3);
  });
});
