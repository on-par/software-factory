// packages/contracts/src/invest.test.ts (#472, moved from @on-par/product in #606).

import { describe, expect, it } from 'vitest';

import { checkInvest, MAX_ACCEPTANCE_CRITERIA, MAX_IN_SCOPE } from './invest.js';
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

describe('checkInvest', () => {
  it('reports ok: true with no violations for a clean story', () => {
    expect(checkInvest(cleanStory())).toEqual({ ok: true, violations: [] });
  });

  it('flags independent when want or an inScope entry names a dependency cue', () => {
    const report = checkInvest(cleanStory({ want: 'once the export ships, build the retry button' }));
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.letter)).toContain('independent');
  });

  it('flags negotiable when outOfScope is empty', () => {
    const report = checkInvest(cleanStory({ outOfScope: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('negotiable');
  });

  it('flags valuable when tracesTo is empty', () => {
    const report = checkInvest(cleanStory({ tracesTo: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('valuable');
  });

  it('flags valuable when soThat is blank', () => {
    const report = checkInvest(cleanStory({ soThat: '   ' }));
    expect(report.violations.map((v) => v.letter)).toContain('valuable');
  });

  it('flags estimable when there are no acceptance criteria', () => {
    const report = checkInvest(cleanStory({ acceptanceCriteria: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('estimable');
  });

  it('flags estimable when there is no verification step', () => {
    const report = checkInvest(cleanStory({ verification: [] }));
    expect(report.violations.map((v) => v.letter)).toContain('estimable');
  });

  it('flags small when inScope exceeds MAX_IN_SCOPE', () => {
    const report = checkInvest(
      cleanStory({ inScope: Array.from({ length: MAX_IN_SCOPE + 1 }, (_, i) => `item ${i}`) }),
    );
    expect(report.violations.map((v) => v.letter)).toContain('small');
  });

  it('flags small when acceptanceCriteria exceeds MAX_ACCEPTANCE_CRITERIA', () => {
    const criterion = { name: 'n', given: [], when: ['w'], then: ['t'], tracesTo: [] };
    const report = checkInvest(
      cleanStory({ acceptanceCriteria: Array.from({ length: MAX_ACCEPTANCE_CRITERIA + 1 }, () => criterion) }),
    );
    expect(report.violations.map((v) => v.letter)).toContain('small');
  });

  it('flags testable when a criterion has no When or no Then', () => {
    const report = checkInvest(
      cleanStory({
        acceptanceCriteria: [{ name: 'Broken', given: [], when: [], then: ['t'], tracesTo: [] }],
      }),
    );
    expect(report.ok).toBe(false);
    const violation = report.violations.find((v) => v.letter === 'testable');
    expect(violation?.reason).toContain('Broken');
  });
});
