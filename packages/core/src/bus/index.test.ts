import { LaneLifecycleEventSchema } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { createLifecycleBus, lifecycleBus, withLifecycle } from './index.js';

describe('createLifecycleBus', () => {
  it('delivers an emitted event to every subscriber, and it validates against the shared schema', () => {
    const bus = createLifecycleBus();
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    bus.on((e) => receivedA.push(e));
    bus.on((e) => receivedB.push(e));

    const event = {
      ts: '2026-08-19T00:00:00.000Z',
      laneId: 'lane-1',
      issueId: '591',
      phase: 'plan' as const,
      status: 'started' as const,
      detail: 'plan started',
      worktreePath: '/tmp/worktree',
    };
    bus.emit(event);

    expect(receivedA).toEqual([event]);
    expect(receivedB).toEqual([event]);
    expect(() => LaneLifecycleEventSchema.parse(receivedA[0])).not.toThrow();
  });

  it('stops delivery once the unsubscribe function returned by on() is called', () => {
    const bus = createLifecycleBus();
    const received: unknown[] = [];
    const unsubscribe = bus.on((e) => received.push(e));

    const event = {
      ts: '2026-08-19T00:00:00.000Z',
      laneId: 'lane-1',
      issueId: '591',
      phase: 'build' as const,
      status: 'done' as const,
      detail: 'build done',
      worktreePath: '/tmp/worktree',
    };
    bus.emit(event);
    unsubscribe();
    bus.emit(event);

    expect(received).toEqual([event]);
  });

  it('isolates a throwing listener — a second listener still receives the event and emit does not throw', () => {
    const bus = createLifecycleBus();
    const received: unknown[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => received.push(e));

    const event = {
      ts: '2026-08-19T00:00:00.000Z',
      laneId: 'lane-1',
      issueId: '591',
      phase: 'check' as const,
      status: 'failed' as const,
      detail: 'check failed',
      worktreePath: '/tmp/worktree',
    };
    expect(() => bus.emit(event)).not.toThrow();
    expect(received).toEqual([event]);
  });
});

describe('withLifecycle', () => {
  const baseCtx = { phase: 'plan' as const, issueId: 591, worktreePath: '/tmp/worktree' };

  it('on success: emits started then done, and returns the resolved value unchanged', async () => {
    const bus = createLifecycleBus();
    const received: { phase: string; status: string; laneId: string; issueId: string; worktreePath: string }[] = [];
    bus.on((e) => received.push(e));

    const result = await withLifecycle(
      { ...baseCtx, bus, laneId: 'lane-1' },
      async () => ({ ok: true, value: 42 }),
      (r) => r.ok,
      (r) => `plan complete (${r.value})`,
    );

    expect(result).toEqual({ ok: true, value: 42 });
    expect(received.map((e) => e.status)).toEqual(['started', 'done']);
    expect(received.every((e) => e.phase === 'plan')).toBe(true);
    expect(received.every((e) => e.laneId === 'lane-1')).toBe(true);
    expect(received.every((e) => e.issueId === '591')).toBe(true);
    expect(received.every((e) => e.worktreePath === '/tmp/worktree')).toBe(true);
  });

  it('when succeeded returns false: the second event is failed, and the value is still returned', async () => {
    const bus = createLifecycleBus();
    const received: { status: string }[] = [];
    bus.on((e) => received.push(e));

    const result = await withLifecycle(
      { ...baseCtx, bus },
      async () => ({ ok: false }),
      (r) => r.ok,
    );

    expect(result).toEqual({ ok: false });
    expect(received.map((e) => e.status)).toEqual(['started', 'failed']);
  });

  it('when run() rejects: emits started then failed with the error message, and re-throws the original error', async () => {
    const bus = createLifecycleBus();
    const received: { status: string; detail: string }[] = [];
    bus.on((e) => received.push(e));

    await expect(
      withLifecycle(
        { ...baseCtx, bus },
        async () => {
          throw new Error('router exhausted');
        },
        () => true,
      ),
    ).rejects.toThrow('router exhausted');

    expect(received.map((e) => e.status)).toEqual(['started', 'failed']);
    expect(received[1].detail).toContain('router exhausted');
  });

  it('defaults laneId to issue-<issueId> when omitted, and detail to a generic message when describe is omitted', async () => {
    const bus = createLifecycleBus();
    const received: { laneId: string; detail: string }[] = [];
    bus.on((e) => received.push(e));

    await withLifecycle(
      { ...baseCtx, bus },
      async () => ({ ok: true }),
      (r) => r.ok,
    );

    expect(received.every((e) => e.laneId === 'issue-591')).toBe(true);
    expect(received[1].detail).toBe('plan done');
  });

  it('emits onto the process-wide lifecycleBus when no bus is given', async () => {
    const received: { status: string }[] = [];
    const unsubscribe = lifecycleBus.on((e) => received.push(e));

    try {
      await withLifecycle(
        baseCtx,
        async () => ({ ok: true }),
        (r) => r.ok,
      );
    } finally {
      unsubscribe();
    }

    expect(received.map((e) => e.status)).toEqual(['started', 'done']);
  });
});
