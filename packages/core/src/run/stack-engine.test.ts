// packages/core/src/run/stack-engine.test.ts — the shared stack engine (#3798)
import { describe, expect, it, vi } from 'vitest';

import { runStack, type SliceOutcome, type StackLogLevel, type StackSlice } from './stack-engine.js';

function setup() {
  const logs: Array<[StackLogLevel, string]> = [];
  const log = (level: StackLogLevel, line: string) => {
    logs.push([level, line]);
  };
  return { logs, log };
}

function fake(title: string, result: SliceOutcome | undefined | Error) {
  const run = vi.fn(async (_base: string | undefined) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const slice: StackSlice = { title, run };
  return { slice, run };
}

const opts = { prefix: 'run-x', noun: 'slice' };

describe('runStack (#3798)', () => {
  it("chains each slice on the previous slice's PR head", async () => {
    const mk = () => [
      fake('slice 1', { prNumber: 1, branch: 'b1' }),
      fake('slice 2', { prNumber: 2, branch: 'b2' }),
      fake('slice 3', { prNumber: 3, branch: 'b3' }),
    ];
    const a = mk();
    const { log, logs } = setup();
    const r = await runStack(a.map((f) => f.slice), { ...opts, chain: true, log });
    expect(a.map((f) => f.run.mock.calls[0]![0])).toEqual([undefined, 'b1', 'b2']);
    expect(r.ok).toBe(true);
    expect(logs).toContainEqual(['info', 'run-x: [2/3] stacking on b1']);
    const b = mk();
    await runStack(b.map((f) => f.slice), { ...opts, base: 'feat/x', chain: true, log });
    expect(b.map((f) => f.run.mock.calls[0]![0])).toEqual(['feat/x', 'b1', 'b2']);
  });

  it('stops at the first failure and skips the rest', async () => {
    const s1 = fake('slice 1', { prNumber: 1, branch: 'b1' });
    const s2 = fake('slice 2', new Error('boom'));
    const s3 = fake('slice 3', { prNumber: 3, branch: 'b3' });
    const { log, logs } = setup();
    const r = await runStack([s1.slice, s2.slice, s3.slice], { ...opts, chain: true, log });
    expect(s3.run).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.results[1]).toEqual({ title: 'slice 2', status: 'failed', detail: 'boom' });
    expect(r.results[2]).toEqual({ title: 'slice 3', status: 'skipped', detail: 'stack stopped: slice 2 failed' });
    expect(logs).toContainEqual(['error', 'boom']);
    expect(logs).toContainEqual(['warn', 'run-x: [3/3] slice 3 skipped: stack stopped: slice 2 failed']);
  });

  it('records a non-Error throw as its string form', async () => {
    const run = vi.fn(async () => {
      throw 'plain';
    });
    const { log } = setup();
    const r = await runStack([{ title: 't', run }], { ...opts, chain: false, log });
    expect(r.results[0]!.detail).toBe('plain');
  });

  it.each([{ branch: 'b1' }, undefined])('stops when a slice opens no PR (%j)', async (outcome) => {
    const s1 = fake('one', outcome);
    const s2 = fake('two', { prNumber: 2, branch: 'b2' });
    const { log } = setup();
    const r = await runStack([s1.slice, s2.slice], { ...opts, chain: true, log });
    expect(s2.run).not.toHaveBeenCalled();
    expect(r.results[1]!.detail).toBe('stack stopped: one opened no PR');
  });

  it('never stops or chains when chain is false', async () => {
    const s1 = fake('one', new Error('x'));
    const s2 = fake('two', { prNumber: 2, branch: 'b2' });
    const { log, logs } = setup();
    const r = await runStack([s1.slice, s2.slice], { ...opts, base: 'main2', chain: false, log });
    expect(s1.run).toHaveBeenCalledWith('main2');
    expect(s2.run).toHaveBeenCalledWith('main2');
    expect(logs.some(([, l]) => l.includes('stacking on'))).toBe(false);
    expect(r.results[1]).toEqual({ title: 'two', status: 'ready', prNumber: 2 });
    expect('base' in r.results[1]!).toBe(false);
  });

  it('renders the summary', async () => {
    const plan = [
      fake('a', { prNumber: 11, branch: 'ba' }),
      fake('b', { branch: 'bb' }),
      fake('c', new Error('')),
      fake('d', new Error('bad')),
    ];
    const { log } = setup();
    const r = await runStack(plan.map((f) => f.slice), { base: 'feat/x', chain: true, prefix: 'p', noun: 'brief', log });
    expect(r.summary).toEqual([
      'Briefs:',
      '  a → PR #11 (base feat/x)',
      '  b → done (no PR)',
      '  c → skipped: stack stopped: b opened no PR',
      '  d → skipped: stack stopped: b opened no PR',
      '2/4 briefs succeeded',
    ]);
  });

  it('renders ready, failed and skipped lines unchained', async () => {
    const plan = [fake('a', undefined), fake('b', new Error('')), fake('c', new Error('bad'))];
    const { log } = setup();
    const r = await runStack(plan.map((f) => f.slice), { chain: false, prefix: 'p', noun: 'brief', log });
    expect(r.summary).toEqual(['Briefs:', '  a → done (no PR)', '  b → failed', '  c → failed: bad', '1/3 briefs succeeded']);
  });

  it('handles an empty plan', async () => {
    const { log } = setup();
    const r = await runStack([], { ...opts, chain: true, log });
    expect(r).toEqual({ ok: true, results: [], summary: ['Slices:', '0/0 slices succeeded'] });
  });
});
