import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunOutcome } from '@on-par/factory-core';
import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

import { pauseLaneForProviderCap, waitForProvidersRestored } from './lane-pause.js';

const paths = { stop: '/stop', events: '/events' } as never;

function harness(opts: { open?: boolean; throws?: boolean; stamp?: () => string; stopAfter?: number }) {
  const events: string[] = [];
  let sleeps = 0;
  return {
    events,
    sleeps: () => sleeps,
    ctx: { lane: 'app', paths, emitEvent: ((_f: string, type: string) => events.push(type)) as never },
    deps: {
      breaker: {
        status: async () => {
          if (opts.throws) throw new Error('corrupt');
          return { open: opts.open ?? true } as never;
        },
      },
      configStamp: opts.stamp ?? (() => 'a'),
      sleep: async () => {
        sleeps++;
      },
      pathExists: () => opts.stopAfter !== undefined && sleeps >= opts.stopAfter,
    },
  };
}

describe('waitForProvidersRestored (#3235)', () => {
  it('ends when a watched breaker closes', async () => {
    const h = harness({ open: false });
    expect(await waitForProvidersRestored(h.ctx, { providers: ['anthropic'], configStamp: 'a' }, h.deps)).toBe(false);
    expect(h.sleeps()).toBe(0);
  });

  it('treats an unreadable breaker as closed', async () => {
    const h = harness({ throws: true });
    expect(await waitForProvidersRestored(h.ctx, { providers: ['anthropic'], configStamp: 'a' }, h.deps)).toBe(false);
  });

  it('ends on a config change even with nothing to watch (metered only)', async () => {
    let calls = 0;
    const h = harness({ stamp: () => (++calls > 2 ? 'b' : 'a') });
    expect(await waitForProvidersRestored(h.ctx, { providers: [], configStamp: 'a' }, h.deps)).toBe(false);
    expect(h.sleeps()).toBe(2);
  });

  it('ends on STOP and emits stopped', async () => {
    const h = harness({ stopAfter: 2 });
    expect(await waitForProvidersRestored(h.ctx, { providers: ['anthropic'], configStamp: 'a' }, h.deps)).toBe(true);
    expect(h.events).toEqual(['stopped']);
  });
});

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

type AllProvidersDownPayload = NonNullable<Extract<RunOutcome, { reason: 'provider-cap' }>['allProvidersDown']>;

describe('pauseLaneForProviderCap all_providers_down latch (#3340)', () => {
  const NOW = Date.parse('2026-10-20T10:00:00.000Z');
  const RESET = '2026-10-20T12:00:00.000Z';
  const down: AllProvidersDownPayload = {
    stage: 'plan',
    providers: [{ provider: 'anthropic', reason: 'usage_cap', until: RESET }],
    detail: 'all_capped',
    nextAvailableAt: RESET,
    issue: 1,
    at: new Date(NOW).toISOString(),
  };
  const run = (state: string, nextAvailableAt = RESET) => {
    const events: string[] = [];
    pauseLaneForProviderCap(
      {
        lane: 'app',
        paths: { state, events: join(state, 'events.ndjson') } as never,
        emitEvent: ((_f: string, type: string) => events.push(type)) as never,
        now: () => new Date(NOW),
      },
      1,
      { providers: ['anthropic'], resetAt: RESET, allProvidersDown: { ...down, nextAvailableAt } },
    );
    return events;
  };
  const latch = (state: string) => join(state, 'all-providers-down.json');

  it('emits, then suppresses the same reset while it is still ahead', () => {
    const state = tempDirs.makeSync('lane-pause-');
    expect(run(state)).toEqual(['all_providers_down', 'lane-paused']);
    expect(JSON.parse(readFileSync(latch(state), 'utf8')).nextAvailableAt).toBe(RESET);
    expect(run(state)).toEqual(['lane-paused']);
  });

  it('emits when the stored reset differs or has passed', () => {
    const state = tempDirs.makeSync('lane-pause-');
    writeFileSync(latch(state), JSON.stringify({ nextAvailableAt: '2026-10-20T13:00:00.000Z' }));
    expect(run(state)).toEqual(['all_providers_down', 'lane-paused']);
    const past = '2026-10-20T09:00:00.000Z';
    writeFileSync(latch(state), JSON.stringify({ nextAvailableAt: past }));
    expect(run(state, past)).toEqual(['all_providers_down', 'lane-paused']);
  });

  it('fails open on malformed JSON, and when the latch cannot be written', () => {
    const state = tempDirs.makeSync('lane-pause-');
    writeFileSync(latch(state), '{not json');
    expect(run(state)).toEqual(['all_providers_down', 'lane-paused']);
    const blocked = join(state, 'file');
    writeFileSync(blocked, 'x');
    expect(run(join(blocked, 'sub'))).toEqual(['all_providers_down', 'lane-paused']);
  });

  it('emits nothing extra when the outcome carries no payload', () => {
    const events: string[] = [];
    pauseLaneForProviderCap(
      {
        lane: 'app',
        paths: { state: '/x', events: '/e' } as never,
        emitEvent: ((_f: string, t: string) => events.push(t)) as never,
      },
      1,
      { providers: [], resetAt: RESET },
    );
    expect(events).toEqual(['lane-paused']);
  });
});
