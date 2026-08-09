import { describe, expect, it } from 'vitest';

import type { ProposedDecomposition } from './parse.js';
import { DECOMPOSITION_MARKER, renderDecompositionComment } from './render.js';

function decomposition(): ProposedDecomposition {
  return {
    epic: {
      schemaVersion: 1,
      kind: 'epic',
      title: 'Retry flow',
      why: 'Fewer support tickets.',
      doneWhen: ['Both stories ship.'],
      children: ['Build the retry button', 'Wire retry telemetry'],
      labels: [],
      tracesTo: [],
    },
    stories: [
      {
        schemaVersion: 1,
        kind: 'story',
        title: 'Build the retry button',
        role: 'ops team member',
        want: 'a retry button on failed exports',
        soThat: 'fewer support tickets',
        problemStatement: 'The export breaks weekly.',
        inScope: ['Add a retry button to the export panel'],
        outOfScope: ['Automated retries'],
        acceptanceCriteria: [
          {
            name: 'Retry works',
            given: ['a failed export'],
            when: ['I click retry'],
            then: ['the export retries'],
            tracesTo: [],
          },
          { name: 'No given clause', given: [], when: ['I click retry'], then: ['the export retries'], tracesTo: [] },
        ],
        verification: [{ command: 'npm test', passWhen: 'retry tests pass' }],
        filesLikelyTouched: [],
        labels: [],
        tracesTo: ['INT-SCOPE-01'],
      },
      {
        schemaVersion: 1,
        kind: 'story',
        title: 'Wire retry telemetry',
        role: 'support engineer',
        want: 'to see retry counts',
        soThat: 'we can measure flakiness',
        problemStatement: 'Retries are invisible today.',
        inScope: ['Emit a retry_count metric'],
        outOfScope: ['A dashboard'],
        acceptanceCriteria: [
          {
            name: 'Metric emitted',
            given: [],
            when: ['a retry happens'],
            then: ['retry_count increments'],
            tracesTo: [],
          },
        ],
        verification: [{ command: 'npm test', passWhen: 'telemetry tests pass' }],
        filesLikelyTouched: [],
        labels: [],
        tracesTo: ['INT-SCOPE-02'],
      },
    ],
  };
}

describe('renderDecompositionComment', () => {
  it('starts with the DECOMPOSITION_MARKER', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment.startsWith(DECOMPOSITION_MARKER)).toBe(true);
  });

  it('renders the epic Why/Children/Done when and a Sequencing section', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment).toContain('### Why');
    expect(comment).toContain('### Children');
    expect(comment).toContain('### Done when');
    expect(comment).toContain('### Sequencing');
    expect(comment).toContain('1. Build the retry button — fewer support tickets');
    expect(comment).toContain('2. Wire retry telemetry — we can measure flakiness');
  });

  it('renders each story section with Problem statement / In scope / Out of scope / Acceptance criteria / Verification, Why, and Goal', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment).toContain('### Problem statement');
    expect(comment).toContain('### In scope');
    expect(comment).toContain('### Out of scope');
    expect(comment).toContain('### Acceptance criteria');
    expect(comment).toContain('### Verification');
    expect(comment).toContain('**Why:** fewer support tickets');
    expect(comment).toContain('**Goal:** As a ');
  });

  it('numbers children in epic.children order matching the story titles', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment).toContain('- [ ] 1. Build the retry button');
    expect(comment).toContain('- [ ] 2. Wire retry telemetry');
  });

  it('renders a criterion with an empty given with no Given clause', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment).toContain('- [ ] No given clause — When I click retry, Then the export retries');
    expect(comment).toContain('- [ ] Retry works — Given a failed export, When I click retry, Then the export retries');
  });

  it('says nothing was filed and the issue was not modified', () => {
    const comment = renderDecompositionComment({ issue: 606, sizeReason: 'too big', decomposition: decomposition() });
    expect(comment).toContain('Nothing has been filed');
    expect(comment).toContain('this issue has not been modified');
  });
});
