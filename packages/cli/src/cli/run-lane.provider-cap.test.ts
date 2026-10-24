import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { getFactoryPaths, ProviderBreaker, type ModelRouter } from '@on-par/factory-core';
import { stageBlocked } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';

import { runLane } from './run-lane.js';

const HOUR = 60 * 60_000;
const PROVIDERS: Record<string, string> = { 'claude-plan': 'anthropic', 'gpt-plan': 'openai' };
const registry = { registryRef: { get: (id: string) => ({ provider: PROVIDERS[id] }) } } as unknown as Pick<
  ModelRouter,
  'registryRef'
>;

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-lane-provider-cap-');
afterAll(() => tempDirs.cleanup());

describe('runLane provider-cap release (#3226)', () => {
  const paths = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' } as unknown as ReturnType<
    typeof getFactoryPaths
  >;
  const buildClaim = (issue: number) => ({ issue, decision: { kind: 'build' as const } });

  it('a capped provider fails over, and an all-blocked stage releases to queued', async () => {
    let clock = Date.parse('2026-10-19T05:00:00.000Z');
    const breaker = new ProviderBreaker(join(dir, 'breaker.json'), () => clock);
    await breaker.open('anthropic', 'usage_cap', 2 * HOUR);

    const ranOn: string[] = [];
    const calls: any[] = [];
    const events: Array<{ type: string; message: string; extra?: any }> = [];
    const claims = [buildClaim(1), buildClaim(2), buildClaim(3)];
    const claimedAt: number[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => {
        claimedAt.push(clock);
        return claims.shift() ?? null;
      },
      ship: async (issue, _opts, ctx) => {
        const gate = await stageBlocked('plan', {
          router: registry,
          breaker,
          candidates: ['claude-plan', 'gpt-plan'],
          failoverEnabled: true,
          now: () => clock,
        });
        if (gate.blocked && gate.nextAvailableAt) {
          ctx?.onOutcome?.({
            state: 'released',
            reason: 'provider-cap',
            branch: 'b',
            reworkRounds: 0,
            providers: gate.providers,
            resetAt: gate.nextAvailableAt,
          });
          return 'b';
        }
        ranOn.push(['claude-plan', 'gpt-plan'].find((m) => !gate.skip.has(PROVIDERS[m]))!);
        if (issue === 1) await breaker.open('openai', 'rate_limit', 3 * HOUR);
        return 'b';
      },
      waitMerge: async (issue) => {
        calls.push(['waitMerge', issue]);
      },
      releaseIssue: async (issue, outcome) => {
        calls.push(['release', issue, outcome]);
      },
      pathExists: () => false,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      emitEvent: (_file, type, _subject, message, extra) => {
        events.push({ type, message, extra });
      },
    });

    // Issue 1 failed over to openai; issue 2 hit a fully capped stage and went back to queued, never parked;
    // issue 3, claimed after anthropic's reset, ran on anthropic again while openai was still open.
    expect(ranOn).toEqual(['gpt-plan', 'claude-plan']);
    expect(calls).toContainEqual(['release', 2, 'queued']);
    expect(calls.some(([, , outcome]) => outcome === 'parked')).toBe(false);
    expect(events.some((e) => e.type === 'fail' || e.type === 'escalate')).toBe(false);
    const paused = events.find((e) => e.type === 'lane-paused');
    expect(paused?.extra.lanePaused).toMatchObject({
      cause: 'provider-cap',
      providers: ['anthropic', 'openai'],
      resetAt: new Date(Date.parse('2026-10-19T05:00:00.000Z') + 2 * HOUR).toISOString(),
    });
    // The lane waited for the earliest reset (anthropic, +2h) before claiming issue 3.
    expect(claimedAt.length).toBe(4);
    expect(claimedAt[2]).toBeGreaterThanOrEqual(Date.parse(paused?.extra.lanePaused.resetAt));
  });

  it('honours the STOP file while waiting for the reset, and never claims past it', async () => {
    let clock = Date.parse('2026-10-19T05:00:00.000Z');
    let stop = false;
    const claims = [buildClaim(1), buildClaim(2)];
    const claimed: number[] = [];
    const events: string[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => {
        const next = claims.shift() ?? null;
        if (next) claimed.push(next.issue);
        return next;
      },
      ship: async (_issue, _opts, ctx) => {
        ctx?.onOutcome?.({
          state: 'released',
          reason: 'provider-cap',
          branch: 'b',
          reworkRounds: 0,
          providers: ['anthropic'],
          resetAt: new Date(clock + 3 * HOUR).toISOString(),
        });
        return 'b';
      },
      releaseIssue: async () => {},
      pathExists: () => stop,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
        stop = true;
      },
      emitEvent: (_file, type) => {
        events.push(type);
      },
    });
    expect(claimed).toEqual([1]);
    expect(events).toContain('stopped');
  });

  it('does not wait when resetAt is unparsable', async () => {
    const claims = [buildClaim(1), buildClaim(2)];
    const claimed: number[] = [];
    await runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => {
        const next = claims.shift() ?? null;
        if (next) claimed.push(next.issue);
        return next;
      },
      ship: async (_issue, _opts, ctx) => {
        ctx?.onOutcome?.({
          state: 'released',
          reason: 'provider-cap',
          branch: 'b',
          reworkRounds: 0,
          providers: ['anthropic'],
          resetAt: 'not-a-date',
        });
        return 'b';
      },
      releaseIssue: async () => {},
      pathExists: () => false,
      sleep: async () => {
        throw new Error('must not sleep');
      },
      emitEvent: () => {},
    });
    expect(claimed).toEqual([1, 2]);
  });
});
