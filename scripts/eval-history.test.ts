import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileIfExists, runEvalHistory } from './eval-history.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-history-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFileIfExists', () => {
  it('returns the contents of an existing file', () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    expect(readFileIfExists(file)).toBe('hello');
  });

  it('returns undefined for a missing file', () => {
    expect(readFileIfExists(join(dir, 'missing.txt'))).toBeUndefined();
  });

  it('rethrows errors other than ENOENT', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    expect(() => readFileIfExists(sub)).toThrow(/EISDIR/);
  });
});

describe('runEvalHistory', () => {
  const summary = { passRate: 0.9, routeAccuracy: 1, totalCostEstimate: 0.12, results: [{ rubricScore: 4 }] };

  it('skips without writing when the report is missing', () => {
    const history = join(dir, 'history.jsonl');
    const out: string[] = [];
    runEvalHistory(['--report', join(dir, 'nope.json'), '--history', history], (t) => out.push(t));
    expect(out.join('')).toContain('skipping trend append');
    expect(readFileIfExists(history)).toBeUndefined();
  });

  it('creates the history file when it does not exist yet', () => {
    const report = join(dir, 'report.json');
    const history = join(dir, 'history.jsonl');
    writeFileSync(report, JSON.stringify(summary));
    runEvalHistory(['--report', report, '--history', history, '--date', '2026-10-06'], () => undefined);
    const lines = readFileSync(history, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ date: '2026-10-06', passRate: 0.9, meanRubric: 4 });
  });

  it('appends to an existing history file', () => {
    const report = join(dir, 'report.json');
    const history = join(dir, 'history.jsonl');
    writeFileSync(report, JSON.stringify(summary));
    runEvalHistory(['--report', report, '--history', history, '--date', '2026-10-05'], () => undefined);
    runEvalHistory(['--report', report, '--history', history, '--date', '2026-10-06'], () => undefined);
    expect(readFileSync(history, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
