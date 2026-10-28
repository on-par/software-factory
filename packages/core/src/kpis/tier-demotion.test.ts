import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '../types/index.js';
import {
  acknowledgeTierDemotions,
  effectiveTrustTier,
  findSlipDemotions,
  parseTierDemotions,
  serializeTierDemotions,
  tierDemotionComment,
} from './tier-demotion.js';

const NOW = '2026-01-10T00:00:00.000Z';

function land(issue: string, tier: string, ts = '2026-01-01T00:00:00.000Z'): FactoryEvent {
  return { ts, type: 'land', issue, msg: `risk low — trust tier ${tier} — eligible for auto-merge` };
}

function defect(issue: string, msg: string): FactoryEvent {
  return { ts: '2026-01-05T00:00:00.000Z', type: 'post-merge-defect', issue, msg };
}

const SLIP = 'issue #900 back-references PR #42';

describe('tier demotion', () => {
  it('demotes a T2-merged slip to T1', () => {
    const [rec] = findSlipDemotions([land('7', 'T2'), defect('7', SLIP)], [], { now: NOW });
    expect(rec).toMatchObject({ from: 'T2', to: 'T1', prNumber: 42, issue: '7', acknowledgedAt: null });
  });

  it('demotes a T1-merged slip to T0', () => {
    const [rec] = findSlipDemotions([land('7', 'T1'), defect('7', SLIP)], [], { now: NOW });
    expect(rec).toMatchObject({ from: 'T1', to: 'T0' });
  });

  it('ignores a slip on a PR merged under T0', () => {
    expect(findSlipDemotions([land('7', 'T0'), defect('7', SLIP)], [], { now: NOW })).toEqual([]);
    expect(findSlipDemotions([defect('7', SLIP)], [], { now: NOW })).toEqual([]);
  });

  it('records one demotion per PR across several defect signals', () => {
    const events = [land('7', 'T2'), defect('7', SLIP), defect('7', 'revert commit abc1234 reverts PR #42')];
    expect(findSlipDemotions(events, [], { now: NOW })).toHaveLength(1);
  });

  it('skips a PR that already has a record', () => {
    const events = [land('7', 'T2'), defect('7', SLIP)];
    const existing = findSlipDemotions(events, [], { now: NOW });
    expect(findSlipDemotions(events, existing, { now: NOW })).toEqual([]);
  });

  it('keeps the tier demoted across later clean joins until acknowledged', () => {
    const records = findSlipDemotions([land('7', 'T2'), defect('7', SLIP)], [], { now: NOW });
    const later = findSlipDemotions([land('7', 'T2')], records, { now: NOW });
    const parsed = parseTierDemotions(serializeTierDemotions([...records, ...later]));
    expect(effectiveTrustTier('T2', parsed)).toBe('T1');
  });

  it('acknowledged demotion restores the configured tier', () => {
    const records = findSlipDemotions([land('7', 'T2'), defect('7', SLIP)], [], { now: NOW });
    const acked = acknowledgeTierDemotions(records, { now: NOW, by: 'pat' });
    expect(acked.acknowledged).toHaveLength(1);
    expect(effectiveTrustTier('T2', { records: acked.records, malformed: 0 })).toBe('T2');
  });

  it('fails closed to T0 on a malformed record', () => {
    const parsed = parseTierDemotions('{"type":"tier-demoted","from":"T9","to":"T0","prNumber":1}\nnot json\n\n');
    expect(parsed).toEqual({ records: [], malformed: 2 });
    expect(effectiveTrustTier('T2', parsed)).toBe('T0');
  });

  it('sets defectIssue from an issue back-reference and null for a revert', () => {
    const a = findSlipDemotions([land('7', 'T2'), defect('7', SLIP)], [], { now: NOW });
    const b = findSlipDemotions([land('8', 'T2'), defect('8', 'revert commit abc1234 reverts PR #43')], [], {
      now: NOW,
    });
    expect(a[0]?.defectIssue).toBe(900);
    expect(b[0]?.defectIssue).toBeNull();
    expect(tierDemotionComment(a[0]!)).toMatch(/^<!-- factory:tier-demoted pr=42 -->\nTrust tier demoted T2 → T1/);
  });

  it('serializes an empty list as an empty string', () => {
    expect(serializeTierDemotions([])).toBe('');
  });
});
