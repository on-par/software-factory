import { execFile as execFileCb } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { PipelineTestKit } from '../test-support/index.js';
import { recordingLog, type LoggedEvent } from '../test-support/recorders.js';
import { cleanupWorktree, setupWorktree } from './index.js';

const execFile = promisify(execFileCb);

const logRecorder = () => {
  const events: LoggedEvent[] = [];
  return { events, log: recordingLog(events) };
};
const logged = (type: string, msg: unknown) => expect.objectContaining({ type, msg });

describe('cleanupWorktree checkout kinds (#4248)', () => {
  const kit = new PipelineTestKit();
  const dirs = createTempDirs();
  const removeFailed = expect.stringContaining('git worktree remove failed');

  afterEach(async () => {
    await kit.cleanup();
    await dirs.cleanup();
  });

  it('cleanupWorktree does not run git worktree remove on a direct clone', async () => {
    const { repoRoot, origin } = await kit.makeThrowawayRepo();
    const dir = await dirs.make('factory-direct-');
    const clonePath = join(dir, 'clone');
    await execFile('git', ['clone', origin, clonePath]);
    const { events, log } = logRecorder();

    await cleanupWorktree(repoRoot, clonePath, log);

    expect(existsSync(join(clonePath, '.git'))).toBe(true);
    expect(events).not.toContainEqual(logged('warn', removeFailed));
  });

  it('cleanupWorktree logs no warning for a lane path that was never created', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const { events, log } = logRecorder();

    await cleanupWorktree(repoRoot, kit.trackWorktree(repoRoot, 4248), log);

    expect(events).not.toContainEqual(logged('warn', removeFailed));
  });

  it('cleanupWorktree leaves the main checkout alone when handed the repo root', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const { events, log } = logRecorder();

    await cleanupWorktree(repoRoot, repoRoot, log);

    expect(existsSync(join(repoRoot, '.git'))).toBe(true);
    expect(events).not.toContainEqual(logged('warn', removeFailed));
  });

  it('cleanupWorktree still removes a real linked worktree', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const wt = kit.trackWorktree(repoRoot, 4249);
    await setupWorktree(repoRoot, 'factory/4248-real', wt);
    const real = realpathSync(wt);
    const { events, log } = logRecorder();

    await cleanupWorktree(repoRoot, wt, log);

    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });
    expect(existsSync(wt)).toBe(false);
    expect(stdout).not.toContain(real);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'warn' }));
  });

  it('cleanupWorktree logs a warning without rejecting when removing a registered worktree fails', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const wt = kit.trackWorktree(repoRoot, 4250);
    await setupWorktree(repoRoot, 'factory/4248-locked', wt);
    await execFile('git', ['worktree', 'lock', wt], { cwd: repoRoot });
    const { events, log } = logRecorder();

    await expect(cleanupWorktree(repoRoot, wt, log)).resolves.toBeUndefined();

    expect(events).toContainEqual(logged('warn', removeFailed));
    await execFile('git', ['worktree', 'unlock', wt], { cwd: repoRoot });
  });
});
