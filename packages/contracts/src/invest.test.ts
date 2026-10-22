// src/invest.test.ts (#472).

import { describe, expect, it } from 'vitest';

import { checkStoryInvest, MAX_ACCEPTANCE_CRITERIA_ITEMS, MAX_IN_SCOPE_ITEMS } from './invest.js';
import type { Story } from './issue.js';

function cleanStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: 1,
    kind: 'story',
    title: 'Build the retry button',
    role: 'ops team member',
    want: 'build the retry button',
    soThat: 'fewer support tickets',
    problemStatement: 'The export breaks weekly.',
    inScope: ['build the retry button'],
    outOfScope: ['automated retries'],
    acceptanceCriteria: [
      {
        name: 'Outcome: Fewer support tickets',
        given: ['the ops team'],
        when: ['build the retry button'],
        then: ['fewer support tickets'],
        tracesTo: ['INT-OUTCOME-01'],
      },
    ],
    verification: [{ command: 'manual: confirm fewer support tickets', passWhen: 'fewer support tickets' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01'],
    ...overrides,
  };
}

describe('checkStoryInvest', () => {
  it('reports ok: true with no violations for a clean story', () => {
    expect(checkStoryInvest(cleanStory())).toEqual({ ok: true, violations: [] });
  });

  it('flags independent when want or an inScope entry names a dependency cue', () => {
    const report = checkStoryInvest(cleanStory({ want: 'once the export ships, build the retry button' }));
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.letter)).toContain('independent');
  });

  it('flags negotiable when outOfScope is empty', () => {
    const report = checkStoryInvest(cleanStory({ outOfScope: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('negotiable');
  });

  it('flags valuable when tracesTo is empty', () => {
    const report = checkStoryInvest(cleanStory({ tracesTo: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('valuable');
  });

  it('flags valuable when soThat is blank', () => {
    const report = checkStoryInvest(cleanStory({ soThat: '   ' }));
    expect(report.violations.map((v) => v.letter)).toContain('valuable');
  });

  it('flags estimable when there are no acceptance criteria', () => {
    const report = checkStoryInvest(cleanStory({ acceptanceCriteria: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('estimable');
  });

  it('flags estimable when there is no verification step', () => {
    const report = checkStoryInvest(cleanStory({ verification: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('estimable');
  });

  it('flags small when inScope exceeds MAX_IN_SCOPE_ITEMS', () => {
    const report = checkStoryInvest(
      cleanStory({ inScope: Array.from({ length: MAX_IN_SCOPE_ITEMS + 1 }, (_, i) => `item ${i}`) }),
    );
    expect(report.violations.map((v) => v.letter)).toContain('small');
  });

  it('flags small when acceptanceCriteria exceeds MAX_ACCEPTANCE_CRITERIA_ITEMS', () => {
    const criterion = { name: 'n', given: [], when: ['w'], then: ['t'], tracesTo: [] };
    const report = checkStoryInvest(
      cleanStory({ acceptanceCriteria: Array.from({ length: MAX_ACCEPTANCE_CRITERIA_ITEMS + 1 }, () => criterion) }),
    );
    expect(report.violations.map((v) => v.letter)).toContain('small');
  });

  it('flags testable when a criterion has no When or no Then', () => {
    const report = checkStoryInvest(
      cleanStory({
        acceptanceCriteria: [{ name: 'Broken', given: [], when: [], then: ['t'], tracesTo: [] }],
      }),
    );
    expect(report.ok).toBe(false);
    const violation = report.violations.find((v) => v.letter === 'testable');
    expect(violation?.reason).toContain('Broken');
  });
});
