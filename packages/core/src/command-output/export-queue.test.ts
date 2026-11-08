import { describe, expect, it } from 'vitest';

import { createExportQueue, type SendOutcome } from './export-queue.js';

function harness(outcomes: SendOutcome[] | ((batch: number[]) => Promise<SendOutcome>), extra = {}) {
  const batches: number[][] = [];
  const delays: number[] = [];
  let i = 0;
  const q = createExportQueue<number>({
    send: async (batch) => {
      batches.push(batch);
      if (typeof outcomes === 'function') return outcomes(batch);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    lingerMs: 1,
    ...extra,
  });
  return { q, batches, delays };
}

describe('createExportQueue', () => {
  it('sends batches in order and counts them sent', async () => {
    const { q, batches } = harness(['ok'], { batchSize: 2 });
    for (const n of [1, 2, 3, 4, 5]) expect(q.enqueue(n)).toBe(true);
    const c = await q.close(1000);
    expect(batches.flat()).toEqual([1, 2, 3, 4, 5]);
    expect(batches.every((b) => b.length <= 2)).toBe(true);
    expect(c).toEqual({ sent: 5, dropped: 0, failed: 0, retries: 0 });
  });

  it('sends after the linger when the batch is not full', async () => {
    const { q, batches } = harness(['ok']);
    q.enqueue(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(batches).toEqual([[1]]);
    expect(q.counts().sent).toBe(1);
  });

  it('drops and counts records past maxQueued', async () => {
    const { q } = harness(['ok'], { maxQueued: 2 });
    expect([q.enqueue(1), q.enqueue(2), q.enqueue(3), q.enqueue(4)]).toEqual([true, true, false, false]);
    const c = await q.close(1000);
    expect(c).toMatchObject({ sent: 2, dropped: 2, failed: 0 });
  });

  it('retries a failed batch with exponential backoff before counting it failed', async () => {
    const { q, delays } = harness(['failed']);
    q.enqueue(1);
    q.enqueue(2);
    const c = await q.close(1000);
    expect(delays).toEqual([250, 500]);
    expect(c).toEqual({ sent: 0, dropped: 0, failed: 2, retries: 2 });
  });

  it('caps the backoff delay at maxMs', async () => {
    const { q, delays } = harness(['failed'], { retry: { initialMs: 100, maxMs: 150, maxAttempts: 4 } });
    q.enqueue(1);
    await q.close(1000);
    expect(delays).toEqual([100, 150, 150]);
  });

  it('counts a batch sent after a retry as sent', async () => {
    const { q } = harness(['failed', 'ok']);
    q.enqueue(1);
    expect(await q.close(1000)).toEqual({ sent: 1, dropped: 0, failed: 0, retries: 1 });
  });

  it('counts a rejecting send as failed', async () => {
    const { q } = harness(() => Promise.reject(new Error('boom')), { retry: { maxAttempts: 1 } });
    q.enqueue(1);
    expect(await q.close(1000)).toMatchObject({ sent: 0, failed: 1 });
  });

  it('close counts records still unsent at the budget as failed and never rejects', async () => {
    const { q } = harness(() => new Promise<SendOutcome>(() => {}), { batchSize: 1 });
    q.enqueue(1);
    q.enqueue(2);
    const c = await q.close(20);
    expect(c).toMatchObject({ sent: 0, failed: 2 });
  });

  it('close aborts a retry sleep when the budget expires', async () => {
    const { q } = harness(['failed'], { sleep: () => new Promise<void>(() => {}) });
    q.enqueue(1);
    const c = await q.close(20);
    expect(c).toMatchObject({ sent: 0, failed: 1, retries: 1 });
  });

  it('enqueue after close is dropped', async () => {
    const { q } = harness(['ok']);
    await q.close(10);
    expect(q.enqueue(1)).toBe(false);
    expect(q.counts().dropped).toBe(1);
  });

  it('uses the default sleep and linger when none are injected', async () => {
    const q = createExportQueue<number>({ send: async () => 'ok' });
    q.enqueue(1);
    expect(await q.close(1000)).toMatchObject({ sent: 1 });
  });
});
