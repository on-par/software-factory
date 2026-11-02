import { describe, expect, it } from 'vitest';

import type { ReviewRouting } from '../review/routing.js';
import { logTrustTier } from './trust-tier-log.js';

describe('logTrustTier (#1960)', () => {
  const base: ReviewRouting = { floor: 'A', gated: false, rules: [] };
  const run = (routing: ReviewRouting, stage: 'demotion' | 'receipt') => {
    const out: [string, string][] = [];
    logTrustTier(routing, stage, (kind, msg) => void out.push([kind, msg]));
    return out;
  };

  it('warns about a demotion only at the demotion stage', () => {
    const routing = { ...base, trustTier: { configured: 'T2' as const, effective: 'T1' as const, demotion: 'slip' } };
    expect(run(routing, 'demotion')).toEqual([['warn', 'trust tier T2 demoted to T1: slip']]);
    expect(run(routing, 'receipt')).toEqual([]);
  });

  it('logs the t2-auto receipt only at the receipt stage', () => {
    const routing: ReviewRouting = { ...base, receipt: 't2-auto' };
    expect(run(routing, 'receipt')[0][0]).toBe('land');
    expect(run(routing, 'receipt')[0][1].startsWith('t2-auto')).toBe(true);
    expect(run(routing, 'demotion')).toEqual([]);
  });

  it('logs nothing for a plain routing', () => {
    expect(run(base, 'demotion')).toEqual([]);
    expect(run(base, 'receipt')).toEqual([]);
  });
});
