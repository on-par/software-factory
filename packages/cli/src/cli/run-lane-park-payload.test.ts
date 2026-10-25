// packages/cli/src/cli/run-lane-park-payload.test.ts — runLane park events carry a structured park payload (#3511)

import { workKeyFromIssue } from '@on-par/factory-core';
import { parkUnblockHint } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LaneParkError } from './index.js';
import { runLane } from './run-lane.js';

describe('runLane park payload', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parked event carries a structured park payload (reason, decision, lane, blockedBehind) on an escalate park (#3511)', async () => {
    const events: any[] = [];
    const shipCtx: any[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runLane('app', [7, 8, 9], '/repo', 'on-par/software-factory', paths, {
      ship: async (issue, _opts, ctx) => {
        shipCtx.push([issue, ctx?.blockedBehind]);
        if (issue === 7) throw new LaneParkError('plan escalated: needs a human decision', 'escalate');
        return `ship-it/${issue}-x`;
      },
      waitMerge: async () => {},
      pathExists: () => false,
      emitEvent: (_e: string, type: string, issue: string | number, _m: string, extra?: any) =>
        events.push([type, issue, extra]),
    });
    const parked = events.find((e) => e[0] === 'parked' && e[1] === 7);
    expect(parked[2].lane).toBe('app');
    expect(parked[2].park).toEqual({
      reason: 'escalate',
      decision: parkUnblockHint('escalate', workKeyFromIssue(7)),
      lane: 'app',
      blockedBehind: [8, 9],
    });
    expect(shipCtx[0]).toEqual([7, [8, 9]]);
  });

  it('a preflight park decision carries an escalate park payload with an empty queue behind it (#3511)', async () => {
    const events: any[] = [];
    let claimed = false;
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      ship: async (issue) => `ship-it/${issue}-x`,
      waitMerge: async () => {},
      pathExists: () => false,
      claimNext: async () => {
        if (claimed) return null;
        claimed = true;
        return { issue: 5, decision: { kind: 'park', reason: 'x' } } as any;
      },
      emitEvent: (_e: string, type: string, issue: string | number, _m: string, extra?: any) =>
        events.push([type, issue, extra]),
    });
    const parked = events.find((e) => e[0] === 'parked');
    expect(parked[2].park).toEqual({
      reason: 'escalate',
      decision: parkUnblockHint('escalate', workKeyFromIssue(5)),
      lane: 'app',
      blockedBehind: [],
    });
  });
});
