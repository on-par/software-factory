// packages/product/src/decompose/render.test.ts (#472).

import type { Epic, Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from './decompose.js';
import { renderDecomposition } from './render.js';

const EPIC: Epic = {
  schemaVersion: 1,
  kind: 'epic',
  title: 'Fix the weekly export break',
  why: 'The export breaks weekly.',
  doneWhen: ['Fewer support tickets'],
  children: ['Build the retry button'],
  labels: [],
  tracesTo: ['INT-AUDIENCE-01', 'INT-OUTCOME-01', 'INT-NONGOALS-01', 'INT-CONSTRAINTS-01'],
};

const STORY_WITH_GIVEN: Story = {
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
      given: ['ops team member'],
      when: ['build the retry button'],
      then: ['fewer support tickets'],
      tracesTo: ['INT-AUDIENCE-01', 'INT-SCOPE-01', 'INT-OUTCOME-01'],
    },
  ],
  verification: [{ command: 'manual: confirm fewer support tickets', passWhen: 'fewer support tickets' }],
  filesLikelyTouched: [],
  labels: [],
  investNote: 'Vertical slice 1 of 1: build the retry button',
  tracesTo: ['INT-SCOPE-01', 'INT-AUDIENCE-01', 'INT-OUTCOME-01'],
};

describe('renderDecomposition', () => {
  it('renders the epic header, done-when bullets, and traces-to, then each story', () => {
    const decomposition: Decomposition = { epic: EPIC, stories: [STORY_WITH_GIVEN] };

    expect(renderDecomposition(decomposition)).toEqual([
      '# Decomposition',
      '## Epic: Fix the weekly export break',
      'Why: The export breaks weekly.',
      'Done when:',
      '- Fewer support tickets',
      'Traces to: INT-AUDIENCE-01, INT-OUTCOME-01, INT-NONGOALS-01, INT-CONSTRAINTS-01',
      '',
      '### Story 1: Build the retry button',
      'As a ops team member, I want build the retry button, so that fewer support tickets',
      'In scope:',
      '- build the retry button',
      'Out of scope:',
      '- automated retries',
      'Acceptance criteria:',
      '- Outcome: Fewer support tickets',
      '  Given ops team member',
      '  When build the retry button',
      '  Then fewer support tickets',
      '  Traces to: INT-AUDIENCE-01, INT-SCOPE-01, INT-OUTCOME-01',
      'Traces to: INT-SCOPE-01, INT-AUDIENCE-01, INT-OUTCOME-01',
    ]);
  });

  it('omits the Given line entirely when a criterion has an empty given, and separates stories with a blank line', () => {
    const storyNoGiven: Story = {
      ...STORY_WITH_GIVEN,
      title: 'App boots cleanly',
      acceptanceCriteria: [
        {
          name: 'App boots',
          given: [],
          when: ['the process starts'],
          then: ['it listens on the configured port'],
          tracesTo: [],
        },
      ],
      tracesTo: [],
    };
    const decomposition: Decomposition = { epic: EPIC, stories: [STORY_WITH_GIVEN, storyNoGiven] };

    const lines = renderDecomposition(decomposition);
    const secondStoryIndex = lines.indexOf('### Story 2: App boots cleanly');

    expect(lines[secondStoryIndex - 1]).toBe('');
    expect(lines).toContain('- App boots');
    expect(lines).not.toContain('  Given ');
    const acceptanceIndex = lines.indexOf('- App boots');
    expect(lines[acceptanceIndex + 1]).toBe('  When the process starts');
  });
});
