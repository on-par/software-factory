// #3126
import { describe, expect, it } from 'vitest';

import type { CostEntry } from '../types/index.js';
import { phaseOfCostEntry, phaseOfTask } from './phase.js';

function cost(task: string, extra: Partial<CostEntry> = {}): CostEntry {
  return { ts: '', issue: '1', task, model: 'm', inputTokens: 1, outputTokens: 1, cost: 0, ...extra };
}

describe('phase attribution (#3126)', () => {
  it('maps readiness_judge to plan (#3467)', () => {
    expect(phaseOfTask('readiness_judge')).toBe('plan');
  });

  it('maps build_opencode, build_command, readiness_enrich, decompose and steward rows to their phase', () => {
    expect(phaseOfCostEntry(cost('build_opencode'))).toBe('build');
    expect(phaseOfCostEntry(cost('build_command'))).toBe('build');
    expect(phaseOfCostEntry(cost('readiness_enrich'))).toBe('plan');
    expect(phaseOfCostEntry(cost('decompose'))).toBe('plan');
    expect(phaseOfCostEntry(cost('steward'))).toBe('ship');
  });

  it('attributes checker-retry rows to check regardless of task', () => {
    expect(phaseOfCostEntry(cost('build_claude', { retryCause: 'checker' }))).toBe('check');
  });

  it('returns null for unmapped task names, including Object.prototype keys', () => {
    expect(phaseOfTask('unknown')).toBeNull();
    expect(phaseOfTask('')).toBeNull();
    expect(phaseOfTask('constructor')).toBeNull();
  });
});
