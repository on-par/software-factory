import { describe, expect, it } from 'vitest';

import type { EvidencePack, FailoverReason, FingerprintedFailure } from '../types/index.js';
import type { FilingLedger, FilingPolicy } from './policy.js';
import {
  DEFAULT_FILING_POLICY,
  emptyLedger,
  evaluateFilingPolicy,
  isAutoMergeBlocked,
  labelsFor,
  recordFiled,
  recordPark,
  rollDay,
  touchesSensitiveScope,
} from './policy.js';

const clock = () => new Date('2026-07-20T00:00:00.000Z');

function makeEvidence(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    repo: 'on-par/widgets',
    issue: '42',
    phase: 'build',
    model: 'claude-sonnet-5',
    reason: 'verify_failed',
    component: 'check:tests',
    origin: 'product',
    eventExcerpt: 'tests failed: 2 of 40',
    logPath: '/logs/run-1.ndjson',
    ...overrides,
  };
}

function makeFingerprinted(overrides: Partial<EvidencePack> = {}, fingerprint = 'ff_abc123'): FingerprintedFailure {
  return { fingerprint, evidence: makeEvidence(overrides) };
}

function makeLedger(overrides: Partial<FilingLedger> = {}): FilingLedger {
  return { ...emptyLedger(clock), ...overrides };
}

const policy: FilingPolicy = DEFAULT_FILING_POLICY;

describe('evaluateFilingPolicy', () => {
  it('never files expected/throttle conditions with a fresh ledger', () => {
    const expectedReasons: FailoverReason[] = ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'];
    for (const reason of expectedReasons) {
      const decision = evaluateFilingPolicy(makeFingerprinted({ reason }), makeLedger(), policy, clock);
      expect(decision.file).toBe(false);
      if (!decision.file) expect(decision.skipReason).toBe('expected-condition');
    }
  });

  it('files a genuine defect with a fresh ledger', () => {
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'error' }), makeLedger(), policy, clock);
    expect(decision.file).toBe(true);
  });

  it('overrides exclusion once the same fingerprint repeats past the threshold', () => {
    const ledger = makeLedger({ occurrences: { ff_abc123: policy.repeatThreshold - 1 } });
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'rate_limit' }), ledger, policy, clock);
    expect(decision.file).toBe(true);
  });

  it('halts on the daily cap and reports the fingerprint', () => {
    const ledger = makeLedger({ day: '2026-07-20', filedToday: policy.maxPerDay });
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'error' }), ledger, policy, clock);
    expect(decision.file).toBe(false);
    if (!decision.file) {
      expect(decision.skipReason).toBe('per-day-cap');
      expect(decision.fingerprint).toBe('ff_abc123');
    }
  });

  it('halts on the per-run cap when the daily cap has headroom', () => {
    const ledger = makeLedger({ filedThisRun: policy.maxPerRun, filedToday: 0 });
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'error' }), ledger, policy, clock);
    expect(decision.file).toBe(false);
    if (!decision.file) expect(decision.skipReason).toBe('per-run-cap');
  });

  it('rolls the day forward so a stale daily cap does not block a new day', () => {
    const ledger = makeLedger({ day: '2026-07-19', filedToday: policy.maxPerDay });
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'error' }), ledger, policy, clock);
    expect(decision.file).toBe(true);
  });

  it('skips filing when disabled, regardless of reason', () => {
    const disabled: FilingPolicy = { ...policy, enabled: false };
    const decision = evaluateFilingPolicy(makeFingerprinted({ reason: 'error' }), makeLedger(), disabled, clock);
    expect(decision.file).toBe(false);
    if (!decision.file) expect(decision.skipReason).toBe('filing-disabled');
  });
});

describe('labelsFor', () => {
  it('adds the self-fix label for factory-internal origin', () => {
    expect(labelsFor(makeEvidence({ origin: 'factory-internal' }), policy)).toContain('no-auto-merge');
  });

  it('does not add the self-fix label for product origin', () => {
    expect(labelsFor(makeEvidence({ origin: 'product' }), policy)).not.toContain('no-auto-merge');
  });
});

describe('isAutoMergeBlocked', () => {
  it('is true when the self-fix label is present', () => {
    expect(isAutoMergeBlocked(['bug', 'no-auto-merge'], policy)).toBe(true);
  });

  it('is false when the self-fix label is absent', () => {
    expect(isAutoMergeBlocked(['bug'], policy)).toBe(false);
  });
});

describe('touchesSensitiveScope', () => {
  it('is true for a sensitive path prefix', () => {
    expect(touchesSensitiveScope(['packages/core/src/x.ts'], policy)).toBe(true);
  });

  it('is false for an unrelated path', () => {
    expect(touchesSensitiveScope(['README.md'], policy)).toBe(false);
  });

  it('is true when the regex arm matches (e.g. a token-related file)', () => {
    expect(touchesSensitiveScope(['src/authToken.ts'], policy)).toBe(true);
  });
});

describe('ledger purity', () => {
  it('recordPark returns a new object and does not mutate the input', () => {
    const ledger = makeLedger();
    const next = recordPark(ledger, 'ff_abc123');
    expect(next).not.toBe(ledger);
    expect(ledger.occurrences.ff_abc123).toBeUndefined();
    expect(next.occurrences.ff_abc123).toBe(1);
  });

  it('rollDay returns a new object and does not mutate the input', () => {
    const ledger = makeLedger({ day: '2026-07-19', filedToday: 4 });
    const next = rollDay(ledger, clock);
    expect(next).not.toBe(ledger);
    expect(ledger.day).toBe('2026-07-19');
    expect(next.day).toBe('2026-07-20');
    expect(next.filedToday).toBe(0);
  });

  it('recordFiled returns a new object and does not mutate the input', () => {
    const ledger = makeLedger();
    const next = recordFiled(ledger, clock);
    expect(next).not.toBe(ledger);
    expect(ledger.filedToday).toBe(0);
    expect(next.filedToday).toBe(1);
    expect(next.filedThisRun).toBe(1);
  });

  it('recordFiled across a day boundary resets filedToday to 1', () => {
    const ledger = makeLedger({ day: '2026-07-19', filedToday: 4, filedThisRun: 4 });
    const next = recordFiled(ledger, clock);
    expect(next.day).toBe('2026-07-20');
    expect(next.filedToday).toBe(1);
    expect(next.filedThisRun).toBe(5);
  });
});
