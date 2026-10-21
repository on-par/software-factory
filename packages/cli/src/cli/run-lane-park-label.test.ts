// packages/cli/src/cli/run-lane-park-label.test.ts — a failed parked-label add is surfaced (#3425)

import { describe, expect, it } from 'vitest';

import { LaneParkError } from './index.js';
import { runLane } from './run-lane.js';

describe('runLane parked label', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

  const drive = async (releaseFails: boolean, preflight = false) => {
    const calls: string[] = [];
    const events: [string, unknown, string][] = [];
    const claims: any[] = preflight ? [{ issue: 42, decision: { kind: 'park', reason: 'x' } }] : [];
    const done = runLane('app', preflight ? [] : [42], '/repo', 'on-par/software-factory', paths, {
      ...(preflight ? { claimNext: async () => claims.shift() ?? null } : {}),
      ship: async () => {
        throw new LaneParkError('needs a human', 'escalate');
      },
      waitMerge: async () => {},
      releaseIssue: async (_issue, outcome) => {
        calls.push(`release:${outcome}`);
        if (releaseFails && outcome === 'parked') throw new Error('label add failed');
      },
      pathExists: () => false,
      emitEvent: (_file: string, type: string, issue: unknown, msg: string) => {
        events.push([type, issue, msg]);
        calls.push(`event:${type}`);
      },
    });
    return { done, calls, events };
  };

  it('emits a fail event naming #42 and factory:parked when the parked release rejects', async () => {
    const { done, events } = await drive(true);
    await expect(done).resolves.toBeUndefined();
    const fails = events.filter(([type, issue]) => type === 'fail' && issue === 42);
    expect(fails).toHaveLength(1);
    expect(fails[0][2]).toContain('#42');
    expect(fails[0][2]).toContain('factory:parked');
  });

  it('emits no parked event for #42 when the parked release rejects', async () => {
    const { done, events } = await drive(true);
    await done;
    expect(events.some(([type, issue]) => type === 'parked' && issue === 42)).toBe(false);
  });

  it('emits the parked event only after the parked release resolves, and no fail event', async () => {
    const { done, calls, events } = await drive(false);
    await done;
    expect(calls.indexOf('event:parked')).toBeGreaterThan(calls.indexOf('release:parked'));
    expect(events.some(([type]) => type === 'fail')).toBe(false);
  });

  it('surfaces a rejected parked release from the preflight park decision', async () => {
    const { done, events } = await drive(true, true);
    await done;
    expect(events.some(([type, issue, msg]) => type === 'fail' && issue === 42 && msg.includes('factory:parked'))).toBe(
      true,
    );
    expect(events.some(([type]) => type === 'parked')).toBe(false);
  });
});
