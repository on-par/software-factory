// src/kpis/classifier-outcomes.test.ts — Join shadow verdicts to outcomes (#1726)

import { describe, expect, it } from 'vitest';
import type { ReviewClass } from '../review/floor.js';
import type { FactoryEvent } from '../types/index.js';
import { joinClassifierOutcomes, mergeClassifierOutcomes, parseClassifierOutcomes } from './classifier-outcomes.js';
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
