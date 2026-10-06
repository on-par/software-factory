// src/garden/harvest.test.ts — Tests for the read-only garden harvest (#2083)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clusterCheckFailures, readHarvestEvents, renderGardenReport } from './harvest.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'garden-harvest-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const park = (
  type: string,
  issue: string,
  signature: string,
  ts = '2026-01-01T00:00:00.000Z',
  failingChecks: string[] = ['tests'],
) => JSON.stringify({ ts, type, issue, msg: 'm', checkFailure: { signature, failingChecks } });

const write = (name: string, lines: string[]): string => {
  const f = join(dir, name);
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
};

const run = (f: string, opts?: { sampleLimit?: number }) => clusterCheckFailures(readHarvestEvents([f]), opts);

describe('garden harvest', () => {
  it('clusters a recurring signature across park kinds and ignores the rest', () => {
    const f = write('e.ndjson', [
      park('fail', '11', 'sig'),
      park('escalate', '12', 'sig'),
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', type: 'rework', issue: '11', msg: 'r' }),
      park('held', '11', 'sig'),
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', type: 'fail', issue: '11', msg: 'no failure' }),
    ]);
    const clusters = run(f);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ key: 'sig', count: 3, issues: ['11', '12'] });
    expect(clusters[0].samples).toEqual([`${f}:1`, `${f}:2`, `${f}:4`]);
    for (const s of clusters[0].samples) expect(s).toMatch(/^\/.+:\d+$/);
  });

  it('computes first/last seen out of order and the sorted union of checkers', () => {
    const f = write('e.ndjson', [
      park('fail', '1', 's', '2026-03-01T00:00:00.000Z', ['tests', 'lint']),
      park('fail', '2', 's', '2026-01-01T00:00:00.000Z', ['build']),
      park('fail', '10', 's', '2026-02-01T00:00:00.000Z', ['lint']),
    ]);
    const [c] = run(f);
    expect(c.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(c.lastSeen).toBe('2026-03-01T00:00:00.000Z');
    expect(c.failingChecks).toEqual(['build', 'lint', 'tests']);
    expect(c.issues).toEqual(['1', '2', '10']);
    expect(c.samples).toEqual([`${f}:2`, `${f}:3`, `${f}:1`]);
  });

  it('orders by count desc then key, deterministically', () => {
    const f = write('e.ndjson', [
      park('fail', '1', 'zzz'),
      park('fail', '1', 'bbb'),
      park('fail', '2', 'bbb'),
      park('fail', '1', 'aaa'),
      park('fail', '2', 'aaa'),
      park('fail', '3', 'aaa'),
      park('fail', '4', 'mmm'),
      park('fail', '5', 'mmm'),
      park('fail', '6', 'mmm'),
    ]);
    expect(run(f).map((c) => [c.key, c.count])).toEqual([
      ['aaa', 3],
      ['mmm', 3],
      ['bbb', 2],
      ['zzz', 1],
    ]);
    const render = () => renderGardenReport(clusterCheckFailures(readHarvestEvents([f])));
    expect(render()).toEqual(render());
  });

  it('filters empty signatures and non-park kinds, and keeps true line numbers', () => {
    const f = write('e.ndjson', [
      park('fail', '1', ''),
      'not json{',
      park('fail', '1', 'sig'),
      '',
      park('rework', '1', 'sig'),
      park('lane-paused', '1', 'sig'),
      park('environment-released', '1', 'sig'),
    ]);
    const harvested = readHarvestEvents([f]);
    expect(harvested.map((h) => h.pointer)).toEqual([`${f}:1`, `${f}:3`, `${f}:5`, `${f}:6`, `${f}:7`]);
    const clusters = clusterCheckFailures(harvested);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].samples).toEqual([`${f}:3`]);
  });

  it('returns [] for a missing file', () => {
    expect(readHarvestEvents([join(dir, 'nope.ndjson')])).toEqual([]);
  });

  it('reads multiple files in order and names each in pointers', () => {
    const a = write('a.ndjson', [park('fail', '1', 'sig')]);
    const b = write('b.ndjson', [park('fail', '2', 'sig')]);
    expect(readHarvestEvents([a, b]).map((h) => h.pointer)).toEqual([`${a}:1`, `${b}:1`]);
    expect(clusterCheckFailures(readHarvestEvents([a, b]))[0].count).toBe(2);
  });

  it('sampleLimit caps samples but not count', () => {
    const f = write('e.ndjson', [park('fail', '1', 's'), park('fail', '2', 's'), park('fail', '3', 's')]);
    const [c] = run(f, { sampleLimit: 2 });
    expect(c.samples).toHaveLength(2);
    expect(c.count).toBe(3);
  });

  it('ignores non-array failingChecks and sorts non-numeric issues last', () => {
    const f = write('e.ndjson', [
      JSON.stringify({
        ts: 't1',
        type: 'fail',
        issue: 'abc',
        msg: '',
        checkFailure: { signature: 's', failingChecks: 'x' },
      }),
      park('fail', '2', 's'),
    ]);
    const [c] = run(f);
    expect(c.failingChecks).toEqual(['tests']);
    expect(c.issues).toEqual(['2', 'abc']);
  });

  describe('renderGardenReport', () => {
    it('prints "no clusters" for empty input', () => {
      expect(renderGardenReport([])).toEqual(['no clusters']);
    });

    it('renders the fields and pointers', () => {
      const f = write('e.ndjson', [park('fail', '1', 'sig'), park('fail', '2', 'sig'), park('fail', '1', 'sig')]);
      const out = renderGardenReport(run(f)).join('\n');
      expect(out).toContain('# Garden report: recurring CHECK failure signatures');
      expect(out).toContain('## 1. `sig`');
      expect(out).toContain('count: 3');
      expect(out).toContain('distinct issues: 2 (#1, #2)');
      expect(out).toContain('first seen:');
      expect(out).toContain('last seen:');
      expect(out).toContain('failing checkers: tests');
      expect(out).toContain(`  - ${f}:1`);
    });

    it('wraps keys containing backticks in a longer run and flattens newlines', () => {
      const f = write('e.ndjson', [park('fail', '1', 'a``b\nc'), park('fail', '1', '`edge`')]);
      const out = renderGardenReport(run(f)).join('\n');
      expect(out).toContain('```a``b c```');
      expect(out).toContain('`` `edge` ``');
    });

    it('prints (none) when no failing checkers were recorded', () => {
      const f = write('e.ndjson', [park('fail', '1', 's', undefined, [])]);
      expect(renderGardenReport(run(f)).join('\n')).toContain('failing checkers: (none)');
    });
  });
});
