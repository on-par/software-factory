import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  compareReadinessToBaseline,
  loadReadinessCases,
  readinessStubSteps,
  runReadinessEval,
  toReadinessBaseline,
} from './readiness.js';
import type { ReadinessBaseline, ReadinessCase, ReadinessEvalSummary } from './readiness.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: ['checker'],
      costPerMtokInput: 1,
      costPerMtokOutput: 1,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { checker: ['stub-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    readiness_judge: { tier: 'checker', description: 'stub' },
    eval_judge: { tier: 'checker', description: 'stub judge' },
  },
};

const REPO_DIR = resolve(import.meta.dirname, '../../../../evals/readiness');

function verdictJson(
  verdict: 'ready' | 'ready-with-assumptions' | 'not-ready',
  questionText = 'What is meant?',
): string {
  const item = (text: string) => ({ aspect: 'other', text });
  return JSON.stringify({
    schemaVersion: 1,
    verdict,
    summary: 's',
    assumptions: verdict === 'ready-with-assumptions' ? [item('assume')] : [],
    questions: verdict === 'not-ready' ? [item(questionText)] : [],
  });
}

function makeCase(over: Partial<ReadinessCase> & { id: string }): ReadinessCase {
  return {
    title: 'Title',
    body: 'First body line\nsecond line',
    expectedVerdict: 'ready',
    acceptableVerdicts: [over.expectedVerdict ?? 'ready'],
    mustAsk: [],
    labels: [],
    rubric: [],
    minRubricScore: 7,
    path: `${over.id}.md`,
    ...over,
  };
}

function build(cases: ReadinessCase[], extra: Record<string, { output: string }[]> = {}) {
  const executor = new StubModelExecutor({
    scripts: { readiness_judge: cases.flatMap(readinessStubSteps), ...extra },
  });
  return { router: new ModelRouter(models, routes, false, executor), executor };
}

describe('loadReadinessCases', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  it('parses frontmatter, title, body and stub-output with default acceptableVerdicts', async () => {
    const dir = await tempDirs.make('readiness-');
    await writeFile(
      join(dir, 'a.md'),
      '---\nexpectedVerdict: not-ready\nmustAsk: [which]\nlabels: [x]\n---\n# T\n\nBody here\n\n```stub-output\n{"a":1}\n```\n',
    );
    const [c] = await loadReadinessCases(dir);
    expect(c).toMatchObject({
      id: 'a',
      title: 'T',
      body: 'Body here',
      expectedVerdict: 'not-ready',
      acceptableVerdicts: ['not-ready'],
      mustAsk: ['which'],
      labels: ['x'],
      stubOutput: '{"a":1}',
      minRubricScore: 7,
    });
  });

  it('allows an empty body', async () => {
    const dir = await tempDirs.make('readiness-');
    await writeFile(join(dir, 'a.md'), '---\nexpectedVerdict: not-ready\n---\n# Only title\n');
    const [c] = await loadReadinessCases(dir);
    expect(c.body).toBe('');
    expect(c.stubOutput).toBeUndefined();
  });

  it('throws on an invalid expectedVerdict, acceptableVerdict or non-array mustAsk', async () => {
    const dir = await tempDirs.make('readiness-');
    await writeFile(join(dir, 'a.md'), '---\nexpectedVerdict: maybe\n---\n# T\n');
    await expect(loadReadinessCases(dir)).rejects.toThrow("invalid expectedVerdict 'maybe'");
    await writeFile(join(dir, 'a.md'), '---\nexpectedVerdict: ready\nacceptableVerdicts: [nope]\n---\n# T\n');
    await expect(loadReadinessCases(dir)).rejects.toThrow('invalid acceptableVerdicts entry');
    await writeFile(join(dir, 'a.md'), '---\nexpectedVerdict: ready\nmustAsk: x\n---\n# T\n');
    await expect(loadReadinessCases(dir)).rejects.toThrow('mustAsk must be an array');
  });

  it('loads the 12 committed cases', async () => {
    expect(await loadReadinessCases(REPO_DIR)).toHaveLength(12);
  });
});

describe('readinessStubSteps', () => {
  it('emits one step for a valid verdict and two for malformed output', () => {
    expect(readinessStubSteps(makeCase({ id: 'a', stubOutput: verdictJson('ready') }))).toHaveLength(1);
    expect(readinessStubSteps(makeCase({ id: 'b', stubOutput: '{"verdict": "ready",' }))).toHaveLength(2);
    expect(readinessStubSteps(makeCase({ id: 'c' }))).toHaveLength(2);
  });
});

describe('runReadinessEval', () => {
  it('passes all committed cases on the stub router', async () => {
    const cases = await loadReadinessCases(REPO_DIR);
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results.filter((r) => !r.pass)).toEqual([]);
    expect(summary.falseReadyRate).toBe(0);
    expect(summary.falseNotReadyRate).toBe(0);
    expect(summary.judgeErrors).toBe(1);
  });

  it('passes a case that expects judge-error when the stub output is malformed JSON and counts judgeErrors 1', async () => {
    const cases = [makeCase({ id: 'm', expectedVerdict: 'judge-error', stubOutput: '{"verdict": "ready",' })];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results[0].pass).toBe(true);
    expect(summary.results[0].verdict).toBe('judge-error');
    expect(summary.judgeErrors).toBe(1);
  });

  it('fails must-ask when no question contains any mustAsk keyword', async () => {
    const cases = [
      makeCase({
        id: 'n',
        expectedVerdict: 'not-ready',
        mustAsk: ['default'],
        stubOutput: verdictJson('not-ready', 'What is meant?'),
      }),
    ];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    const check = summary.results[0].checks.find((c) => c.name === 'must-ask');
    expect(check?.pass).toBe(false);
    expect(summary.results[0].pass).toBe(false);
    expect(summary.mustAskHitRate).toBe(0);
  });

  it('records a false-ready when a not-ready case is judged ready', async () => {
    const cases = [makeCase({ id: 'n', expectedVerdict: 'not-ready', stubOutput: verdictJson('ready') })];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results[0].checks.find((c) => c.name === 'verdict-correct')?.pass).toBe(false);
    expect(summary.falseReadyRate).toBe(1);
    expect(summary.confusion['not-ready'].ready).toBe(1);
  });

  it('raises falseNotReadyRate when a ready case is judged not-ready', async () => {
    const cases = [
      makeCase({ id: 'a', stubOutput: verdictJson('not-ready') }),
      makeCase({ id: 'b', stubOutput: verdictJson('ready') }),
    ];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.falseNotReadyRate).toBe(0.5);
    expect(summary.confusion.ready['not-ready']).toBe(1);
    expect(summary.confusion.ready.ready).toBe(1);
  });

  it('checks prompt-wraps-body for a normal body and an empty body', async () => {
    const cases = [
      makeCase({ id: 'a', stubOutput: verdictJson('ready') }),
      makeCase({ id: 'b', body: '', stubOutput: verdictJson('ready') }),
    ];
    const { router, executor } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results[0].checks[0]).toMatchObject({ name: 'prompt-wraps-body', pass: true });
    expect(summary.results[1].checks[0]).toMatchObject({
      name: 'prompt-wraps-body',
      pass: true,
      details: 'empty body',
    });
    expect(executor.calls[0].prompt).toContain('<untrusted-issue-body>');
    expect(executor.calls[0].prompt).toContain('First body line');
  });

  it('scores with the eval judge in judge mode and fails below minRubricScore', async () => {
    const cases = [
      makeCase({ id: 'a', rubric: ['good'], stubOutput: verdictJson('ready') }),
      makeCase({ id: 'b', rubric: ['good'], stubOutput: verdictJson('ready') }),
    ];
    const { router } = build(cases, {
      eval_judge: [{ output: '{"score":8,"reasons":"ok"}' }, { output: '{"score":3,"reasons":"bad"}' }],
    });
    const summary = await runReadinessEval({ cases, router, judge: true });
    expect(summary.results[0]).toMatchObject({ rubricScore: 8, pass: true, judgeSkipped: false });
    expect(summary.results[1]).toMatchObject({ rubricScore: 3, pass: false });
  });

  it('marks a malformed judge reply', async () => {
    const cases = [makeCase({ id: 'a', rubric: ['good'], stubOutput: verdictJson('ready') })];
    const { router } = build(cases, { eval_judge: [{ output: 'nope' }] });
    const summary = await runReadinessEval({ cases, router, judge: true });
    expect(summary.results[0]).toMatchObject({ judgeMalformed: true, pass: false });
  });

  it('turns a router throw into a judge error', async () => {
    const cases = [makeCase({ id: 'a', stubOutput: verdictJson('ready') })];
    const router = new ModelRouter(models, routes, false, new StubModelExecutor());
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results[0].verdict).toBe('judge-error');
    expect(summary.results[0].error).toContain('model-error');
    expect(summary.results[0].checks.find((c) => c.name === 'prompt-wraps-body')?.pass).toBe(true);
  });

  it('treats an epic as a judge error', async () => {
    const cases = [makeCase({ id: 'e', labels: ['epic'], stubOutput: verdictJson('ready') })];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    expect(summary.results[0]).toMatchObject({ verdict: 'judge-error', error: 'skipped: epic', pass: false });
    expect(summary.results[0].checks.find((c) => c.name === 'prompt-wraps-body')?.details).toBe('no prompt sent');
  });

  it('handles an empty case list', async () => {
    const { router } = build([]);
    const summary = await runReadinessEval({ cases: [], router, judge: false });
    expect(summary).toMatchObject({ total: 0, accuracy: 0, mustAskHitRate: 1, falseReadyRate: 0 });
  });
});

function summaryOf(over: Partial<ReadinessEvalSummary> = {}): ReadinessEvalSummary {
  return {
    results: [],
    total: 0,
    passed: 0,
    failed: 0,
    accuracy: 1,
    confusion: {
      ready: { ready: 0, 'ready-with-assumptions': 0, 'not-ready': 0 },
      'ready-with-assumptions': { ready: 0, 'ready-with-assumptions': 0, 'not-ready': 0 },
      'not-ready': { ready: 0, 'ready-with-assumptions': 0, 'not-ready': 0 },
    },
    falseReadyRate: 0,
    falseNotReadyRate: 0,
    mustAskHitRate: 1,
    judgeErrors: 0,
    totalCostEstimate: 0,
    totalLatencyMs: 0,
    ...over,
  };
}

const baseline: ReadinessBaseline = {
  version: 1,
  suite: 'readiness',
  tolerance: { falseReadyRate: 0, falseNotReadyRate: 0.1, rubricScore: 1 },
  budgets: { totalCostEstimate: 0.5 },
  accuracy: 1,
  falseReadyRate: 0,
  falseNotReadyRate: 0,
  cases: { a: { pass: true, verdict: 'ready', rubricScore: 9 } },
};

describe('compareReadinessToBaseline', () => {
  it('flags any rise in falseReadyRate as a false-ready regression when a not-ready case is judged ready', async () => {
    const cases = [makeCase({ id: 'n', expectedVerdict: 'not-ready', stubOutput: verdictJson('ready') })];
    const { router } = build(cases);
    const summary = await runReadinessEval({ cases, router, judge: false });
    const cmp = compareReadinessToBaseline(summary, baseline);
    expect(cmp.ok).toBe(false);
    expect(cmp.regressions.some((r) => r.includes('false-ready') && r.includes('n'))).toBe(true);
  });

  it('tolerates a small false-not-ready rise but flags a large one', () => {
    expect(compareReadinessToBaseline(summaryOf({ falseNotReadyRate: 0.08 }), baseline).ok).toBe(true);
    const cmp = compareReadinessToBaseline(summaryOf({ falseNotReadyRate: 0.2 }), baseline);
    expect(cmp.ok).toBe(false);
    expect(cmp.regressions[0]).toContain('false-not-ready rate rose');
  });

  it('flags a case that passed and now fails, and a rubric drop', () => {
    const result = {
      id: 'a',
      pass: false,
      verdict: 'ready' as const,
      expectedVerdict: 'ready' as const,
      checks: [],
      rubricScore: 5,
      judgeSkipped: false,
      model: 'm',
      latencyMs: 0,
      costEstimate: 0,
    };
    const cmp = compareReadinessToBaseline(summaryOf({ results: [result] }), baseline);
    expect(cmp.regressions).toEqual([
      "case 'a' was passing in the baseline and now fails",
      "case 'a' rubric score dropped: 5 < baseline 9 - tolerance 1",
    ]);
  });

  it('flags an over-budget cost', () => {
    const cmp = compareReadinessToBaseline(summaryOf({ totalCostEstimate: 1 }), baseline);
    expect(cmp.regressions[0]).toContain('estimated cost exceeds budget');
  });

  it('notes cases missing on either side', () => {
    const result = {
      id: 'z',
      pass: true,
      verdict: 'ready' as const,
      expectedVerdict: 'ready' as const,
      checks: [],
      judgeSkipped: true,
      model: 'm',
      latencyMs: 0,
      costEstimate: 0,
    };
    const cmp = compareReadinessToBaseline(summaryOf({ results: [result] }), baseline);
    expect(cmp.ok).toBe(true);
    expect(cmp.notes).toEqual([
      "case 'z' is present in the run but missing from the baseline",
      "case 'a' is present in the baseline but missing from the run",
    ]);
  });
});

describe('toReadinessBaseline', () => {
  it('uses default tolerances and records per-case results', () => {
    const result = {
      id: 'a',
      pass: true,
      verdict: 'ready' as const,
      expectedVerdict: 'ready' as const,
      checks: [],
      rubricScore: 8,
      judgeSkipped: false,
      model: 'm',
      latencyMs: 0,
      costEstimate: 0,
    };
    const b = toReadinessBaseline(summaryOf({ results: [result] }));
    expect(b.tolerance).toEqual({ falseReadyRate: 0, falseNotReadyRate: 0.1, rubricScore: 1 });
    expect(b.budgets).toBeUndefined();
    expect(b.cases.a).toEqual({ pass: true, verdict: 'ready', rubricScore: 8 });
  });

  it('carries over given tolerance and budgets', () => {
    const tol = { falseReadyRate: 0.1, falseNotReadyRate: 0.2, rubricScore: 2 };
    const b = toReadinessBaseline(summaryOf(), tol, { totalCostEstimate: 0.5 });
    expect(b.tolerance).toEqual(tol);
    expect(b.budgets).toEqual({ totalCostEstimate: 0.5 });
  });
});
