import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { getFactoryPaths, ProviderBreaker } from '@on-par/factory-core';
import { allProvidersDown, stageBlocked } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';

import { runLane } from './run-lane.js';

const HOUR = 60 * 60_000;
const PROVIDERS: Record<string, string> = { 'claude-plan': 'anthropic', 'gpt-plan': 'openai' };
const registry = { registryRef: { get: (id: string) => ({ provider: PROVIDERS[id] }) } } as never;

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-lane-provider-cap-');
afterAll(() => tempDirs.cleanup());

describe('runLane provider-cap release (#3226)', () => {
  const paths = getFactoryPaths('/repo', '/repo/.factory');
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

  describe('all providers down with no known reset (#3235)', () => {
    let n = 0;
    const setup = async () => {
      n += 1;
      const breaker = new ProviderBreaker(join(dir, `down-${n}.json`), () => 1, { fingerprint: () => 'fp' });
      await breaker.openUntilCredentialsChange('anthropic', 'error');
      await breaker.openUntilCredentialsChange('openai', 'error');
      const claims = [buildClaim(1), buildClaim(2)];
      const calls: any[] = [];
      const events: Array<{ type: string; extra?: any }> = [];
      let claimCalls = 0;
      let polls = 0;
      const deps = (onPoll: (poll: number) => Promise<void> | void) => ({
        claimNext: async () => {
          claimCalls++;
          return claims.shift() ?? null;
        },
        providerBreaker: breaker,
        configStamp: () => 'cfg',
        ship: async (issue: number, _opts: unknown, ctx?: { onOutcome?: (o: any) => void }) => {
          const gate = await allProvidersDown('plan', {
            router: registry,
            breaker,
            candidates: ['claude-plan', 'gpt-plan'],
            failoverEnabled: true,
          });
          if (gate.down && !gate.earliestResetAt) {
            const outcome = {
              state: 'parked' as const,
              reason: 'all_providers_down' as const,
              providersDown: {
                stage: 'plan' as const,
                detail: 'untimed_breakers' as const,
                providers: gate.providers.map((p) => p.provider),
              },
            };
            ctx?.onOutcome?.(outcome);
            events.push({ type: 'all_providers_down' });
            throw Object.assign(new Error('every PLAN provider is down'), { outcome });
          }
          calls.push(['ran', issue]);
          return 'b';
        },
        waitMerge: async () => {},
        releaseIssue: async (issue: number, outcome: string) => {
          calls.push(['release', issue, outcome]);
        },
        pathExists: () => polls >= 3,
        sleep: async () => {
          polls++;
          await onPoll(polls);
        },
        emitEvent: ((_file: string, type: string, _subject: unknown, _msg: string, extra?: any) => {
          events.push({ type, extra });
        }) as never,
      });
      return { breaker, calls, events, deps, claimCalls: () => claimCalls };
    };

    it('all providers down with no known reset parks once and pauses the lane', async () => {
      const t = await setup();
      await runLane(
        'app',
        [],
        '/repo',
        'on-par/software-factory',
        paths,
        t.deps(() => {}),
      );
      expect(t.calls).toEqual([['release', 1, 'parked']]);
      expect(t.claimCalls()).toBe(1);
      expect(t.events.filter((e) => e.type === 'all_providers_down')).toHaveLength(1);
      const paused = t.events.filter((e) => e.type === 'lane-paused');
      expect(paused).toHaveLength(1);
      expect(paused[0].extra.lanePaused).toMatchObject({
        cause: 'all_providers_down',
        providers: ['anthropic', 'openai'],
      });
      expect(t.events.some((e) => e.type === 'stopped')).toBe(true);
    });

    it('defaults to the repo breaker file and config stamp, and resumes when the config file changes', async () => {
      const t = await setup();
      const real = getFactoryPaths(dir, join(dir, 'default-state'));
      mkdirSync(dirname(real.config), { recursive: true });
      const down = { ...t.deps(() => {}), providerBreaker: undefined, configStamp: undefined };
      // The default breaker file is absent, so the watched providers read closed: the lane resumes at once.
      await runLane('app', [], dir, 'on-par/software-factory', real, down as never);
      expect(t.claimCalls()).toBeGreaterThanOrEqual(2);
      writeFileSync(real.config, 'x');
      const again = await setup();
      await runLane('app', [], dir, 'on-par/software-factory', real, {
        ...again.deps(() => {}),
        providerBreaker: undefined,
        configStamp: undefined,
      } as never);
      expect(again.claimCalls()).toBeGreaterThanOrEqual(2);
    });

    it('a breaker reset ends the all_providers_down pause and the lane claims on its next poll', async () => {
      const t = await setup();
      await runLane(
        'app',
        [],
        '/repo',
        'on-par/software-factory',
        paths,
        t.deps(async (poll) => {
          if (poll === 2) await t.breaker.reset('openai');
        }),
      );
      expect(t.claimCalls()).toBeGreaterThanOrEqual(2);
      expect(t.calls).toContainEqual(['ran', 2]);
    });
  });
});
