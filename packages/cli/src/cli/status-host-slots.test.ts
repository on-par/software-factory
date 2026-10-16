import type { HostSlotStatus } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { formatHostSlotsSection } from './status-host-slots.js';

const slot = (n: number, repo: string, issue: number, extra: Partial<HostSlotStatus> = {}): HostSlotStatus => ({
  slot: n,
  pid: 4000 + n,
  repo,
  issue,
  phase: 'build',
  token: 't',
  acquiredAt: '',
  stale: false,
  unreadable: false,
  ...extra,
});

describe('formatHostSlotsSection (#3045)', () => {
  it('lists live slots with repo, issue, pid and the in-use count', () => {
    const lines = formatHostSlotsSection([slot(0, 'on-par/a', 11), slot(1, 'on-par/b', 22, { phase: 'check' })], 2);
    expect(lines.some((l) => l.includes('on-par/a#11') && l.includes('pid'))).toBe(true);
    expect(lines.some((l) => l.includes('on-par/b#22') && l.includes('check'))).toBe(true);
    expect(lines.at(-1)).toBe('  builds 2/2 in use');
  });

  it('reports no slots for an empty list', () => {
    expect(formatHostSlotsSection([], 2)).toEqual(['  (no host slots in use)', '  builds 0/2 in use']);
  });

  it('marks stale slots and leaves them out of the count', () => {
    const lines = formatHostSlotsSection([slot(0, 'on-par/a', 11, { stale: true }), slot(1, 'on-par/b', 22)], 2);
    expect(lines[0]).toContain('stale');
    expect(lines.at(-1)).toBe('  builds 1/2 in use');
  });

  it('shows unreadable lease files and counts them', () => {
    const lines = formatHostSlotsSection([slot(0, '', 0, { unreadable: true })], 2);
    expect(lines[0]).toContain('(unreadable lease file)');
    expect(lines.at(-1)).toBe('  builds 1/2 in use');
  });
});
