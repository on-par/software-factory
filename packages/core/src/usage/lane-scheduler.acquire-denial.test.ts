// src/usage/lane-scheduler.acquire-denial.test.ts — Engine lane parks and resumes
// on acquire denial (#1032).

import { describe, expect, it, vi } from 'vitest';

import { createLaneScheduler } from './lane-scheduler.js';
import type { GrantRequest } from './grant-ledger.js';

const request: GrantRequest = {
  repo: 'on-par/x',
  lane: 'lane-1',
  phase: 'build',
  model: 'claude-sonnet-5',
};

describe('createLaneScheduler', () => {
  it('parks on denial and suppresses acquire until retryAfter, then resumes', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const acquire = vi.fn();
    const scheduler = createLaneScheduler({ acquire, now });

    acquire.mockResolvedValueOnce({ granted: false, retryAfter: 1000 });
    await expect(scheduler.evaluate(request)).resolves.toEqual({
      admitted: false,
      parkedUntil: 1000,
    });
    expect(acquire).toHaveBeenCalledTimes(1);

    nowMs = 500;
    await expect(scheduler.evaluate(request)).resolves.toEqual({
      admitted: false,
      parkedUntil: 1000,
    });
    expect(acquire).toHaveBeenCalledTimes(1);

    nowMs = 1000;
    acquire.mockResolvedValueOnce({ granted: true });
    await expect(scheduler.evaluate(request)).resolves.toEqual({ admitted: true });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenLastCalledWith(request);

    acquire.mockResolvedValueOnce({ granted: true });
    await expect(scheduler.evaluate(request)).resolves.toEqual({ admitted: true });
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it('admits immediately when acquire grants on first evaluate', async () => {
    const acquire = vi.fn().mockResolvedValue({ granted: true });
    const scheduler = createLaneScheduler({ acquire });

    await expect(scheduler.evaluate(request)).resolves.toEqual({ admitted: true });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenLastCalledWith(request);
  });

  it('keys park state per lane+phase so a denial on one phase does not suppress another', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const acquire = vi.fn();
    const scheduler = createLaneScheduler({ acquire, now });

    acquire.mockResolvedValueOnce({ granted: false, retryAfter: 1000 });
    await scheduler.evaluate(request);
    expect(acquire).toHaveBeenCalledTimes(1);

    const otherPhaseRequest: GrantRequest = { ...request, phase: 'check' };
    acquire.mockResolvedValueOnce({ granted: true });
    await expect(scheduler.evaluate(otherPhaseRequest)).resolves.toEqual({ admitted: true });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenLastCalledWith(otherPhaseRequest);
  });
});
