import { checkStoryInvest as sharedCheckStoryInvest } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { checkStoryInvest } from './decompose.js';

const story: Story = {
  schemaVersion: 1,
  kind: 'story',
  title: 'Build the retry button',
  role: 'ops team member',
  want: 'build the retry button',
  soThat: 'fewer support tickets',
  problemStatement: 'The export breaks weekly.',
  inScope: ['build the retry button'],
  outOfScope: [],
  acceptanceCriteria: [{ name: 'retry', given: [], when: ['clicked'], then: ['export reruns'], tracesTo: [] }],
  verification: [{ command: 'npm test', passWhen: 'exit 0' }],
  filesLikelyTouched: [],
  labels: [],
  tracesTo: ['INT-PROBLEM-01'],
};

describe('checkStoryInvest', () => {
  it("is the shared @on-par/contracts rule set and reports the same finding as product's decomposer", () => {
    expect(checkStoryInvest).toBe(sharedCheckStoryInvest);
    expect(checkStoryInvest(story).violations).toEqual(sharedCheckStoryInvest(story).violations);
    expect(checkStoryInvest(story).violations).toContainEqual({
      letter: 'negotiable',
      reason: 'no out-of-scope boundary — nothing left to negotiate',
    });
  });
});
