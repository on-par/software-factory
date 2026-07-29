// packages/product/src/architecture/context.test.ts (#479).
import { CONTRACTS_SCHEMA_VERSION, type Epic, type Story } from '@on-par/contracts';
import { createInMemoryReader } from '@on-par/repo-context';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import { buildDesignContext, renderActiveDecisions } from './context.js';
import { designEpicArchitecture } from './design.js';

function adr(number: string, title: string, status: string, decision = 'Decision text.'): string {
  return `# ADR-${number}: ${title}

- Status: ${status}
- Date: 2026-07-20

## Context

Context text.

## Decision

${decision}

## Consequences

Consequences text.
`;
}

const APPROVED_DOC: IntentDoc = {
  brainDump: 'brain dump',
  statements: [
    { id: 'INT-PROBLEM-01', dimension: 'problem', text: 'p', source: 'answer' },
    { id: 'INT-AUDIENCE-01', dimension: 'audience', text: 'a', source: 'answer' },
    { id: 'INT-OUTCOME-01', dimension: 'outcome', text: 'o', source: 'answer' },
    { id: 'INT-SCOPE-01', dimension: 'scope', text: 's', source: 'answer' },
  ],
  gaps: [],
  status: 'approved',
  approvedBy: 'Pat',
};

function buildStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'A story',
    role: 'user',
    want: 'a thing',
    soThat: 'value happens',
    problemStatement: 'p',
    inScope: ['s'],
    outOfScope: [],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: ['INT-SCOPE-01'] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01', 'INT-OUTCOME-01'],
    ...overrides,
  };
}

function buildEpic(children: string[], overrides: Partial<Epic> = {}): Epic {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'epic',
    title: 'Add widget support',
    why: 'users need widgets',
    doneWhen: ['widgets ship'],
    children,
    labels: [],
    tracesTo: [],
    ...overrides,
  };
}

describe('buildDesignContext', () => {
  it('composes accepted ADRs and the repo survey (Gherkin acceptance)', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-first.md': adr('0001', 'First decision', 'Accepted', 'Do the first thing.'),
      'docs/adr/0002-superseded.md': adr('0002', 'Superseded decision', 'Superseded by ADR-0003'),
      'docs/adr/0003-rejected.md': adr('0003', 'Rejected decision', 'Rejected'),
      'docs/adr/0004-fourth.md': adr('0004', 'Fourth decision', 'Accepted', 'Do the fourth thing.'),
      'packages/core/src/index.ts': 'export {}',
    });

    const context = await buildDesignContext(reader);
    const lines = renderActiveDecisions(context);

    expect(lines[0]).toBe('## Active decisions');
    expect(lines).toEqual([
      '## Active decisions',
      '- ADR-0001 — First decision',
      '  Decision: Do the first thing.',
      '- ADR-0004 — Fourth decision',
      '  Decision: Do the fourth thing.',
    ]);
    expect(lines.some((line) => line.includes('Superseded decision'))).toBe(false);
    expect(lines.some((line) => line.includes('Rejected decision'))).toBe(false);
  });

  it('returns both halves: sorted accepted-only adrs and the survey', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-first.md': adr('0001', 'First decision', 'Accepted'),
      'packages/core/src/index.ts': 'export {}',
    });

    const context = await buildDesignContext(reader);

    expect(context.adrs).toEqual([
      {
        label: 'ADR-0001',
        number: 1,
        title: 'First decision',
        path: 'docs/adr/0001-first.md',
        decision: 'Decision text.',
      },
    ]);
    expect(context.survey).toEqual({
      components: [{ name: 'core', path: 'packages/core' }],
      hasAdrHome: true,
    });
  });

  it('honors custom adrDir and packagesDir', async () => {
    const reader = createInMemoryReader({
      'custom/decisions/0001-first.md': adr('0001', 'Custom decision', 'Accepted'),
      'libs/widget/index.ts': 'export {}',
    });

    const context = await buildDesignContext(reader, { adrDir: 'custom/decisions', packagesDir: 'libs' });

    expect(context.adrs.map((a) => a.label)).toEqual(['ADR-0001']);
    expect(context.survey.components).toEqual([{ name: 'widget', path: 'libs/widget' }]);
    expect(context.survey.hasAdrHome).toBe(true);
  });
});

describe('renderActiveDecisions', () => {
  it('states no ADR home when the target repo has none', async () => {
    const reader = createInMemoryReader({});

    const context = await buildDesignContext(reader);

    expect(renderActiveDecisions(context)).toEqual([
      '## Active decisions',
      'None — no ADR home found in the target repo.',
    ]);
  });

  it('states no accepted decisions when the ADR home exists but has none accepted', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-superseded.md': adr('0001', 'Superseded decision', 'Superseded by ADR-0002'),
    });

    const context = await buildDesignContext(reader);

    expect(renderActiveDecisions(context)).toEqual([
      '## Active decisions',
      'None — the ADR home has no accepted decisions.',
    ]);
  });

  it('condenses a long decision to 300 chars with an ellipsis and renders a short one verbatim', async () => {
    const longDecision = `line one\n\n  line   two   ${'a'.repeat(310)}`;
    const reader = createInMemoryReader({
      'docs/adr/0001-long.md': adr('0001', 'Long decision', 'Accepted', longDecision),
      'docs/adr/0002-short.md': adr('0002', 'Short decision', 'Accepted', 'Short.'),
    });

    const context = await buildDesignContext(reader);
    const lines = renderActiveDecisions(context);

    const collapsed = longDecision.replace(/\s+/g, ' ').trim();
    expect(lines).toContain(`  Decision: ${collapsed.slice(0, 300)}…`);
    expect(lines).toContain('  Decision: Short.');
  });
});

describe('designEpicArchitecture integration', () => {
  it('wires buildDesignContext straight into designEpicArchitecture as ADR-backed constraints', async () => {
    const reader = createInMemoryReader({
      'docs/adr/0001-widget.md': adr(
        '0001',
        'Widget architecture',
        'Accepted',
        'Widgets are built as packages/widget.',
      ),
      'packages/widget/src/index.ts': 'export {}',
    });

    const context = await buildDesignContext(reader);

    const story = buildStory({
      title: 'Add widget',
      want: 'support widgets in the widget package',
      inScope: ['widget UI'],
      verification: [{ command: 'npm test', passWhen: 'widgets work' }],
    });
    const decomposition: Decomposition = { epic: buildEpic([story.title]), stories: [story] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.constraints[0]).toEqual({
      text: 'ADR-0001 — Widget architecture: Widgets are built as packages/widget.',
      adr: 'ADR-0001',
    });
  });
});
