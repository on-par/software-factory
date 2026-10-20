import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBaseHoldGate, readBaseHold } from './base-hold.js';
import './index.js';
import { LaneEnvironmentPauseError } from './lane-environment-pause-error.js';
import { runLane } from './run-lane.js';

describe('runLane confirmed base divergence', () => {
  let directory: string;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('persists a confirmed hold and prevents another claim while the base SHA is unchanged', async () => {
    directory = await mkdtemp(join(tmpdir(), 'run-lane-base-divergence-'));
    const holdFile = join(directory, 'state', 'base-hold.json');
    const events: unknown[][] = [];
    const claimNext = vi.fn(async () => ({ issue: 3287, decision: { kind: 'build' as const } }));
    const ship = vi.fn(async () => {
      throw new LaneEnvironmentPauseError('local base checker still fails', {
        baseSha: 'a'.repeat(40),
        failingChecks: ['tests'],
        confirmedLocally: true,
      });
    });
    await runLane(
      'app',
      [],
      '/repo',
      'owner/repo',
      {
        events: join(directory, 'events.ndjson'),
        stop: join(directory, 'STOP'),
        baseHold: holdFile,
      } as never,
      {
        claimNext,
        ship,
        waitMerge: async () => {},
        releaseIssue: async () => {},
        pathExists: () => false,
        emitEvent: ((...args: unknown[]) => events.push(args)) as never,
      },
    );
    expect(readBaseHold(holdFile)).toMatchObject({ confirmedLocally: true, failingChecks: ['tests'] });

    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'green push CI' }));
    const sameShaGate = createBaseHoldGate({
      file: holdFile,
      repo: 'owner/repo',
      git: async () => `${'a'.repeat(40)}\trefs/heads/main\n`,
      requiredChecksVerdict,
    });
    expect(await sameShaGate()).toMatchObject({ kind: 'hold' });
    expect(requiredChecksVerdict).not.toHaveBeenCalled();

    const movedGate = createBaseHoldGate({
      file: holdFile,
      repo: 'owner/repo',
      git: async () => `${'b'.repeat(40)}\trefs/heads/main\n`,
      requiredChecksVerdict,
    });
    expect(await movedGate()).toEqual({ kind: 'claim' });
    expect(readBaseHold(holdFile)).toBeNull();
    expect(claimNext).toHaveBeenCalledOnce();
    expect(ship).toHaveBeenCalledOnce();
  });
});
