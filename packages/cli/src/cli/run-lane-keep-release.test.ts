// packages/cli/src/cli/run-lane-keep-release.test.ts — a lane re-queue drops the issue's keep record (#3318)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { upsertWorktreeKeep } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { LaneEnvironmentPauseError } from './index.js';
import { runLane } from './run-lane.js';

const readWorktreeKeeps = (file: string): { issue: number; reason: string }[] =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

describe('runLane keep release', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  const drive = async (ship: () => Promise<unknown>) => {
    const dir = tmp.makeSync('lane-keeps-');
    const keepsFile = join(dir, 'worktree-keeps.json');
    for (const issue of [42, 43]) {
      upsertWorktreeKeep(keepsFile, { issue, path: `/wt${issue}`, reason: 'manual', since: 'now' });
    }
    const paths: any = {
      events: join(dir, 'events.ndjson'),
      stop: join(dir, 'STOP'),
      baseHold: join(dir, 'base-hold.json'),
      worktreeKeeps: keepsFile,
    };
    await runLane('app', [42], '/repo', 'o/r', paths, {
      ship,
      waitMerge: async () => {},
      releaseIssue: async () => {},
      pathExists: () => false,
      emitEvent: () => {},
    } as any);
    return readWorktreeKeeps(keepsFile).map((k) => k.issue);
  };

  it("the lane's re-queue (settle queued) removes the issue's keep record", async () => {
    const left = await drive(async () => {
      throw new LaneEnvironmentPauseError('base broken', { baseSha: 'abc1234567890def', failingChecks: ['tests'] });
    });
    expect(left).toEqual([43]);
  });

  it("a 'done' settle leaves the keep record alone", async () => {
    const left = await drive(async () => ({ note: 'shipped' }));
    expect(left).toEqual([42, 43]);
  });
});
