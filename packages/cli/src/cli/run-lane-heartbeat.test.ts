// packages/cli/src/cli/run-lane-heartbeat.test.ts — lane heartbeat ordering vs. release (#3423)

import { describe, expect, it, vi } from 'vitest';

import { LaneParkError } from './index.js';
import { runLane } from './run-lane.js';

describe('runLane heartbeat', () => {
  const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

  it('parks only after the heartbeat timer is cleared and the in-flight heartbeat tick has settled (#3423)', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const timersAtRelease: number[] = [];
      let rejectShip!: () => void;
      const shipGate = new Promise<void>((_resolve, reject) => {
        rejectShip = () => reject(new LaneParkError('plan escalated: needs a human decision', 'escalate'));
      });
      let resolveHb!: () => void;
      const hbGate = new Promise<void>((resolve) => {
        resolveHb = resolve;
      });

      const runPromise = runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          await shipGate;
          return 'b';
        },
        waitMerge: async () => {},
        releaseIssue: async (_issue, outcome) => {
          calls.push(`release:${outcome}`);
          timersAtRelease.push(vi.getTimerCount());
        },
        heartbeat: async () => {
          calls.push('heartbeat-start');
          await hbGate;
          calls.push('heartbeat-write');
        },
        pathExists: () => false,
        emitEvent: () => {},
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(calls).toEqual(['heartbeat-start']);

      rejectShip();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.some((c) => c.startsWith('release:'))).toBe(false);

      resolveHb();
      await runPromise;
      expect(calls).toEqual(['heartbeat-start', 'heartbeat-write', 'release:parked']);
      expect(timersAtRelease).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['parked', 'queued', 'done'] as const)(
    'records no heartbeat write after the first release call on %s (#3423)',
    async (scenario) => {
      vi.useFakeTimers();
      try {
        const calls: string[] = [];
        let finishShip!: () => void;
        const shipGate = new Promise<void>((resolve) => {
          finishShip = resolve;
        });
        let resolveHb!: () => void;
        const hbGate = new Promise<void>((resolve) => {
          resolveHb = resolve;
        });

        const runPromise = runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
          ship: async (_issue, _opts, ctx) => {
            await shipGate;
            if (scenario === 'parked') throw new LaneParkError('needs a human', 'escalate');
            if (scenario === 'queued') {
              ctx?.onOutcome?.({
                state: 'released',
                reason: 'stack-wait',
                branch: 'b',
                reworkRounds: 0,
                prNumber: 55,
                slice: { index: 1, count: 3 },
              });
            }
            return 'b';
          },
          waitMerge: async () => {},
          releaseIssue: async (_issue, outcome) => {
            calls.push(`release:${outcome}`);
          },
          heartbeat: async () => {
            calls.push('heartbeat-start');
            await hbGate;
            calls.push('heartbeat-write');
          },
          pathExists: () => false,
          emitEvent: () => {},
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        finishShip();
        await vi.advanceTimersByTimeAsync(0);
        resolveHb();
        await runPromise;
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

        const firstRelease = calls.findIndex((c) => c.startsWith('release:'));
        expect(calls[firstRelease]).toBe(`release:${scenario}`);
        expect(calls.lastIndexOf('heartbeat-write')).toBeLessThan(firstRelease);
        expect(calls.lastIndexOf('heartbeat-start')).toBeLessThan(firstRelease);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('a rejecting in-flight heartbeat does not change the parked outcome (#3423)', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const events: string[] = [];
      let failShip!: () => void;
      const shipGate = new Promise<void>((_resolve, reject) => {
        failShip = () => reject(new LaneParkError('needs a human', 'escalate'));
      });
      let rejectHb!: () => void;
      const hbGate = new Promise<void>((_resolve, reject) => {
        rejectHb = () => reject(new Error('github 502'));
      });

      const runPromise = runLane('app', [9], '/repo', 'on-par/software-factory', paths, {
        ship: async () => {
          await shipGate;
          return 'b';
        },
        waitMerge: async () => {},
        releaseIssue: async (_issue, outcome) => {
          calls.push(`release:${outcome}`);
        },
        heartbeat: async () => {
          await hbGate;
        },
        pathExists: () => false,
        emitEvent: (_events, type) => {
          events.push(type);
        },
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      failShip();
      await vi.advanceTimersByTimeAsync(0);
      rejectHb();
      await runPromise;

      expect(calls).toEqual(['release:parked']);
      expect(events).toContain('parked');
    } finally {
      vi.useRealTimers();
    }
  });
});
