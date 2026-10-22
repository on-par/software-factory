import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listIssueRuns } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRunsJson } from './runs.js';
import { resolveSteerRun } from './steer.js';
import { readRunStates } from './steerability-report.js';

const tmp = createTempDirs();
let dir: string;

beforeEach(() => {
  dir = tmp.makeSync('factory-run-readers-');
});
afterEach(() => {
  return tmp.cleanup();
});

const writeRun = (n: number, extra: Record<string, unknown> = {}): void => {
  writeFileSync(
    join(dir, `issue-${n}.json`),
    JSON.stringify({
      issue: n,
      lane: 'daw',
      status: 'running',
      branch: `factory/${n}`,
      worktree: '/w',
      specPath: '/s',
      attempts: 1,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      ...extra,
    }),
  );
};

describe('run readers', () => {
  it('runs, steer and steerability see the same valid runs as listIssueRuns', async () => {
    writeRun(1);
    writeRun(2, { prNumber: 42 });
    writeRun(3, { startedAt: undefined, prNumber: 43 });
    writeRun(4, { updatedAt: undefined, prNumber: 44 });
    writeFileSync(join(dir, 'issue-5.json'), '{oops');
    writeFileSync(
      join(dir, 'issue-1.phase.json'),
      JSON.stringify({
        issue: 1,
        phase: 'build',
        updatedAt: '2026-01-02T00:00:00Z',
        lastActivityAt: '2026-01-02T00:00:00Z',
      }),
    );

    const listed = (await listIssueRuns(dir)).runs.map((r) => r.issue);
    expect(listed).toEqual([1, 2]);

    const { json } = await buildRunsJson(dir);
    expect(json.runs.map((r) => r.issue).sort()).toEqual(listed);
    expect((await readRunStates(dir)).map((r) => r.issue)).toEqual(listed);

    const byPr = await resolveSteerRun(dir, { kind: 'pr', number: 42, raw: '#42' });
    expect(byPr.state.issue).toBe(2);
    await expect(resolveSteerRun(dir, { kind: 'pr', number: 43, raw: '#43' })).rejects.toMatchObject({
      code: 'no-run',
    });
  });
});
