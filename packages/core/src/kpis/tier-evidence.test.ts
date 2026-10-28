// packages/core/src/kpis/tier-evidence.test.ts — Trust-tier promotion evidence (ADR-0148, #1957).

import { describe, expect, it } from 'vitest';

import type { ClassifierOutcomeRecord } from './classifier-outcomes.js';
import { buildTierEvidence, coverageRatchetEvidence, formatTierEvidence } from './tier-evidence.js';

const now = new Date('2026-10-28T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

function outRec(prNumber: number, o: Partial<ClassifierOutcomeRecord> = {}): ClassifierOutcomeRecord {
  return {
    issue: String(prNumber),
    prNumber,
    classifiedAt: '2026-09-01T00:00:00.000Z',
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
    mergedAt: '2026-08-01T00:00:00.000Z',
    defectWindowClosed: true,
    defectFired: false,
    verdict: 'agree',
    slipped: false,
    ...o,
  };
}

const clean = (n: number) => Array.from({ length: n }, (_, i) => outRec(i + 1));
const coverage = (ok: boolean, ageDays = 1) => JSON.stringify({ ok, measuredAt: daysAgo(ageDays) });
const mutation = (ageDays = 1, floor: number | null = 70) =>
  JSON.stringify({
    packages: [
      { package: 'core', score: 80, floor, measuredAt: daysAgo(ageDays) },
      { package: 'cli', score: 75, floor: 70, measuredAt: daysAgo(ageDays) },
    ],
  });

const full = {
  configuredTier: 'T0' as const,
  records: clean(60),
  mutationSummaryText: mutation(),
  coverageEvidenceText: coverage(true),
  now,
};

describe('tier evidence (#1957)', () => {
  it('full evidence marks every criterion met and names the next tier', () => {
    const r = buildTierEvidence(full);
    expect(r.coverage.status).toBe('met');
    expect(r.mutation.status).toBe('met');
    expect(r.humanIntervention.status).toBe('met');
    expect(r.slips.status).toBe('met');
    expect(r.unmet).toEqual([]);
    expect(r.eligibleFor).toBe('T1');
    expect(buildTierEvidence({ ...full, configuredTier: 'T1' }).eligibleFor).toBe('T2');
    expect(formatTierEvidence(r)).toContain('eligible for: T1');
  });

  it('a missing mutation summary is unknown and blocks eligibility', () => {
    const r = buildTierEvidence({ ...full, mutationSummaryText: undefined });
    expect(r.mutation.status).toBe('unknown');
    expect(r.unmet).toEqual(['mutation']);
    expect(r.eligibleFor).toBe('none');
    const text = formatTierEvidence(r).join('\n');
    expect(text).toContain('mutation: unknown');
    expect(text).toContain('unmet: mutation');
  });

  it('a stale mutation summary is unknown', () => {
    const r = buildTierEvidence({ ...full, mutationSummaryText: mutation(30) });
    expect(r.mutation.packages[0].score).toBe('unknown');
    expect(r.unmet).toContain('mutation');
  });

  it('a null floor and malformed JSON are unknown', () => {
    expect(buildTierEvidence({ ...full, mutationSummaryText: mutation(1, null) }).mutation.status).toBe('unknown');
    for (const bad of ['{nope', '[]', '{"packages":{}}', '{"packages":[{"package":""}]}', '']) {
      expect(buildTierEvidence({ ...full, mutationSummaryText: bad }).mutation).toEqual({
        status: 'unknown',
        packages: [],
      });
    }
  });

  it('a score below its floor is unmet', () => {
    const text = JSON.stringify({ packages: [{ package: 'core', score: 60, floor: 70, measuredAt: daysAgo(1) }] });
    const r = buildTierEvidence({ ...full, mutationSummaryText: text });
    expect(r.mutation.status).toBe('unmet');
    expect(formatTierEvidence(r).join('\n')).toContain('core: 60% vs floor 70% — unmet');
  });

  it('no merged PRs renders unknown slip and intervention rates, never 0%', () => {
    const pending = [outRec(1, { merged: false, defectWindowClosed: false }), outRec(2, { defectWindowClosed: false })];
    for (const records of [[], pending]) {
      const r = buildTierEvidence({ ...full, records });
      for (const e of [r.slips, r.humanIntervention]) {
        expect(e.rate).toBeNull();
        expect(e.upperBound).toBeNull();
        expect(e.status).toBe('unknown');
      }
      const lines = formatTierEvidence(r);
      const text = lines.join('\n');
      expect(text).toContain('slips: unknown');
      expect(text).not.toMatch(/slips: 0%/);
      for (const l of lines.filter((x) => x.startsWith('slips') || x.startsWith('human intervention'))) {
        expect(l).not.toContain('0%');
      }
    }
  });

  it('slips above the limit are unmet and observed rate is shown', () => {
    const slipped = (k: number) => clean(20).map((r, i) => (i < k ? { ...r, defectFired: true, slipped: true } : r));
    const one = buildTierEvidence({ ...full, records: slipped(1) });
    expect(one.slips.status).toBe('met');
    expect(formatTierEvidence(one).join('\n')).toContain('observed 5%');
    expect(buildTierEvidence({ ...full, records: slipped(2) }).slips.status).toBe('unmet');
  });

  it('human edits count as intervention with a caveat', () => {
    const edited = (k: number) => clean(60).map((r, i) => (i < k ? { ...r, humanEdited: true } : r));
    const twelve = buildTierEvidence({ ...full, records: edited(12) });
    expect(twelve.humanIntervention.status).toBe('met');
    expect(twelve.humanIntervention.caveat).toContain('Edits made outside GitHub are not seen.');
    expect(buildTierEvidence({ ...full, records: edited(13) }).humanIntervention.status).toBe('unmet');
  });

  it('coverage red or stale', () => {
    const red = buildTierEvidence({ ...full, coverageEvidenceText: coverage(false) });
    expect(red.coverage).toMatchObject({ status: 'unmet', ratchet: 'red' });
    const old = buildTierEvidence({ ...full, coverageEvidenceText: coverage(true, 30) });
    expect(old.coverage.status).toBe('unknown');
    expect(old.coverage.measuredAt).not.toBeNull();
    for (const bad of [undefined, '', 'garbage', '{"ok":"yes","measuredAt":"x"}', '{"ok":true,"measuredAt":"x"}']) {
      expect(buildTierEvidence({ ...full, coverageEvidenceText: bad }).coverage).toEqual({
        status: 'unknown',
        ratchet: 'unknown',
        measuredAt: null,
      });
    }
  });

  it('T2 is the top tier', () => {
    const r = buildTierEvidence({ ...full, configuredTier: 'T2' });
    expect(r.eligibleFor).toBe('none');
    expect(formatTierEvidence(r).join('\n')).toContain('top tier');
  });

  it('coverageRatchetEvidence serialises ok and ISO time', () => {
    expect(coverageRatchetEvidence(true, now)).toEqual({ ok: true, measuredAt: '2026-10-28T00:00:00.000Z' });
  });
});
