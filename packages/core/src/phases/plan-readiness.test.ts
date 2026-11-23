import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { RoutesConfig } from '../config/index.js';
import type { ReadinessJudgeMode } from '../config/readiness-mode.js';
import { FACTORY_TASK_REQUIRED_FIELDS } from '../readiness/index.js';
import { renderPrBody } from '../reports/pr-body.js';
import { commentStoreOctokit } from '../test-support/comment-store.js';
import { createPhaseTestSetup, fakeOctokit, stubModel, stubModelsConfig } from '../test-support/index.js';
import { cleanupJudgedRunDirs, makeJudgedRunDir, runIssueWithJudge } from '../test-support/readiness-run.js';
import { WorkSourceRegistry } from '../work/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { planPhase } from './plan.js';
import { writeReadinessNotes } from './plan-readiness.js';
import { specWithDesign, StubModelExecutor } from './plan-test-helpers.js';
import { readReadinessNotes } from './ship-spec.js';

const models = stubModelsConfig({ 'stub-model': stubModel() }, { boss: ['stub-model'] });
const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    readiness_judge: { tier: 'boss', description: 'stub' },
  },
};

const setup = createPhaseTestSetup();
afterEach(() => setup.cleanup());
afterAll(() => cleanupJudgedRunDirs());

type Item = { aspect: string; text: string };

function verdict(v: 'ready' | 'ready-with-assumptions' | 'not-ready', items: { q?: Item[]; a?: Item[] } = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: v,
    summary: 'judged',
    assumptions: items.a ?? [],
    questions: items.q ?? [],
  });
}

const TEMPLATED = `## Problem statement
Status output has an extra blank line.
## In scope
- Update the status renderer and its test.
## Out of scope
- Changing output format.
## Acceptance criteria
- [ ] Status has no blank line.
## Verification
npm test`;

const RENAMED = `## Background
Status output has an extra blank line.
## Work
- Update the status renderer and its test.
## Not doing
- Changing output format.
## Done when
- [ ] Status has no blank line.
## How to check
npm test`;

const PROSE =
  'Status output has an extra blank line. Update the status renderer and its test, without changing the output format. ' +
  'It is done when status has no blank line, and npm test shows it.';

const QUESTIONS: Item[] = [
  { aspect: 'scope', text: 'Which screens are affected?' },
  { aspect: 'decision', text: 'Should the old format stay available?' },
];
const ASSUMPTIONS: Item[] = [
  { aspect: 'scope', text: 'Only the CLI status view changes.' },
  { aspect: 'verification', text: 'The existing status test suite is the proof.' },
];

interface PlanOpts {
  body: string;
  title?: string;
  labels?: string[];
  mode?: ReadinessJudgeMode;
  judge?: Array<{ output: string } | { fail: 'error' }>;
  fastPath?: boolean;
  cacheDir?: string;
}

async function plan(opts: PlanOpts) {
  const worktree = await setup.worktree('plan-readiness-');
  const specPath = join(worktree, 'issue-3470.md');
  const { router, stub } = setup.router(
    models,
    routes,
    undefined,
    new StubModelExecutor({
      scripts: { readiness_judge: opts.judge ?? [], plan: [{ output: specWithDesign('Spec') }] },
    }),
  );
  const logs: Array<{ type: string; msg: string; extra: any }> = [];
  const result = await planPhase({
    issue: workKeyFromIssue(3470),
    repo: 'o/r',
    worktree,
    specPath,
    router,
    constitution: null,
    octokit: fakeOctokit({
      'issues.get': { data: { title: opts.title ?? 'Fix status output', body: opts.body, labels: opts.labels ?? [] } },
    }).octokit,
    log: (type, msg, extra) => logs.push({ type, msg, extra }),
    readinessJudge: opts.mode ?? 'enforce',
    fastPath: opts.fastPath,
    readinessCacheDir: opts.cacheDir,
  });
  const tasks = stub.calls.map((c) => c.task);
  const planPrompt = stub.calls.find((c) => c.task === 'plan')?.prompt ?? '';
  return {
    result,
    logs,
    tasks,
    planPrompt,
    specPath,
    judgePrompts: stub.calls.filter((c) => c.task === 'readiness_judge'),
  };
}

const out = (output: string) => ({ output });

describe('PLAN readiness gate (ADR-0167, #3470)', () => {
  it('a clear issue with no template headings passes the readiness gate', async () => {
    const { result, tasks } = await plan({ body: PROSE, judge: [out(verdict('ready'))] });
    expect(result.ok).toBe(true);
    expect(tasks).toEqual(['readiness_judge', 'plan']);
  });

  it('a vague one-liner is not-ready with exactly one question', async () => {
    const worktree = await makeJudgedRunDir();
    const { store, octokit } = commentStoreOctokit({
      'issues.get': { data: { title: 'Improve it', body: 'make it better' } },
    });
    const question = { aspect: 'problem', text: 'What should be better, and how will we know it is done?' };
    const { outcome, tasks } = await runIssueWithJudge({
      worktree,
      cacheDir: join(worktree, 'cache'),
      octokit,
      mode: 'enforce',
      judge: [verdict('not-ready', { q: [question] })],
      title: 'Improve it',
      body: 'make it better',
    });
    expect(outcome).toMatchObject({ state: 'parked', reason: 'not-ready' });
    expect(tasks).toEqual(['readiness_judge']);
    expect(store).toHaveLength(1);
    const comment = store[0]?.body ?? '';
    expect(comment.match(/^\d+\. \[/gm)).toEqual(['1. [']);
    expect(comment).toContain(question.text);
    for (const heading of FACTORY_TASK_REQUIRED_FIELDS) {
      expect(comment.toLowerCase()).not.toContain(heading.toLowerCase());
    }
  });

  it('a templated issue still passes the readiness gate', async () => {
    const { result, tasks } = await plan({ body: TEMPLATED, judge: [out(verdict('ready'))] });
    expect(result.ok).toBe(true);
    expect(tasks).toEqual(['readiness_judge', 'plan']);
  });

  it('the readiness gate does not depend on heading strings', async () => {
    for (const judged of [verdict('ready'), verdict('not-ready', { q: QUESTIONS })]) {
      const outcomes = [];
      for (const body of [TEMPLATED, RENAMED, PROSE]) {
        const { result, tasks } = await plan({ body, judge: [out(judged)] });
        outcomes.push({ ok: result.ok, parkReason: result.parkReason, questions: result.questions, tasks });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[2]).toEqual(outcomes[0]);
    }
    const parked = await plan({ body: TEMPLATED, judge: [out(verdict('not-ready', { q: QUESTIONS }))] });
    expect(parked.result).toMatchObject({ ok: false, parkReason: 'not-ready', questions: QUESTIONS });
    expect(parked.tasks).toEqual(['readiness_judge']);
    for (const heading of FACTORY_TASK_REQUIRED_FIELDS) expect(parked.result.escalate).not.toContain(heading);
  });

  it('enforce: invalid judge output twice escalates with no cache entry and no PLAN call', async () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      verdict: 'ready',
      summary: 's',
      assumptions: [],
      questions: QUESTIONS,
    });
    const worktree = await setup.worktree('plan-readiness-cache-');
    const cacheDir = join(worktree, 'cache');
    const { result, tasks } = await plan({ body: PROSE, judge: [out(bad), out(bad)], cacheDir });
    expect(result.ok).toBe(false);
    expect(result.parkReason).toBeUndefined();
    expect(result.escalate).toMatch(/^readiness judge failed \(schema-violation\): /);
    expect(tasks).toEqual(['readiness_judge', 'readiness_judge']);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  it('enforce: a judge model error escalates before PLAN', async () => {
    const { result, tasks } = await plan({ body: PROSE, judge: [{ fail: 'error' }] });
    expect(result.ok).toBe(false);
    expect(result.escalate).toMatch(/^readiness judge failed \(model-error\): /);
    expect(tasks).not.toContain('plan');
  });

  it('repairs one invalid judge reply and proceeds (judge repair-retry regression, #816)', async () => {
    const { result, tasks, judgePrompts } = await plan({
      body: PROSE,
      judge: [out('not a verdict'), out(verdict('ready'))],
    });
    expect(result.ok).toBe(true);
    expect(tasks).toEqual(['readiness_judge', 'readiness_judge', 'plan']);
    expect(judgePrompts[1]?.prompt).toContain('Your previous reply was rejected');
  });

  it('advisory: a not-ready verdict proceeds and the PR body lists its questions as advisory', async () => {
    const { result, tasks, specPath } = await plan({
      body: PROSE,
      mode: 'advisory',
      judge: [out(verdict('not-ready', { q: QUESTIONS }))],
    });
    expect(result.ok).toBe(true);
    expect(tasks).toEqual(['readiness_judge', 'plan']);
    const notes = await readReadinessNotes(specPath);
    const body = renderPrBody({ summaryLine: 'Implements #3470.', advisoryQuestions: notes.questions });
    expect(body).toContain('## Unanswered readiness questions (advisory)');
    for (const q of QUESTIONS) expect(body).toContain(q.text);
  });

  it('advisory: a judge error is logged and PLAN still runs', async () => {
    const { result, tasks, logs } = await plan({ body: PROSE, mode: 'advisory', judge: [{ fail: 'error' }] });
    expect(result.ok).toBe(true);
    expect(tasks.at(-1)).toBe('plan');
    expect(logs.find((l) => l.type === 'readiness')?.msg).toContain('readiness judge failed (model-error)');
  });

  it('off: makes no judge call and the fast path uses the heading score', async () => {
    const { result, tasks } = await plan({
      body: TEMPLATED,
      mode: 'off',
      fastPath: true,
      judge: [out(verdict('not-ready', { q: QUESTIONS }))],
    });
    expect(result).toMatchObject({ ok: true, model: 'fast-path' });
    expect(tasks).toEqual([]);
  });

  it('the fast path needs a ready verdict', async () => {
    const ready = await plan({ body: TEMPLATED, fastPath: true, judge: [out(verdict('ready'))] });
    expect(ready.result.model).toBe('fast-path');
    expect(ready.tasks).toEqual(['readiness_judge']);
    expect(ready.logs.filter((l) => l.type === 'readiness')).toHaveLength(1);
    const assumed = await plan({
      body: TEMPLATED,
      fastPath: true,
      judge: [out(verdict('ready-with-assumptions', { a: ASSUMPTIONS }))],
    });
    expect(assumed.result.model).not.toBe('fast-path');
    expect(assumed.tasks).toEqual(['readiness_judge', 'plan']);
  });

  it('ready-with-assumptions hands the assumptions to PLAN only inside the untrusted readiness block and to the PR body', async () => {
    const { result, planPrompt, specPath } = await plan({
      body: PROSE,
      judge: [out(verdict('ready-with-assumptions', { a: ASSUMPTIONS }))],
    });
    expect(result.ok).toBe(true);
    const open = planPrompt.indexOf('<untrusted-readiness-notes>\n');
    const close = planPrompt.indexOf('\n</untrusted-readiness-notes>');
    expect(open).toBeGreaterThan(-1);
    for (const a of ASSUMPTIONS) {
      expect(planPrompt.split(a.text)).toHaveLength(2);
      expect(planPrompt.indexOf(a.text)).toBeGreaterThan(open);
      expect(planPrompt.indexOf(a.text)).toBeLessThan(close);
    }
    const notes = await readReadinessNotes(specPath);
    const body = renderPrBody({ summaryLine: 'Implements #3470.', assumptions: notes.assumptions });
    expect(body).toContain('## Assumptions');
    for (const a of ASSUMPTIONS) expect(body).toContain(a.text);
  });

  it('a ready verdict leaves the PR body without an Assumptions section', async () => {
    const { planPrompt, specPath } = await plan({ body: PROSE, judge: [out(verdict('ready'))] });
    expect(planPrompt).not.toContain('<untrusted-readiness-notes>');
    const notes = await readReadinessNotes(specPath);
    expect(renderPrBody({ summaryLine: 'Implements #3470.', assumptions: notes.assumptions })).not.toContain(
      '## Assumptions',
    );
  });

  it('logs one readiness event right after the verdict, carrying the judge result', async () => {
    const { logs } = await plan({ body: PROSE, judge: [out(verdict('ready-with-assumptions', { a: ASSUMPTIONS }))] });
    const events = logs.filter((l) => l.type === 'readiness');
    expect(events).toHaveLength(1);
    expect(events[0]?.extra.readiness.judge).toEqual({
      verdict: 'ready-with-assumptions',
      questions: [],
      assumptions: ASSUMPTIONS,
      aspects: ['scope', 'verification'],
      cached: false,
      model: 'stub-model',
      promptVersion: 'readiness-judge/v1',
    });
    expect(events[0]?.msg).not.toContain('missing');
    const started = logs.findIndex((l) => l.msg === 'Starting plan phase');
    expect(logs.findIndex((l) => l.type === 'readiness')).toBeLessThan(started);
  });

  it('reuses the cached verdict for an unchanged ticket', async () => {
    const worktree = await setup.worktree('plan-readiness-cache-');
    const cacheDir = join(worktree, 'cache');
    await plan({ body: PROSE, judge: [out(verdict('ready'))], cacheDir });
    const second = await plan({ body: PROSE, cacheDir });
    expect(second.result.ok).toBe(true);
    expect(second.tasks).toEqual(['plan']);
    expect(second.logs.find((l) => l.type === 'readiness')?.extra.readiness.judge.cached).toBe(true);
  });

  it('an epic skips the judge and proceeds to PLAN', async () => {
    const { result, tasks } = await plan({ body: PROSE, title: '[Epic] Status overhaul' });
    expect(result.ok).toBe(true);
    expect(tasks).toEqual(['plan']);
  });

  it('judges a local brief like any other work source', async () => {
    const worktree = await setup.worktree('plan-readiness-');
    const { router, stub } = setup.router(
      models,
      routes,
      undefined,
      new StubModelExecutor({ scripts: { readiness_judge: [out(verdict('not-ready', { q: QUESTIONS }))] } }),
    );
    const workSources = new WorkSourceRegistry().register({
      kind: 'local-brief',
      resolve: async () => ({
        id: 'local-brief:1',
        kind: 'local-brief',
        title: 'Local brief',
        brief: 'make it better',
        acceptanceCriteria: [],
      }),
    });
    const result = await planPhase({
      issue: workKeyFromIssue(3470),
      repo: 'o/r',
      worktree,
      specPath: join(worktree, 'issue-3470.md'),
      router,
      constitution: null,
      octokit: fakeOctokit({}).octokit,
      log: () => {},
      workSources,
      workSource: { kind: 'local-brief', params: {} },
      readinessJudge: 'enforce',
    });
    expect(result).toMatchObject({ ok: false, parkReason: 'not-ready', questions: QUESTIONS });
    expect(stub.calls.map((c) => c.task)).toEqual(['readiness_judge']);
  });

  it('writes the readiness notes owner-only', async () => {
    const worktree = await setup.worktree('plan-readiness-');
    await writeReadinessNotes(join(worktree, 'issue-3470.md'), {
      verdict: 'ready',
      summary: 'judged',
      assumptions: [],
      questions: [],
    });
    expect(statSync(join(worktree, 'issue-3470.readiness.json')).mode & 0o777).toBe(0o600);
  });
});
