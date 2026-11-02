import { join } from 'node:path';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMergeBaseGate } from './merge-base-gate.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

describe('merge base gate', () => {
  it('uses the default timer before retrying pending CI', async () => {
    vi.useFakeTimers();
    try {
      const verdict = vi
        .fn()
        .mockResolvedValueOnce({ green: false, state: 'pending', reason: 'running' })
        .mockResolvedValueOnce({ green: true });
      const gate = createMergeBaseGate({
        file: join(dirs.makeSync('merge-timer-'), 'state'),
        repo: 'o/r',
        log: vi.fn(),
        head: async () => 'base',
        verdict,
      });
      const checking = gate.check();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(verdict).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(checking).resolves.toBeUndefined();
      expect(verdict).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('waits for pending CI, blocks failure, and clears a recorded pause only on green', async () => {
    const dir = dirs.makeSync('merge-gate-');
    const log = vi.fn();
    let state: 'green' | 'pending' | 'failed' = 'pending';
    let now = 0;
    const gate = createMergeBaseGate({
      file: join(dir, 'state.json'),
      repo: 'o/r',
      log,
      head: async () => 'merge',
      verdict: async () => ({ green: state === 'green', state, reason: state }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        state = 'green';
      },
    });
    await gate.check();
    gate.record('merge');
    state = 'failed';
    await expect(gate.check()).rejects.toThrow();
    await expect(gate.check()).rejects.toThrow();
    expect(log.mock.calls.filter(([kind]) => kind === 'red-main')).toHaveLength(1);
    state = 'pending';
    await expect(gate.check()).rejects.toThrow();
    state = 'green';
    await gate.check();
    expect(log.mock.calls.filter(([kind]) => kind === 'red-main-cleared')).toHaveLength(1);
  });
  it('leaves pending CI open at the deadline and allows repositories with no code-health checks', async () => {
    let now = 0;
    const gate = createMergeBaseGate({
      file: join(dirs.makeSync('merge-unused-'), 'state.json'),
      repo: 'empty',
      log: vi.fn(),
      head: async () => 'base',
      verdict: async () => ({ green: false, state: 'pending', reason: 'running' }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(gate.check()).rejects.toThrow('pending');
    expect(now).toBe(30 * 60_000);
    const noChecks = createMergeBaseGate({
      file: join(dirs.makeSync('merge-unused-'), 'state.json'),
      repo: 'empty',
      log: vi.fn(),
      head: async () => 'base',
      verdict: async () => ({ green: false, noCodeHealthChecks: true, reason: 'none' }),
    });
    await expect(noChecks.check()).resolves.toBeUndefined();
  });
  it('pauses on a failed descendant and retains the pause across gate instances', async () => {
    const dir = dirs.makeSync('merge-descendant-');
    const log = vi.fn();
    const opts = {
      file: join(dir, 'state'),
      repo: 'o/r',
      log,
      head: async () => 'descendant',
      verdict: async () => ({ green: false, state: 'failed' as const, reason: 'failure' }),
      descends: async () => true,
    };
    createMergeBaseGate(opts).record('merge');
    await expect(createMergeBaseGate(opts).check()).rejects.toThrow('failed');
    await expect(createMergeBaseGate(opts).check()).rejects.toThrow('pause');
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the base or ancestry lookup fails', async () => {
    const dir = dirs.makeSync('merge-lookup-');
    const base = { file: join(dir, 'state'), repo: 'o/r', log: vi.fn() };
    const verdict = async () => ({ green: false, state: 'failed' as const, reason: 'failure' });
    const head = async () => {
      throw new Error('offline');
    };
    await expect(createMergeBaseGate({ ...base, head, verdict }).check()).rejects.toThrow('lookup failed');
    const descends = async () => {
      throw new Error('compare');
    };
    const gate = createMergeBaseGate({ ...base, head: async () => 'child', verdict, descends });
    gate.record('merge');
    await expect(gate.check()).rejects.toThrow('ancestry lookup failed');
    expect(base.log).not.toHaveBeenCalled();
  });
});
