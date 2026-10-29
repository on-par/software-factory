import { describe, expect, it } from 'vitest';

import type { FilingLedger, FilingPolicy } from './policy.js';
import { emptyLedger, isAutoMergeBlocked, recordFiled, rollDay } from './policy.js';

const clock = () => new Date('2026-07-20T00:00:00.000Z');

function makeLedger(overrides: Partial<FilingLedger> = {}): FilingLedger {
  return { ...emptyLedger(clock), ...overrides };
}

const policy: FilingPolicy = {
  enabled: true,
  excludeReasons: [],
  repeatThreshold: 3,
  maxPerRun: 5,
  maxPerDay: 20,
  selfFixLabel: 'no-auto-merge',
  bugLabels: ['bug'],
  sensitivePaths: [],
};

describe('isAutoMergeBlocked', () => {
  it('is true when the self-fix label is present', () => {
    expect(isAutoMergeBlocked(['bug', 'no-auto-merge'], policy)).toBe(true);
  });

  it('is false when the self-fix label is absent', () => {
    expect(isAutoMergeBlocked(['bug'], policy)).toBe(false);
  });
});

describe('ledger purity', () => {
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
