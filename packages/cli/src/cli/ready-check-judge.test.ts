import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DeepCheckError,
  ReadinessJudgeError,
  applyJudgeResult,
  buildIssueCheckReport,
  runIssueCheck,
} from './ready-check.js';
import { body, deps } from './test-support/ready-check-fixtures.js';

const SPLIT_JSON = JSON.stringify({
  epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Child one'] },
  stories: [
    {
      title: 'Child one',
      role: 'operator',
      want: 'the thing works',
      soThat: 'value',
      problemStatement: 'problem',
      inScope: ['item'],
      outOfScope: ['other'],
      acceptanceCriteria: [{ name: 'Works', given: [], when: ['run'], then: ['it works'] }],
      verification: [{ command: 'npm test', passWhen: 'passes' }],
    },
  ],
});

const READY = JSON.stringify({ schemaVersion: 1, verdict: 'ready', summary: 'Clear.', assumptions: [], questions: [] });

const verdictJson = (verdict: string, questions: unknown[] = [], assumptions: unknown[] = []) =>
  JSON.stringify({ schemaVersion: 1, verdict, summary: 'Summary.', assumptions, questions });

/** Fake runner: answers readiness_judge with `judgeOutputs` in order (last repeats), decompose with SPLIT_JSON. */
function judgeRunner(judgeOutputs: string[], calls: Array<[string, string]> = [], cost: number | null = 0.02) {
  let n = 0;
  return vi.fn(async (task: string, prompt: string) => {
    calls.push([task, prompt]);
    if (task === 'decompose') return { model: 'fake-model', output: SPLIT_JSON, cost };
    const output = judgeOutputs[Math.min(n, judgeOutputs.length - 1)]!;
    n += 1;
    return { model: 'fake-model', output, cost };
  });
}

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());
const cacheDir = () => tmp.makeSync('ready-check-cache-');
const PLAIN = 'Customers cannot reset their password from the login page. Add a reset link that emails a token.';

describe('runIssueCheck readiness judge', () => {
  it('prints not-ready questions with [aspect] and exits 1', async () => {
    const { lines, d } = deps(PLAIN);
    const questions = [
      { aspect: 'scope', text: 'Which login page?' },
      { aspect: 'decision', text: 'Token lifetime?' },
    ];
    const runModel = judgeRunner([verdictJson('not-ready', questions)]);
    const r = await runIssueCheck(7, {}, { ...d, runModel, readinessCacheDir: cacheDir() });
    expect(r.exitCode).toBe(1);
    expect(lines[0]).toBe('issue #7: not-ready (fake-model, fresh, $0.0200)');
    expect(lines).toContain('summary: Summary.');
    expect(lines).toContain('  1. [scope] Which login page?');
    expect(lines).toContain('  2. [decision] Token lifetime?');
    expect(r.reasons).toContain('question: [scope] Which login page?');
  });

  it('prints assumptions and exits 0 for ready-with-assumptions', async () => {
    const { lines, d } = deps(PLAIN);
    const runModel = judgeRunner([verdictJson('ready-with-assumptions', [], [{ aspect: 'scope', text: 'Web only.' }])]);
    const r = await runIssueCheck(7, {}, { ...d, runModel, readinessCacheDir: cacheDir() });
    expect(r.exitCode).toBe(0);
    expect(lines).toContain('assumptions:');
    expect(lines).toContain('  1. [scope] Web only.');
  });

  it('ready verdict on a plain-text ticket exits 0 while fields.pass is false', async () => {
    const { d } = deps(PLAIN);
    const r = await runIssueCheck(7, {}, { ...d, runModel: judgeRunner([READY]) });
    expect(r.verdict).toBe('ready');
    expect(r.fields.pass).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('serves the second check from the cache and --rejudge calls the runner', async () => {
    const { d } = deps(PLAIN);
    const runModel = judgeRunner([READY]);
    const full = { ...d, runModel, readinessCacheDir: cacheDir() };
    const first = await runIssueCheck(7, {}, full);
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(first.judge?.cached).toBe(false);
    const second = await runIssueCheck(7, {}, full);
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(second.judge).toMatchObject({ cached: true, cost: 0 });
    await runIssueCheck(7, { rejudge: true }, full);
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it('--no-judge calls no model, verdict null, exits 1 on missing headings', async () => {
    const { d } = deps(PLAIN);
    const runModel = vi.fn();
    const r = await runIssueCheck(7, { judge: false }, { ...d, runModel });
    expect(runModel).not.toHaveBeenCalled();
    expect(r).toMatchObject({ verdict: null, summary: null, judge: null, questions: [], assumptions: [], exitCode: 1 });
  });

  it('throws ReadinessJudgeError naming invalid-json after two bad replies', async () => {
    const { d } = deps(PLAIN);
    const runModel = judgeRunner(['not json']);
    await expect(runIssueCheck(7, {}, { ...d, runModel })).rejects.toThrow(/invalid-json/);
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it('throws ReadinessJudgeError for a schema violation, a failing model, and a missing runner', async () => {
    const { d } = deps(PLAIN);
    await expect(runIssueCheck(7, {}, { ...d, runModel: judgeRunner(['{"verdict":"maybe"}']) })).rejects.toThrow(
      /schema-violation/,
    );
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(runIssueCheck(7, {}, { ...d, runModel: failing })).rejects.toThrow(/model-error.*boom/);
    await expect(runIssueCheck(7, {}, d)).rejects.toBeInstanceOf(ReadinessJudgeError);
  });

  it('epic is skipped with verdict null and heading exit code', async () => {
    const { lines, d } = deps('### Goal\n\nBig.\n', 'Epic: big');
    const runModel = vi.fn();
    const r = await runIssueCheck(7, {}, { ...d, runModel });
    expect(runModel).not.toHaveBeenCalled();
    expect(r).toMatchObject({ verdict: null, judge: null, judgeSkipped: 'epic' });
    expect(lines).toContain('judge - skipped (epic)');
  });

  it('not-ready wins over would-split; ready + would-split exits 3', async () => {
    const { d } = deps(body(7));
    const q = [{ aspect: 'scope', text: 'Why?' }];
    const notReady = await runIssueCheck(7, {}, { ...d, runModel: judgeRunner([verdictJson('not-ready', q)]) });
    expect(notReady.exitCode).toBe(1);
    expect(notReady.reasons).toHaveLength(2);
    const ready = await runIssueCheck(7, {}, { ...d, runModel: judgeRunner([READY]) });
    expect(ready.exitCode).toBe(3);
  });

  it('passes labels so an epic label skips the judge', async () => {
    const lines: string[] = [];
    const runModel = vi.fn();
    const r = await runIssueCheck(
      7,
      {},
      {
        getIssue: async () => ({ title: 'x', body: PLAIN, labels: ['epic'] }),
        log: (l) => lines.push(l),
        runModel,
      },
    );
    expect(r.judgeSkipped).toBe('epic');
  });
});

describe('applyJudgeResult', () => {
  const report = buildIssueCheckReport(1, { template: 'factory-task', score: 1, pass: true, missing: [] } as never);
  const verdictResult = (cached: boolean) =>
    ({
      kind: 'verdict',
      verdict: JSON.parse(READY),
      model: 'm',
      cost: cached ? 0 : 0.5,
      cached,
      promptVersion: 'v',
      bodyHash: 'h',
    }) as never;

  it('reports cached results as free and priced', () => {
    expect(applyJudgeResult(report, verdictResult(true), true).judge).toMatchObject({ cost: 0, unpriced: false });
  });

  it('reports an unpriced fresh result with null cost', () => {
    expect(applyJudgeResult(report, verdictResult(false), true).judge).toMatchObject({ cost: null, unpriced: true });
  });
});

describe('runIssueCheck --deep', () => {
  it('previews the split and makes only readiness_judge and decompose calls', async () => {
    const { lines, d } = deps(body(7));
    const calls: Array<[string, string]> = [];
    const runModel = judgeRunner([READY], calls);
    const r = await runIssueCheck(7, { deep: true }, { ...d, runModel });
    expect(calls.map(([t]) => t)).toEqual(['readiness_judge', 'decompose']);
    expect(calls.some(([, p]) => p.includes('readiness gaps'))).toBe(false);
    expect(r.deep?.kind).toBe('split');
    expect(r.exitCode).toBe(3);
    expect(lines).toContain('  1. Child one');
    expect(lines).toContain('     - Works (When: run — Then: it works)');
    expect(lines.at(-1)).toBe('model: fake-model, cost: $0.0200');
  });

  it('makes only the judge call for a ticket that runs as-is', async () => {
    const { lines, d } = deps(body(3));
    const calls: Array<[string, string]> = [];
    await runIssueCheck(7, { deep: true }, { ...d, runModel: judgeRunner([READY], calls) });
    expect(calls.map(([t]) => t)).toEqual(['readiness_judge']);
    expect(lines).toContain('deep: runs as-is, no split preview');
  });

  it('supports --deep with --no-judge for the split only', async () => {
    const { d } = deps(body(7));
    const calls: Array<[string, string]> = [];
    await runIssueCheck(7, { deep: true, judge: false }, { ...d, runModel: judgeRunner([READY], calls) });
    expect(calls.map(([t]) => t)).toEqual(['decompose']);
  });

  it('rejects invalid output or a failing model without printing a report', async () => {
    const { lines, d } = deps(body(7));
    const log = (l: string) => lines.push(l);
    const bad = vi.fn(async () => ({ model: 'm', output: 'not json', cost: 0 as number | null }));
    await expect(runIssueCheck(7, { deep: true, judge: false }, { ...d, log, runModel: bad })).rejects.toThrow(
      /invalid output/,
    );
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(runIssueCheck(7, { deep: true, judge: false }, { ...d, log, runModel: failing })).rejects.toThrow(
      /model call failed: boom/,
    );
    await expect(runIssueCheck(7, { deep: true, judge: false }, { ...d, log })).rejects.toThrow(DeepCheckError);
    expect(lines).toEqual([]);
  });

  it('shows unknown cost when unpriced', async () => {
    const { lines, d } = deps(body(7));
    await runIssueCheck(7, { deep: true, judge: false }, { ...d, runModel: judgeRunner([READY], [], null) });
    expect(lines.at(-1)).toBe('model: fake-model, cost: unknown (1 unpriced)');
  });

  it('adds deep to --json only when requested', async () => {
    const a = deps(body(7));
    await runIssueCheck(7, { json: true, deep: true, judge: false }, { ...a.d, runModel: judgeRunner([READY]) });
    expect(JSON.parse(a.lines[0]).deep.model).toBe('fake-model');
    const b = deps(body(7));
    const runModel = judgeRunner([READY]);
    await runIssueCheck(7, { json: true, judge: false }, { ...b.d, runModel });
    expect(JSON.parse(b.lines[0])).not.toHaveProperty('deep');
    expect(runModel).not.toHaveBeenCalled();
  });
});
