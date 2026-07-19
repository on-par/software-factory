import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OvernightItemOutcome, OvernightPreflightResult, OvernightQueueState } from './overnight.js';
import { runOvernightQueue } from './overnight.js';

const NOW = () => new Date('2026-07-18T00:00:00Z');
const OK: OvernightPreflightResult = { ok: true };

let tmpDir: string | undefined;

describe('runOvernightQueue', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function makeStatePath(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-overnight-'));
    return join(tmpDir, 'overnight-state.json');
  }

  function readState(statePath: string): OvernightQueueState {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as OvernightQueueState;
  }

  it('advances the whole queue on success', async () => {
    const statePath = await makeStatePath();
    const report = () => {
      throw new Error('report should not be called for ready items');
    };

    const result = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (): Promise<OvernightItemOutcome> => ({ status: 'ready' }),
        report,
      },
    );

    expect(result.processed.map((item) => item.issue)).toEqual([1, 2]);
    expect(result.processed.every((item) => item.status === 'ready')).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.halted).toBeUndefined();

    const state = readState(statePath);
    expect(state.profile).toBe('local-small-overnight');
    expect(state.items).toHaveLength(2);
    expect(state.items.every((item) => item.finishedAt === NOW().toISOString())).toBe(true);
  });

  it('halts safely on a preflight failure without invoking processItem', async () => {
    const statePath = await makeStatePath();
    let processItemCalled = false;

    const result = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => ({ ok: false, reason: 'ollama unreachable' }),
        processItem: async () => {
          processItemCalled = true;
          return { status: 'ready' };
        },
      },
    );

    expect(processItemCalled).toBe(false);
    expect(result.processed).toEqual([]);
    expect(result.halted).toEqual({ issue: 1, reason: 'ollama unreachable' });
    expect(existsSync(statePath)).toBe(false);
  });

  it('resumes past a mid-queue preflight halt without losing prior artifacts', async () => {
    const statePath = await makeStatePath();

    const runA = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async (issue) => (issue === 2 ? { ok: false, reason: 'no worker model' } : OK),
        processItem: async (): Promise<OvernightItemOutcome> => ({ status: 'ready' }),
      },
    );
    expect(runA.processed.map((item) => item.issue)).toEqual([1]);
    expect(runA.halted).toEqual({ issue: 2, reason: 'no worker model' });
    const stateAfterA = readState(statePath);
    const item1AfterA = stateAfterA.items.find((item) => item.issue === 1);
    expect(item1AfterA).toBeDefined();

    const runB = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (): Promise<OvernightItemOutcome> => ({ status: 'ready' }),
      },
    );

    expect(runB.skipped).toEqual([1]);
    expect(runB.processed.map((item) => item.issue)).toEqual([2]);

    const stateAfterB = readState(statePath);
    expect(stateAfterB.items.find((item) => item.issue === 1)).toEqual(item1AfterA);
    expect(stateAfterB.items.map((item) => item.issue).sort()).toEqual([1, 2]);
  });

  it('parks ambiguous items, reports them, and continues the queue', async () => {
    const statePath = await makeStatePath();
    const reported: Array<{ issue: number; status: string }> = [];

    const result = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (issue): Promise<OvernightItemOutcome> =>
          issue === 1 ? { status: 'parked', reason: 'spec ambiguous' } : { status: 'ready' },
        report: (item) => {
          reported.push({ issue: item.issue, status: item.status });
        },
      },
    );

    expect(reported).toEqual([{ issue: 1, status: 'parked' }]);
    expect(result.processed.map((item) => [item.issue, item.status])).toEqual([
      [1, 'parked'],
      [2, 'ready'],
    ]);
    const state = readState(statePath);
    expect(state.items.map((item) => item.issue)).toEqual([1, 2]);
  });

  it('records a thrown processItem as failed and continues the queue', async () => {
    const statePath = await makeStatePath();
    const reported: Array<{ issue: number; status: string; reason?: string }> = [];

    const result = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (issue): Promise<OvernightItemOutcome> => {
          if (issue === 1) throw new Error('build crashed');
          return { status: 'ready' };
        },
        report: (item) => {
          reported.push({ issue: item.issue, status: item.status, reason: item.reason });
        },
      },
    );

    expect(reported).toEqual([{ issue: 1, status: 'failed', reason: 'build crashed' }]);
    expect(result.processed.map((item) => [item.issue, item.status])).toEqual([
      [1, 'failed'],
      [2, 'ready'],
    ]);
  });

  it('persists state after each item, not at the end of the run', async () => {
    const statePath = await makeStatePath();

    const result = await runOvernightQueue(
      { issues: [1, 2], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (issue): Promise<OvernightItemOutcome> => {
          if (issue === 2) {
            const state = readState(statePath);
            expect(state.items.map((item) => item.issue)).toEqual([1]);
          }
          return { status: 'ready' };
        },
      },
    );

    expect(result.processed.map((item) => item.issue)).toEqual([1, 2]);
  });

  it('processes strictly one item at a time (concurrency 1)', async () => {
    const statePath = await makeStatePath();
    let inFlight = 0;
    let maxInFlight = 0;

    await runOvernightQueue(
      { issues: [1, 2, 3], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (): Promise<OvernightItemOutcome> => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
          inFlight--;
          return { status: 'ready' };
        },
      },
    );

    expect(maxInFlight).toBe(1);
  });

  it('starts fresh without throwing when the state file is corrupt', async () => {
    const statePath = await makeStatePath();
    writeFileSync(statePath, 'not valid json {{{');

    const result = await runOvernightQueue(
      { issues: [1], statePath, now: NOW },
      {
        preflight: async () => OK,
        processItem: async (): Promise<OvernightItemOutcome> => ({ status: 'ready' }),
      },
    );

    expect(result.processed.map((item) => item.issue)).toEqual([1]);
    expect(() => readState(statePath)).not.toThrow();
  });

  it.each([0, -3, 1.5])('rejects invalid issue number %s before calling any dep', async (invalid) => {
    const statePath = await makeStatePath();
    let preflightCalled = false;

    await expect(
      runOvernightQueue(
        { issues: [invalid], statePath, now: NOW },
        {
          preflight: async () => {
            preflightCalled = true;
            return OK;
          },
          processItem: async (): Promise<OvernightItemOutcome> => ({ status: 'ready' }),
        },
      ),
    ).rejects.toThrow(String(invalid));

    expect(preflightCalled).toBe(false);
  });
});
