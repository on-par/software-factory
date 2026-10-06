// src/kpis/classifier-outcomes.test.ts — Join shadow verdicts to outcomes (#1726)

import { describe, expect, it } from 'vitest';
import type { ReviewClass } from '../review/floor.js';
import type { FactoryEvent } from '../types/index.js';
import type { ClassifierOutcomeRecord } from './classifier-outcomes.js';
import {
  classifierOutcomeBucket,
  decideVerdict,
  formatClassifierReport,
  joinClassifierOutcomes,
  mergeClassifierOutcomes,
  parseClassifierOutcomes,
  summarizeClassifierOutcomes,
} from './classifier-outcomes.js';
import type { PrSource } from './human.js';

const NOW = '2026-10-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();
const opts = { now: NOW, windowDays: 14 };

function classified(issue: string, modelClass: ReviewClass | null, ts = daysAgo(40)): FactoryEvent {
  return {
    type: 'pr-classified',
    issue,
    msg: 'classified',
    ts,
    prClassification: {
      modelClass,
      floorClass: 'B',
      finalClass: 'B',
      model: 'm',
      promptVersion: 'p1',
      policyVersion: 'f1',
      diffSha: 'sha',
      adrIds: [],
      costUsd: null,
      claims: [],
      unsupportedClaims: [],
      notInspected: [],
      droppedClaims: 0,
    },
  };
}

const ev = (type: FactoryEvent['type'], issue: string, ts: string): FactoryEvent => ({ type, issue, ts, msg: type });

function source(issue: string, prNumber: number, o: Partial<PrSource> = {}): PrSource {
  return { issue, prNumber, commits: [], approvals: [], mergedAt: daysAgo(30), closedAt: null, ...o };
}

const one = (events: FactoryEvent[], sources: PrSource[]) => joinClassifierOutcomes(events, sources, opts)[0];

describe('joinClassifierOutcomes', () => {
  it('records agree for class B edited before merge with no defect', () => {
    const r = one([classified('1', 'B'), ev('human-edited', '1', daysAgo(31))], [source('1', 10)]);
    expect(r).toMatchObject({ verdict: 'agree', humanEdited: true, slipped: false, prNumber: 10, diffSha: 'sha' });
  });

  it('records a slip for class A meeting a defect', () => {
    const r = one([classified('1', 'A'), ev('post-merge-defect', '1', daysAgo(20))], [source('1', 10)]);
    expect(r).toMatchObject({ verdict: 'disagree', slipped: true, defectFired: true });
  });

  it('is pending until the defect window closes', () => {
    const merged = source('1', 10, { mergedAt: daysAgo(3) });
    const r = one([classified('1', 'A'), ev('post-merge-defect', '1', daysAgo(1))], [merged]);
    expect(r).toMatchObject({ verdict: 'pending', defectWindowClosed: false, defectFired: false });
    expect(one([classified('1', 'A')], [source('1', 10, { mergedAt: null })]).verdict).toBe('pending');
  });

  it('applies the abandoned and clean-merge rules', () => {
    const abandoned = source('1', 10, { mergedAt: null, closedAt: daysAgo(5) });
    expect(one([classified('1', 'A')], [abandoned])).toMatchObject({ verdict: 'disagree', humanAbandoned: true });
    expect(one([classified('1', 'B')], [abandoned]).verdict).toBe('agree');
    expect(one([classified('1', 'A')], [source('1', 10)]).verdict).toBe('agree');
    expect(one([classified('1', 'C')], [source('1', 10)])).toMatchObject({ verdict: 'disagree', slipped: false });
    expect(one([classified('1', 'B'), ev('post-merge-defect', '1', daysAgo(20))], [source('1', 10)]).verdict).toBe(
      'agree',
    );
    expect(one([classified('1', 'A'), ev('human-edited', '1', daysAgo(31))], [source('1', 10)]).verdict).toBe(
      'disagree',
    );
  });

  it('ignores a human-edited event after mergedAt and notes approvals', () => {
    const r = one(
      [classified('1', 'A'), ev('human-edited', '1', daysAgo(10)), ev('human-approved', '1', daysAgo(31))],
      [source('1', 10)],
    );
    expect(r).toMatchObject({ humanEdited: false, humanApproved: true, verdict: 'agree' });
    const open = one(
      [classified('1', 'A'), ev('human-edited', '1', daysAgo(10))],
      [source('1', 10, { mergedAt: null })],
    );
    expect(open.humanEdited).toBe(true);
  });

  it('selects records sensibly', () => {
    expect(joinClassifierOutcomes([classified('1', null)], [source('1', 10)], opts)).toEqual([]);
    expect(joinClassifierOutcomes([classified('1', 'A')], [], opts)).toEqual([]);
    expect(joinClassifierOutcomes([classified('x', 'A')], [source('x', 10)], opts)).toEqual([]);
    expect(joinClassifierOutcomes([ev('pr-classified', '1', daysAgo(40))], [source('1', 10)], opts)).toEqual([]);
    const latest = one([classified('1', 'A', daysAgo(40)), classified('1', 'C', daysAgo(39))], [source('1', 10)]);
    expect(latest.modelClass).toBe('C');
    const tie = one([classified('1', 'A', daysAgo(40)), classified('1', 'C', daysAgo(40))], [source('1', 10)]);
    expect(tie.modelClass).toBe('C');
    expect(one([classified('1', 'A')], [source('1', 10), source('1', 12), source('1', 11)]).prNumber).toBe(12);
    const both = joinClassifierOutcomes(
      [classified('2', 'A'), classified('1', 'A')],
      [source('2', 20), source('1', 10)],
      opts,
    );
    expect(both.map((r) => r.issue)).toEqual(['1', '2']);
  });
});

describe('mergeClassifierOutcomes / parseClassifierOutcomes', () => {
  const pending = one([classified('1', 'A')], [source('1', 10, { mergedAt: daysAgo(3) })]);
  const final = one([classified('1', 'A')], [source('1', 10)]);
  const other = one([classified('2', 'B')], [source('2', 20)]);
  const lines = (t: string) => t.split('\n').filter(Boolean);

  it('is idempotent with one line per PR', () => {
    const r = [final, other, other];
    const once = mergeClassifierOutcomes('', r);
    expect(mergeClassifierOutcomes(once, r)).toBe(once);
    expect(lines(once)).toHaveLength(2);
    expect(mergeClassifierOutcomes('', [])).toBe('');
  });

  it('replaces pending in place and freezes final records', () => {
    const first = mergeClassifierOutcomes('', [pending, other]);
    const second = mergeClassifierOutcomes(first, [final]);
    expect(parseClassifierOutcomes(second).map((r) => [r.prNumber, r.verdict])).toEqual([
      [10, 'agree'],
      [20, 'disagree'],
    ]);
    const changed = { ...final, verdict: 'disagree' as const };
    expect(mergeClassifierOutcomes(second, [changed])).toBe(second);
  });

  it('preserves unparseable lines and skips them when parsing', () => {
    const text = mergeClassifierOutcomes('garbage\n\n{"x":1}\n', [final]);
    expect(lines(text).slice(0, 2)).toEqual(['garbage', '{"x":1}']);
    expect(parseClassifierOutcomes(text)).toHaveLength(1);
  });
});

describe('summarizeClassifierOutcomes / formatClassifierReport (#1727)', () => {
  const rec = (o: Partial<ClassifierOutcomeRecord> = {}): ClassifierOutcomeRecord => ({
    issue: '1',
    prNumber: 1,
    classifiedAt: NOW,
    modelClass: 'A',
    floorClass: 'A',
    finalClass: 'A',
    model: 'm',
    promptVersion: 'p1',
    policyVersion: 'v1',
    diffSha: null,
    humanApproved: false,
    humanEdited: false,
    humanAbandoned: false,
    merged: true,
    mergedAt: daysAgo(30),
    defectWindowClosed: true,
    defectFired: false,
    verdict: 'agree',
    slipped: false,
    ...o,
  });
  const many = (n: number, o: Partial<ClassifierOutcomeRecord>) =>
    Array.from({ length: n }, (_, i) => rec({ prNumber: i + 1, ...o }));

  it('buckets each rule path', () => {
    expect(classifierOutcomeBucket(rec({ humanAbandoned: true, merged: false, defectWindowClosed: false }))).toBe(
      'humanGated',
    );
    expect(classifierOutcomeBucket(rec({ merged: false, defectWindowClosed: false }))).toBe('pending');
    expect(classifierOutcomeBucket(rec({ defectWindowClosed: false }))).toBe('pending');
    expect(classifierOutcomeBucket(rec({ defectFired: true }))).toBe('slippedDefect');
    expect(classifierOutcomeBucket(rec({ humanEdited: true }))).toBe('humanGated');
    expect(classifierOutcomeBucket(rec())).toBe('mergedClean');
  });

  it('builds the confusion table and prints it', () => {
    const report = summarizeClassifierOutcomes([
      rec({ prNumber: 1, modelClass: 'A' }),
      rec({ prNumber: 2, modelClass: 'B', defectFired: true }),
      rec({ prNumber: 3, modelClass: 'C', merged: false, defectWindowClosed: false }),
      rec({ prNumber: 4, modelClass: 'C', humanEdited: true }),
    ]);
    expect(report.total).toBe(4);
    expect(report.confusion.A.mergedClean).toBe(1);
    expect(report.confusion.B.slippedDefect).toBe(1);
    expect(report.confusion.C).toEqual({ humanGated: 1, mergedClean: 0, slippedDefect: 0, pending: 1 });
    const text = formatClassifierReport(report).join('\n');
    for (const h of ['human-gated', 'merged clean', 'slipped defect', 'pending']) expect(text).toContain(h);
    expect(formatClassifierReport(report).filter((l) => /^[ABC] {6}/.test(l))).toHaveLength(3);
  });

  it('shows the rule-of-three bound', () => {
    const report = summarizeClassifierOutcomes(many(60, {}));
    expect(report.classes.A.closed).toBe(60);
    expect(report.classes.A.slipped).toBe(0);
    expect(report.classes.A.slipRate).toBe(0);
    expect(report.classes.A.upperBound).toBeCloseTo(0.05);
    expect(formatClassifierReport(report)).toContain('A: 60 closed, 0 slipped — slip rate ≤ 5%');
  });

  it('prints unknown, never 0%, without closed evidence', () => {
    const report = summarizeClassifierOutcomes([
      rec({ modelClass: 'A', merged: false, defectWindowClosed: false }),
      rec({ prNumber: 2, modelClass: 'B' }),
    ]);
    expect(report.classes.A.upperBound).toBeNull();
    expect(report.classes.A.slipRate).toBeNull();
    const line = formatClassifierReport(report).find((l) => l.startsWith('A:'))!;
    expect(line).toContain('unknown');
    expect(line).not.toContain('0%');

    const empty = summarizeClassifierOutcomes([]);
    expect(empty.total).toBe(0);
    const lines = formatClassifierReport(empty);
    expect(lines[0]).toContain('factory kpis');
    expect(lines.filter((l) => l.includes('slip rate unknown'))).toHaveLength(3);
    expect(lines.join('\n')).toContain('(unknown)');
  });

  it('reports the observed rate when slips exist', () => {
    const records = [
      ...many(38, {}),
      rec({ prNumber: 100, defectFired: true }),
      rec({ prNumber: 101, defectFired: true }),
    ];
    const report = summarizeClassifierOutcomes(records);
    expect(report.classes.A.slipRate).toBeCloseTo(0.05);
    expect(report.classes.A.upperBound).toBeNull();
    expect(formatClassifierReport(report)).toContain('A: 40 closed, 2 slipped — observed slip rate 5%');
  });

  it('caps the bound at 100% for tiny n', () => {
    const report = summarizeClassifierOutcomes(many(2, {}));
    expect(report.classes.A.upperBound).toBe(1);
    expect(formatClassifierReport(report)).toContain('A: 2 closed, 0 slipped — slip rate ≤ 100%');
  });

  it('counts model vs floor strictness and ignores unknown classes', () => {
    const report = summarizeClassifierOutcomes([
      rec({ prNumber: 1, modelClass: 'B', floorClass: 'A' }),
      rec({ prNumber: 2, modelClass: 'B', floorClass: 'B' }),
      rec({ prNumber: 3, modelClass: 'A', floorClass: 'C' }),
      rec({ prNumber: 4, modelClass: 'A', floorClass: null }),
      rec({ prNumber: 5, modelClass: 'Z' as ReviewClass }),
    ]);
    expect(report.total).toBe(4);
    expect(report.floorAgreement).toEqual({ stricter: 1, equal: 1, looser: 1, noFloor: 1 });
    expect(formatClassifierReport(report).join('\n')).toContain(
      'Model vs floor: stricter 1 (33.3%), equal 1 (33.3%), looser 1 (33.3%); no floor 1',
    );
  });
});

describe('decideVerdict', () => {
  const closed = {
    humanEdited: false,
    humanAbandoned: false,
    merged: true,
    defectWindowClosed: true,
    defectFired: false,
  };

  it('is pending until merged and the window closes', () => {
    expect(decideVerdict('A', { ...closed, defectWindowClosed: false })).toEqual({
      verdict: 'pending',
      slipped: false,
    });
    expect(decideVerdict('B', { ...closed, merged: false })).toEqual({ verdict: 'pending', slipped: false });
  });

  it('marks an A that met a defect as slipped', () => {
    expect(decideVerdict('A', { ...closed, defectFired: true })).toEqual({ verdict: 'disagree', slipped: true });
    expect(decideVerdict('C', { ...closed, defectFired: true })).toEqual({ verdict: 'agree', slipped: false });
  });

  it('treats human edits and abandons as evidence for escalation', () => {
    expect(decideVerdict('A', { ...closed, humanEdited: true })).toEqual({ verdict: 'disagree', slipped: false });
    expect(decideVerdict('B', { ...closed, humanAbandoned: true, merged: false })).toEqual({
      verdict: 'agree',
      slipped: false,
    });
  });

  it('agrees with A on a clean merge', () => {
    expect(decideVerdict('A', closed)).toEqual({ verdict: 'agree', slipped: false });
    expect(decideVerdict('B', closed)).toEqual({ verdict: 'disagree', slipped: false });
  });
});
