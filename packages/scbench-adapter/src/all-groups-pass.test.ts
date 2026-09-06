// packages/scbench-adapter/src/all-groups-pass.test.ts — allGroupsPass predicate (#1254).
import { describe, expect, it } from 'vitest';
import { allGroupsPass } from './all-groups-pass.js';
import type { ScbenchEvaluation } from './baseline.js';

function evaluation(pass_counts: Record<string, number>, total_counts: Record<string, number>): ScbenchEvaluation {
  return {
    problem_name: 'p',
    checkpoint_name: 'c',
    pass_counts,
    total_counts,
    pytest_exit_code: 0,
    infrastructure_failure: false,
  };
}

describe('allGroupsPass', () => {
  it('returns true when all groups are green', () => {
    expect(allGroupsPass(evaluation({ Core: 4, Functionality: 10 }, { Core: 4, Functionality: 10 }))).toBe(true);
  });

  it('returns false for a Functionality-only failure', () => {
    expect(allGroupsPass(evaluation({ Core: 4, Functionality: 8 }, { Core: 4, Functionality: 10 }))).toBe(false);
  });

  it('treats a group with total 0 as vacuously passing', () => {
    expect(allGroupsPass(evaluation({ Core: 0 }, { Core: 0 }))).toBe(true);
  });
});
