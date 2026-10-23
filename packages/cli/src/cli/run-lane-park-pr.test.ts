// packages/cli/src/cli/run-lane-park-pr.test.ts — a park raised while landing settles the run's PR (#3551)

import { describe, expect, it, vi } from 'vitest';

import { LaneParkError } from './index.js';
import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

describe('runLane closeParkedPr', () => {
  it('a land-time conflict park calls closeParkedPr with the branch and reason', async () => {
    const closeParkedPr = vi.fn(async () => {});
    await runLane('app', [7], '/repo', 'on-par/software-factory', paths, {
      ship: async (issue) => `ship-it/${issue}-x`,
      waitMerge: async () => {
        throw Object.assign(new Error('merge conflict'), { parkReason: 'conflict' });
      },
      closeParkedPr,
      pathExists: () => false,
      emitEvent: () => {},
    });
    expect(closeParkedPr).toHaveBeenCalledTimes(1);
    expect(closeParkedPr).toHaveBeenCalledWith(7, 'ship-it/7-x', 'conflict');
  });

  it('a park raised by ship does not call closeParkedPr', async () => {
    const closeParkedPr = vi.fn(async () => {});
    await runLane('app', [7], '/repo', 'on-par/software-factory', paths, {
      ship: async () => {
        throw new LaneParkError('ci failed', 'ci-failed');
      },
      waitMerge: async () => {},
      closeParkedPr,
      pathExists: () => false,
      emitEvent: () => {},
    });
    expect(closeParkedPr).not.toHaveBeenCalled();
  });
});
