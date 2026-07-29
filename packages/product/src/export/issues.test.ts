// packages/product/src/export/issues.test.ts (#476).

import { CONTRACTS_SCHEMA_VERSION, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { renderEpicIssue, renderStoryIssue } from './issues.js';

const EPIC: Epic = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'epic',
  title: 'Export the handoff',
  why: 'engineering needs filed issues',
  doneWhen: ['issues are filed', 'bundle is attached'],
  children: ['Story A', 'Story B'],
  labels: ['epic'],
  tracesTo: [],
};

function buildStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'Story A',
    role: 'engineer',
    want: 'a filed issue',
    soThat: 'I can start work',
    problemStatement: 'nothing is filed yet',
    inScope: ['file the issue'],
    outOfScope: ['program design'],
    acceptanceCriteria: [
      {
        name: 'issue is filed',
        given: ['an approved plan'],
        when: ['export runs'],
        then: ['the issue exists'],
        tracesTo: ['INT-SCOPE-01'],
      },
    ],
    verification: [{ command: 'npm test', passWhen: 'green' }],
    filesLikelyTouched: [],
    labels: ['story'],
    investNote: 'independent slice',
    tracesTo: ['INT-SCOPE-01', 'INT-OUTCOME-01'],
    ...overrides,
  };
}

describe('renderEpicIssue', () => {
  it('passes through title and labels, and renders the standard sections in order', () => {
    const payload = renderEpicIssue(EPIC);

    expect(payload.title).toBe(EPIC.title);
    expect(payload.labels).toBe(EPIC.labels);
    expect(payload.body).toContain('## Why\nengineering needs filed issues');
    expect(payload.body).toContain('- [ ] issues are filed\n- [ ] bundle is attached');
    expect(payload.body).toContain('## Stories (build order)\n- Story A\n- Story B');

    const whyIndex = payload.body.indexOf('## Why');
    const doneWhenIndex = payload.body.indexOf('## Done when');
    const storiesIndex = payload.body.indexOf('## Stories (build order)');
    expect(whyIndex).toBeLessThan(doneWhenIndex);
    expect(doneWhenIndex).toBeLessThan(storiesIndex);
  });

  it('omits "What already exists" when unset', () => {
    const payload = renderEpicIssue(EPIC);
    expect(payload.body).not.toContain('What already exists');
  });

  it('includes "What already exists" only when set', () => {
    const payload = renderEpicIssue({ ...EPIC, whatAlreadyExists: 'a stub module' });
    expect(payload.body).toContain('## What already exists\na stub module');
  });

  it('omits "Traces to" when tracesTo is empty', () => {
    const payload = renderEpicIssue(EPIC);
    expect(payload.body).not.toContain('Traces to');
  });

  it('includes "Traces to" only when tracesTo is non-empty', () => {
    const payload = renderEpicIssue({ ...EPIC, tracesTo: ['INT-PROBLEM-01'] });
    expect(payload.body).toContain('Traces to: INT-PROBLEM-01');
  });
});

describe('renderStoryIssue', () => {
  it('has no "Part of" line without an epic number', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).not.toContain('Part of #');
  });

  it('prepends "Part of #<n>" as the first line when an epic number is passed', () => {
    const payload = renderStoryIssue(buildStory(), 7);
    expect(payload.body.startsWith('Part of #7\n')).toBe(true);
  });

  it('passes through title and labels', () => {
    const story = buildStory();
    const payload = renderStoryIssue(story);
    expect(payload.title).toBe(story.title);
    expect(payload.labels).toBe(story.labels);
  });

  it('renders the "As a ... I want ... so that" sentence', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).toContain('As a engineer, I want a filed issue, so that I can start work');
  });

  it('renders a gherkin fence with Scenario/Given/When/Then in order', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).toContain(
      [
        '```gherkin',
        'Scenario: issue is filed',
        '  Given an approved plan',
        '  When export runs',
        '  Then the issue exists',
        '```',
      ].join('\n'),
    );
  });

  it('omits the Given line when given is empty', () => {
    const story = buildStory({
      acceptanceCriteria: [{ name: 'no givens', given: [], when: ['x'], then: ['y'], tracesTo: [] }],
    });
    const payload = renderStoryIssue(story);
    expect(payload.body).not.toContain('Given');
    expect(payload.body).toContain('```gherkin\nScenario: no givens\n  When x\n  Then y\n```');
  });

  it('renders And lines for additional given/when/then entries', () => {
    const story = buildStory({
      acceptanceCriteria: [
        {
          name: 'multi',
          given: ['g1', 'g2'],
          when: ['w1', 'w2'],
          then: ['t1', 't2'],
          tracesTo: [],
        },
      ],
    });
    const payload = renderStoryIssue(story);
    expect(payload.body).toContain('  Given g1\n  And g2\n  When w1\n  And w2\n  Then t1\n  And t2');
  });

  it('appends a Traces to line per criterion only when non-empty', () => {
    const story = buildStory({
      acceptanceCriteria: [
        { name: 'traced', given: [], when: ['w'], then: ['t'], tracesTo: ['INT-SCOPE-01'] },
        { name: 'untraced', given: [], when: ['w'], then: ['t'], tracesTo: [] },
      ],
    });
    const payload = renderStoryIssue(story);
    expect(payload.body).toContain('Traces to: INT-SCOPE-01');
    const untracedIndex = payload.body.indexOf('Scenario: untraced');
    const restOfBody = payload.body.slice(untracedIndex);
    expect(restOfBody.split('```gherkin')).toHaveLength(1);
  });

  it('renders verification bullets', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).toContain('## Verification\n- npm test — passes when: green');
  });

  it('renders the INVEST note only when set', () => {
    const withNote = renderStoryIssue(buildStory({ investNote: 'small' }));
    expect(withNote.body).toContain('INVEST: small');

    const { investNote: _omit, ...rest } = buildStory();
    const withoutNote = renderStoryIssue(rest as Story);
    expect(withoutNote.body).not.toContain('INVEST:');
  });

  it('renders the story-level Traces to line only when non-empty', () => {
    const withTrace = renderStoryIssue(buildStory({ tracesTo: ['INT-SCOPE-01'] }));
    expect(withTrace.body).toContain('Traces to: INT-SCOPE-01');

    const withoutTrace = renderStoryIssue(buildStory({ tracesTo: [] }));
    expect(withoutTrace.body.trim().endsWith('Traces to:')).toBe(false);
  });

  it('omits the "## Out of scope" section when outOfScope is empty', () => {
    const payload = renderStoryIssue(buildStory({ outOfScope: [] }));
    expect(payload.body).not.toContain('Out of scope');
  });

  it('renders the "## Out of scope" bullets when present', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).toContain('## Out of scope\n- program design');
  });

  it('renders the "## In scope" bullets', () => {
    const payload = renderStoryIssue(buildStory());
    expect(payload.body).toContain('## In scope\n- file the issue');
  });
});
