import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { getFactoryPaths, ProviderBreaker, workKeyFromIssue } from '@on-par/factory-core';
import { allProvidersDown, allProvidersDownReleasePayload } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';

import { runLane } from './run-lane.js';

const HOUR = 60 * 60_000;
const PROVIDERS: Record<string, string> = { 'claude-boss': 'anthropic', 'codex-boss': 'openai', 'og-boss': 'custom' };
const CANDIDATES = Object.keys(PROVIDERS);
const registry = { registryRef: { get: (id: string) => ({ provider: PROVIDERS[id] }) } } as never;
// CT = UTC-5 on 2026-10-20: 05:00 CT is 10:00Z, 06:30 CT is 11:30Z, 07:00 CT is 12:00Z.
const FIVE_CT = Date.parse('2026-10-20T10:00:00.000Z');
const SEVEN_CT = '2026-10-20T12:00:00.000Z';

const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('run-lane-all-providers-down-');
afterAll(() => tempDirs.cleanup());
let n = 0;

// One mutable clock shared by the breaker and the lane, so the breaker sees the lane's sleeps.
const clock = { ms: 0 };

async function capAll(start: number, hours: [number, number, number]): Promise<ProviderBreaker> {
  n += 1;
  clock.ms = start;
  const breaker = new ProviderBreaker(join(dir, `breaker-${n}.json`), () => clock.ms);
  await breaker.open('anthropic', 'usage_cap', hours[0] * HOUR);
  await breaker.open('openai', 'usage_cap', hours[1] * HOUR);
  await breaker.open('custom', 'usage_cap', hours[2] * HOUR);
  return breaker;
}

function lane(paths: ReturnType<typeof getFactoryPaths>, breaker: ProviderBreaker, start: number, issues: number[]) {
  clock.ms = start;
  const ranOn: number[] = [];
  const calls: Array<[string, number, string]> = [];
  const events: Array<{ type: string; extra?: any }> = [];
  const claimedAt: number[] = [];
  const claims = issues.map((issue) => ({ issue, decision: { kind: 'build' as const } }));
  const run = () =>
    runLane('app', [], '/repo', 'on-par/software-factory', paths, {
      claimNext: async () => {
        claimedAt.push(clock.ms);
        return claims.shift() ?? null;
      },
      ship: async (issue, _opts, ctx) => {
        const gate = await allProvidersDown('plan', {
          router: registry,
          breaker,
          candidates: CANDIDATES,
          failoverEnabled: true,
          now: () => clock.ms,
        });
        if (gate.down && gate.earliestResetAt) {
          ctx?.onOutcome?.({
            state: 'released',
            reason: 'provider-cap',
            branch: 'b',
            reworkRounds: 0,
            providers: gate.providers.map((p) => p.provider),
            resetAt: gate.earliestResetAt,
            allProvidersDown: allProvidersDownReleasePayload(
              'plan',
              gate.providers,
              gate.earliestResetAt,
              workKeyFromIssue(issue),
              () => clock.ms,
            ),
          });
          return 'b';
        }
        ranOn.push(issue);
        return 'b';
      },
      waitMerge: async () => {},
      releaseIssue: async (issue, outcome) => {
        calls.push(['release', issue, outcome]);
      },
      pathExists: () => false,
      now: () => new Date(clock.ms),
      sleep: async (ms) => {
        clock.ms += ms;
      },
      emitEvent: (_file, type, _subject, _message, extra) => {
        events.push({ type, extra });
      },
    });
  return { run, ranOn, calls, events, claimedAt };
}

describe('runLane all_providers_down release (#3340)', () => {
  it('every provider capped emits all_providers_down once and releases to queued (2026-10-20)', async () => {
    const paths = getFactoryPaths('/repo', join(dir, 'state-1'));
    const l = lane(paths, await capAll(FIVE_CT, [2, 4, 6]), FIVE_CT, [1, 2]);
    await l.run();
    const down = l.events.filter((e) => e.type === 'all_providers_down');
    expect(down).toHaveLength(1);
    expect(down[0]?.extra.allProvidersDown).toMatchObject({
      detail: 'all_capped',
      nextAvailableAt: SEVEN_CT,
      stage: 'plan',
    });
    expect(down[0]?.extra.allProvidersDown.providers).toHaveLength(3);
    expect(l.calls).toContainEqual(['release', 1, 'queued']);
    expect(l.calls.some(([, , outcome]) => outcome === 'parked')).toBe(false);
    expect(l.claimedAt.slice(1).every((t) => t >= Date.parse(SEVEN_CT))).toBe(true);
    expect(l.events.filter((e) => e.type === 'lane-paused')).toHaveLength(1);
  });

  it('a second lane releasing in the same all-down window writes no second all_providers_down', async () => {
    const paths = getFactoryPaths('/repo', join(dir, 'state-2'));
    const breaker = await capAll(FIVE_CT, [2, 4, 6]);
    const first = lane(paths, breaker, FIVE_CT, [1]);
    await first.run();
    const second = lane(paths, breaker, Date.parse('2026-10-20T11:30:00.000Z'), [2]);
    await second.run();
    const all = [...first.events, ...second.events];
    expect(all.filter((e) => e.type === 'all_providers_down')).toHaveLength(1);
    expect(second.events.filter((e) => e.type === 'lane-paused')).toHaveLength(1);
    expect(second.calls).toContainEqual(['release', 2, 'queued']);
    expect(second.ranOn).toEqual([]);
  });

  it('emits again once the reset has passed and every provider is re-capped to a new reset', async () => {
    const paths = getFactoryPaths('/repo', join(dir, 'state-3'));
    const first = lane(paths, await capAll(FIVE_CT, [2, 4, 6]), FIVE_CT, [1]);
    await first.run();
    const later = Date.parse('2026-10-20T13:00:00.000Z');
    const second = lane(paths, await capAll(later, [1, 2, 3]), later, [2]);
    await second.run();
    const down = second.events.filter((e) => e.type === 'all_providers_down');
    expect(down).toHaveLength(1);
    expect(down[0]?.extra.allProvidersDown.nextAvailableAt).toBe('2026-10-20T14:00:00.000Z');
  });
});
