import { describe, expect, it } from 'vitest';

import { runLane } from './run-lane.js';

describe('runLane file-overlap release (#3576)', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
  const buildClaim = (issue: number) => ({ issue, decision: { kind: 'build' as const } });

  it('file-overlap released outcome settles queued without waitMerge (#3576)', async () => {
    const calls: any[] = [];
    const claims = [buildClaim(5)];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => claims.shift() ?? null,
      ship: async (_issue, _opts, ctx) => {
        ctx?.onOutcome?.({
          state: 'released',
          reason: 'file-overlap',
          holder: 3232,
          file: 'src/a.ts',
          branch: 'b',
          reworkRounds: 0,
        });
        return 'b';
      },
      waitMerge: async (issue) => {
        calls.push(['waitMerge', issue]);
      },
      releaseIssue: async (issue, outcome) => {
        calls.push(['release', issue, outcome]);
      },
      pathExists: () => false,
      emitEvent: () => {},
    });

    expect(calls).toEqual([['release', 5, 'queued']]);
  });
});
