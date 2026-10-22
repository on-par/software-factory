import { describe, expect, it } from 'vitest';

import type { CheckPhaseResult } from '../phases/check.js';
import { classifyCheckFailure } from './check-verdict.js';

const failed = (over: Partial<CheckPhaseResult> = {}): CheckPhaseResult => ({
  passed: false,
  summary: { failures: 2, passes: 0, skips: 0, total: 2, results: [] },
  reworkRounds: 3,
  ...over,
});

describe('classifyCheckFailure (#3435)', () => {
  it('maps a plain failure to fail', () => {
    expect(classifyCheckFailure(failed())).toEqual({
      reason: 'fail',
      message: '2 check failures after 3 rework rounds',
    });
  });

  it('maps stuck to escalate', () => {
    expect(classifyCheckFailure(failed({ stuck: true }))).toMatchObject({
      reason: 'escalate',
      message: 'lane stuck after 3 rework rounds (identical failures) — escalated',
    });
  });

  it('lets crossRunStuck win over stuck', () => {
    const verdict = classifyCheckFailure(failed({ stuck: true, crossRunStuck: true }));
    expect(verdict.reason).toBe('held');
    expect(verdict.message).toContain('issue held');
  });

  it('has no checkFailure without a signature and names FAIL checkers with one', () => {
    expect(classifyCheckFailure(failed()).checkFailure).toBeUndefined();
    const summary = {
      failures: 1,
      passes: 1,
      skips: 0,
      total: 2,
      results: [
        { checker: 'tests', result: 'FAIL', details: 'x' },
        { checker: 'lint', result: 'PASS', details: '' },
      ],
    } as CheckPhaseResult['summary'];
    expect(classifyCheckFailure(failed({ failureSignature: 'sig', summary })).checkFailure).toEqual({
      failureSignature: 'sig',
      failingChecks: ['tests'],
    });
  });

  it('words a CI re-CHECK failure by CI round', () => {
    expect(classifyCheckFailure(failed(), { ciReworkRound: 2 }).message).toBe(
      '2 check failures after CI rework round 2',
    );
  });

  it('appends remaining showstoppers', () => {
    const summary = {
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'lens_review', result: 'FAIL', details: '- src/a.ts:12 — injection' }],
    } as CheckPhaseResult['summary'];
    expect(classifyCheckFailure(failed({ summary })).message).toBe(
      '1 check failures after 3 rework rounds\nremaining showstoppers:\n- - src/a.ts:12 — injection',
    );
  });
});
