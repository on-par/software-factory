import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseChecksVerdict } from './base-health-ci.js';
import { createMergeBaseGate } from './merge-base-gate.js';

const dirs = createTempDirs();
const recorder = (logged: string[][] = []) => ({ logged, log: (...a: string[]) => void logged.push(a) });
afterEach(() => dirs.cleanup());

describe('merge base gate', () => {
  it('uses the default timer before retrying pending CI', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const verdict = async () =>
        (++polls === 1 ? { green: false, state: 'pending', reason: 'running' } : { green: true }) as never;
      const gate = createMergeBaseGate({
        file: join(dirs.makeSync('merge-timer-'), 'state'),
        repo: 'o/r',
        log: () => {},
        head: async () => 'base',
        verdict,
      });
      const checking = gate.check();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(checking).resolves.toBeUndefined();
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('waits for pending CI, blocks failure, and clears a recorded pause only on green', async () => {
    const dir = dirs.makeSync('merge-gate-');
    const { logged, log } = recorder();
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
    expect(logged.filter(([k]) => k === 'red-main')).toHaveLength(1);
    state = 'pending';
    await expect(gate.check()).rejects.toThrow();
    state = 'green';
    await gate.check();
    expect(logged.filter(([k]) => k === 'red-main-cleared')).toHaveLength(1);
  });
  it('leaves pending CI open at the deadline and allows repositories with no code-health checks', async () => {
    let now = 0;
    const gate = createMergeBaseGate({
      file: join(dirs.makeSync('merge-unused-'), 'state.json'),
      repo: 'empty',
      log: () => {},
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
      log: recorder().log,
      head: async () => 'base',
      verdict: async () => ({ green: false, noCodeHealthChecks: true, reason: 'none' }),
    });
    await expect(noChecks.check()).resolves.toBeUndefined();
  });
  it('pauses on a failed descendant and retains the pause across gate instances', async () => {
    const dir = dirs.makeSync('merge-descendant-');
    const { logged, log } = recorder();
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
    expect(logged.map(([k]) => k)).toEqual(['red-main']);
  });
  it('fails closed when the base or ancestry lookup fails', async () => {
    const dir = dirs.makeSync('merge-lookup-');
    const { logged, log } = recorder();
    const base = { file: join(dir, 'state'), repo: 'o/r', log };
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
    expect(logged).toEqual([]);
  });
  describe('missing required context (#3870)', () => {
    const missing = { green: false, state: 'pending' as const, reason: 'missing test', missing: ['test'] };
    const gateFor = (verdict: () => Promise<typeof missing>) => {
      const { logged, log } = recorder();
      let now = 0;
      const gate = createMergeBaseGate({
        file: join(dirs.makeSync('merge-missing-'), 'state.json'),
        repo: 'o/r',
        log,
        head: async () => 'abcdef123456',
        verdict,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      return { gate, logged, elapsed: () => now };
    };
    it('still waits the full deadline when a missing context is mixed with a pending run', async () => {
      const { gate, elapsed } = gateFor(async () => ({ green: false, state: 'pending', reason: 'missing a' }) as never);
      await expect(gate.check()).rejects.toThrow('pending');
      expect(elapsed()).toBe(30 * 60_000);
    });
    it("returns to the failed path when the missing context's run appears and fails during the grace", async () => {
      let polls = 0;
      const verdict = async () =>
        (++polls === 1 ? missing : { green: false, state: 'failed', reason: 'test failure' }) as never;
      const { gate, logged } = gateFor(verdict);
      await expect(gate.check()).rejects.toThrow('failed');
      expect(logged).toEqual([]);
    });
    it('still throws the pause when the entry is paused and the verdict is missing-only', async () => {
      const dir = dirs.makeSync('merge-missing-pause-');
      const opts = {
        file: join(dir, 'state.json'),
        repo: 'o/r',
        log: () => {},
        head: async () => 'child',
        descends: async () => true,
      };
      const failed = { green: false, state: 'failed' as const, reason: 'failure' };
      createMergeBaseGate({ ...opts, verdict: async () => failed }).record('merge');
      await expect(createMergeBaseGate({ ...opts, verdict: async () => failed }).check()).rejects.toThrow('failed');
      await expect(createMergeBaseGate({ ...opts, verdict: async () => missing }).check(false)).rejects.toThrow(
        'pause',
      );
    });
  });
  describe('skipped or neutral required check on the base (#3871)', () => {
    let conclusion = 'skipped';
    const octokit = {
      rest: {
        repos: {
          getStatusChecksProtection: async () => ({ data: { contexts: ['test'] } }),
          getBranchRules: async () => ({ data: [] }),
        },
        checks: {
          listForRef: async () => ({
            data: { check_runs: [{ name: 'test', status: 'completed', conclusion, check_suite: { id: 1 } }] },
          }),
        },
        actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }) },
      },
    } as never;
    const setup = () => {
      const file = join(dirs.makeSync('merge-skipped-'), 'merge-base-health.json');
      const { logged, log } = recorder();
      let now = 0;
      const gate = createMergeBaseGate({
        file,
        repo: 'o/r',
        log,
        head: async () => 'bbbb2222',
        descends: async () => true,
        verdict: baseChecksVerdict(octokit, 'o', 'r', { branch: 'main' }),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      const entry = () => (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { paused?: boolean }>)['o/r'];
      return { file, logged, gate, entry };
    };
    it.each(['skipped', 'neutral'])(
      'does not pause after a recorded merge when the required check is %s (#3871)',
      async (c) => {
        conclusion = c;
        const { gate, logged, entry } = setup();
        gate.record('aaaa1111');
        await expect(gate.check(false)).resolves.toBeUndefined();
        await expect(gate.check(false)).resolves.toBeUndefined();
        expect(logged.filter(([k]) => k === 'red-main')).toEqual([]);
        expect(entry()?.paused).not.toBe(true);
      },
    );
    it('clears an existing skipped-reason pause on the next check (#3871)', async () => {
      conclusion = 'skipped';
      const { file, logged, gate, entry } = setup();
      writeFileSync(file, JSON.stringify({ 'o/r': { repo: 'o/r', merge: 'aaaa1111', paused: true } }));
      await expect(gate.check(false)).resolves.toBeUndefined();
      expect(logged).toEqual([['red-main-cleared', expect.any(String)]]);
      expect(entry()?.paused).toBe(false);
    });
    it('still pauses on a failed required check (control)', async () => {
      conclusion = 'failure';
      const { gate, entry } = setup();
      gate.record('aaaa1111');
      await expect(gate.check(false)).rejects.toThrow('failed');
      expect(entry()?.paused).toBe(true);
    });
  });
});
