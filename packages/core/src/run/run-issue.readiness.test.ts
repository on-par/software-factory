import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { commentStoreOctokit } from '../test-support/comment-store.js';
import { cleanupJudgedRunDirs, makeJudgedRunDir, runIssueWithJudge } from '../test-support/readiness-run.js';

afterAll(() => cleanupJudgedRunDirs());

const QUESTIONS = [
  { aspect: 'scope', text: 'Which screens are affected?' },
  { aspect: 'decision', text: 'Should the old format stay available?' },
];

const notReady = JSON.stringify({
  schemaVersion: 1,
  verdict: 'not-ready',
  summary: 'two open decisions',
  assumptions: [],
  questions: QUESTIONS,
});
const ready = JSON.stringify({ schemaVersion: 1, verdict: 'ready', summary: 'clear', assumptions: [], questions: [] });

describe('runIssue — PLAN readiness gate (#3470)', () => {
  it('parks not-ready with one questions comment, re-parks from the cache in place, and plans once the ticket is edited', async () => {
    const worktree = await makeJudgedRunDir();
    const cacheDir = join(worktree, 'cache');
    let body = 'Make the status view better.';
    const { store, octokit, calls } = commentStoreOctokit({
      'issues.get': async () => ({ data: { title: 'Fix the thing', body } }),
      'issues.update': async () => ({ data: {} }),
    });
    const run = (judge: string[]) => runIssueWithJudge({ worktree, cacheDir, octokit, mode: 'enforce', judge, body });

    const first = await run([notReady]);
    expect(first.outcome).toMatchObject({ state: 'parked', reason: 'not-ready' });
    expect(first.tasks).toEqual(['readiness_judge']);
    expect(store).toHaveLength(1);
    const comment = store[0]?.body ?? '';
    for (const q of QUESTIONS) expect(comment).toContain(`[${q.aspect}] ${q.text}`);
    expect(comment).toContain('answer the questions above by editing the ticket description');

    const again = await run([]);
    expect(again.outcome).toMatchObject({ state: 'parked', reason: 'not-ready' });
    expect(again.tasks).toEqual([]);
    expect(store).toHaveLength(1);
    expect(calls.filter(([k]) => k === 'issues.createComment')).toHaveLength(1);
    expect(calls.filter(([k]) => k === 'issues.updateComment')).toHaveLength(1);

    body = 'Make the status view drop its extra blank line. Done when status prints no blank line.';
    const edited = await run([ready]);
    expect(edited.outcome.state).not.toBe('parked');
    expect(edited.tasks).toEqual(['readiness_judge', 'plan']);
    expect(calls.filter(([k]) => k === 'issues.update')).toEqual([]);
  });

  it('escalates a judge that fails schema twice, with no comment and no cache entry', async () => {
    const worktree = await makeJudgedRunDir();
    const cacheDir = join(worktree, 'cache');
    const bad = JSON.stringify({
      schemaVersion: 1,
      verdict: 'ready',
      summary: 's',
      assumptions: [],
      questions: QUESTIONS,
    });
    const { store, octokit } = commentStoreOctokit({
      'issues.get': async () => ({ data: { title: 'Fix the thing', body: 'x' } }),
    });
    const { outcome, tasks } = await runIssueWithJudge({
      worktree,
      cacheDir,
      octokit,
      mode: 'enforce',
      judge: [bad, bad],
      body: 'x',
    });
    expect(outcome.state).toBe('escalated');
    expect(outcome.state === 'escalated' ? outcome.reason : '').toContain('readiness judge failed (schema-violation)');
    expect(tasks).toEqual(['readiness_judge', 'readiness_judge']);
    expect(store).toEqual([]);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });
});
