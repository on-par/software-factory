// packages/product/src/persona/render.test.ts (#473).

import { describe, expect, it } from 'vitest';

import type { PersonaFinding } from './findings.js';
import type { PersonaPanelReport } from './panel.js';
import { renderPersonaPanel } from './render.js';

const QUESTION_FINDING: PersonaFinding = {
  persona: 'eng',
  kind: 'assumption',
  subject: 'Build the retry button',
  observation: 'no repo context is attached',
  action: { kind: 'question', text: 'Which files or modules does this touch?' },
  tracesTo: ['INT-SCOPE-01'],
};

const CRITERION_FINDING: PersonaFinding = {
  persona: 'support',
  kind: 'gap',
  subject: 'Build the retry button',
  observation: 'only describes the happy path',
  action: {
    kind: 'criterion',
    criterion: {
      name: 'Support: Build the retry button fails visibly',
      given: ['a user using the retry button'],
      when: ['the operation fails'],
      then: ['the user sees an actionable error', 'support can find the failure in the event log'],
      tracesTo: ['INT-SCOPE-01'],
    },
  },
  tracesTo: ['INT-SCOPE-01'],
};

const CRITERION_FINDING_NO_GIVEN: PersonaFinding = {
  persona: 'ops',
  kind: 'risk',
  subject: 'Build the retry button',
  observation: 'has no rollout, flag, or rollback story',
  action: {
    kind: 'criterion',
    criterion: {
      name: 'Ops: Build the retry button can be turned off',
      given: [],
      when: ['it misbehaves in production'],
      then: ['it can be disabled without a deploy'],
      tracesTo: ['INT-SCOPE-01'],
    },
  },
  tracesTo: ['INT-SCOPE-01'],
};

describe('renderPersonaPanel', () => {
  it('renders the clean message for an empty report', () => {
    const lines = renderPersonaPanel({ findings: [], personas: [], clean: true });
    expect(lines).toContain('No findings — every persona is satisfied.');
    expect(lines.join('\n')).not.toContain('Findings:');
  });

  it('renders a header naming the finding count and persona ids', () => {
    const report: PersonaPanelReport = { findings: [QUESTION_FINDING], personas: ['eng'], clean: false };
    const lines = renderPersonaPanel(report);
    expect(lines).toContain('Findings: 1 from eng');
  });

  it('groups findings under a heading naming the persona label and concern', () => {
    const report: PersonaPanelReport = { findings: [QUESTION_FINDING], personas: ['eng'], clean: false };
    const lines = renderPersonaPanel(report);
    expect(lines.some((l) => l.startsWith('## Engineering — '))).toBe(true);
  });

  it('renders an Ask line for a question finding', () => {
    const report: PersonaPanelReport = { findings: [QUESTION_FINDING], personas: ['eng'], clean: false };
    const lines = renderPersonaPanel(report);
    expect(lines).toContain('  Ask: Which files or modules does this touch?');
  });

  it('renders Propose criterion and Given/When/Then lines for a criterion finding', () => {
    const report: PersonaPanelReport = { findings: [CRITERION_FINDING], personas: ['support'], clean: false };
    const lines = renderPersonaPanel(report);
    expect(lines).toContain('  Propose criterion: Support: Build the retry button fails visibly');
    expect(lines).toContain('    Given a user using the retry button');
    expect(lines).toContain('    When the operation fails');
    expect(lines).toContain(
      '    Then the user sees an actionable error, support can find the failure in the event log',
    );
  });

  it('omits the Given line when given is empty', () => {
    const report: PersonaPanelReport = { findings: [CRITERION_FINDING_NO_GIVEN], personas: ['ops'], clean: false };
    const lines = renderPersonaPanel(report);
    expect(lines.some((l) => l.trim().startsWith('Given '))).toBe(false);
  });
});
