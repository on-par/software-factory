import { describe, expect, it } from 'vitest';

import { waitForProvidersRestored } from './lane-pause.js';

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
