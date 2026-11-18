import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { commentStoreOctokit } from '../test-support/comment-store.js';
import { makeRepo } from '../test-support/git-repo.js';
import type { CheckSummary } from '../types/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  buildHandoff,
  handoffMarker,
  handoffNote,
  postHandoffComment,
  renderHandoffComment,
  saveWip,
  splitProof,
} from './handoff.js';

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

const K7 = workKeyFromIssue(7);
const WIP = { baseSha: 'b'.repeat(40), wipBranch: 'wip/issue-7-x', headSha: 'h'.repeat(40) };
const CRITERIA = ['Exits with budget_exhausted. proof: core run test', 'Docs updated'];
const FAILED: CheckSummary = {
  failures: 1,
  passes: 1,
  skips: 0,
  total: 2,
  results: [
    { checker: 'compile', result: 'PASS', details: 'ok' },
    { checker: 'tests', result: 'FAIL', details: `${'x'.repeat(3000)}END` },
  ],
};
const base = { stopReason: 'deadline' as const, specPath: '/wt/.factory/spec.md', worktree: '/wt', wip: WIP };

describe('splitProof', () => {
  it('splits the proof command off a criterion line', () => {
    expect(splitProof('A works. proof: npm test')).toEqual({ criterion: 'A works.', proof: 'npm test' });
    expect(splitProof('A works.')).toEqual({ criterion: 'A works.', proof: null });
    expect(splitProof('A works. proof:')).toEqual({ criterion: 'A works.', proof: null });
  });
});

describe('buildHandoff', () => {
  it('marks every criterion not started when the run stopped in BUILD', () => {
    const h = buildHandoff({ ...base, phase: 'build', planned: true, criteria: CRITERIA });
    expect(h).toMatchObject({
      version: 1,
      phase: 'build',
      specPath: '.factory/spec.md',
      wipBranch: 'wip/issue-7-x',
      lastFailure: null,
      fitsOneRun: false,
      nextStep: 'Finish BUILD from wip/issue-7-x, then run CHECK.',
    });
    expect(h.criteria).toEqual([
      { criterion: 'Exits with budget_exhausted.', proof: 'core run test', status: 'not_started' },
      { criterion: 'Docs updated', proof: null, status: 'not_started' },
    ]);
  });

  it('marks criteria failing with a trimmed last failure when CHECK failed', () => {
    const h = buildHandoff({ ...base, phase: 'check', planned: true, criteria: CRITERIA, summary: FAILED });
    expect(h.criteria.map((c) => c.status)).toEqual(['failing', 'failing']);
    expect(h.lastFailure?.length).toBeLessThanOrEqual(2001);
    expect(h.lastFailure?.endsWith('END')).toBe(true);
    expect(h.fitsOneRun).toBe(true);
    expect(h.nextStep).toBe('Fix tests on wip/issue-7-x, then re-run CHECK.');
  });

  it('marks criteria done when CHECK passed and leaves out the spec when PLAN did not finish', () => {
    const passed = { ...FAILED, failures: 0, results: [FAILED.results[0]] };
    expect(buildHandoff({ ...base, phase: 'check', planned: true, criteria: CRITERIA, summary: passed })).toMatchObject(
      { criteria: [{ status: 'done' }, { status: 'done' }], nextStep: 'CHECK passed; ship wip/issue-7-x.' },
    );
    const unplanned = buildHandoff({
      ...base,
      specPath: '/elsewhere/spec.md',
      phase: 'plan',
      planned: false,
      criteria: [],
    });
    expect(unplanned).toMatchObject({
      specPath: null,
      fitsOneRun: false,
      nextStep: 'Start a new run; PLAN did not finish.',
    });
  });

  it('keeps an absolute spec path outside the worktree', () => {
    const h = buildHandoff({ ...base, specPath: '/elsewhere/spec.md', phase: 'build', planned: true, criteria: [] });
    expect(h.specPath).toBe('/elsewhere/spec.md');
  });
});

describe('renderHandoffComment', () => {
  it('lists criteria, the failure and the JSON behind the marker', () => {
    const h = buildHandoff({
      ...base,
      stopReason: 'sigterm',
      phase: 'check',
      planned: true,
      criteria: CRITERIA,
      summary: FAILED,
    });
    const body = renderHandoffComment(K7, h);
    expect(body).toContain('SIGTERM stopped the run during CHECK; 2 of 2 criteria left');
    expect(body).toContain('- [ ] Exits with budget_exhausted. (failing) proof: core run test');
    expect(body).toContain('"fitsOneRun": true');
    expect(body.endsWith(handoffMarker(K7))).toBe(true);
    expect(handoffNote(h)).toContain(`WIP wip/issue-7-x @ ${'h'.repeat(12)}`);
  });
});

describe('postHandoffComment', () => {
  it('creates one marker comment and updates it on a repeat stop', async () => {
    const { store, octokit } = commentStoreOctokit();
    const first = buildHandoff({ ...base, phase: 'build', planned: true, criteria: CRITERIA });
    const second = buildHandoff({ ...base, phase: 'check', planned: true, criteria: CRITERIA, summary: FAILED });
    expect(await postHandoffComment({ octokit, repo: 'o/r', issue: K7, handoff: first })).toEqual({
      commentId: 1,
      created: true,
    });
    expect(await postHandoffComment({ octokit, repo: 'o/r', issue: K7, handoff: second })).toEqual({
      commentId: 1,
      created: false,
    });
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain('during CHECK');
  });
});

describe('saveWip', () => {
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('commits the work in progress and pushes it to the WIP branch', async () => {
    const repo = makeRepo(tempDirs, 'wip-repo-', { 'a.txt': 'a' });
    const origin = tempDirs.makeSync('wip-origin-');
    git(origin, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const startSha = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'b.txt'), 'b');
    const saved = await saveWip({
      worktree: repo,
      branch: 'issue-7-x',
      issue: K7,
      phase: 'build',
      baseRef: 'origin/main',
      push: true,
    });
    expect(saved.error).toBeUndefined();
    expect(saved).toMatchObject({ baseSha: startSha, wipBranch: 'wip/issue-7-x' });
    expect(saved.headSha).not.toBe(startSha);
    expect(git(origin, ['rev-parse', 'refs/heads/wip/issue-7-x'])).toBe(saved.headSha);
    expect(git(repo, ['log', '-1', '--format=%s'])).toBe('wip(#7): run stopped during build');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('reports the error and no WIP branch when the push fails', async () => {
    const repo = makeRepo(tempDirs, 'wip-nopush-', { 'a.txt': 'a' });
    const saved = await saveWip({ worktree: repo, branch: 'b', issue: K7, phase: 'check', push: true });
    expect(saved.wipBranch).toBeNull();
    expect(saved.baseSha).toBeNull();
    expect(saved.headSha).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(saved.error).toBeDefined();
  });
});
