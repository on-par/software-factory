// packages/product/src/intent/render.test.ts (#471).

import { describe, expect, it } from 'vitest';

import type { IntentDoc } from './intent-doc.js';
import { renderIntentDoc } from './render.js';

describe('renderIntentDoc', () => {
  it('renders a draft doc with gaps: header, counts naming the gaps, and a section per non-empty dimension', () => {
    const doc: IntentDoc = {
      brainDump: 'x',
      statements: [{ id: 'INT-PROBLEM-01', dimension: 'problem', text: 'the export breaks weekly', source: 'answer' }],
      gaps: ['nonGoals', 'constraints'],
      status: 'draft',
    };

    expect(renderIntentDoc(doc)).toEqual([
      '# Intent Doc',
      'Status: draft',
      'Statements: 1; open gaps: nonGoals, constraints',
      '',
      '## Problem',
      '- INT-PROBLEM-01 — the export breaks weekly',
    ]);
  });

  it('renders Approved by immediately after Status: approved, and open gaps: (none)', () => {
    const doc: IntentDoc = {
      brainDump: 'x',
      statements: [{ id: 'INT-PROBLEM-01', dimension: 'problem', text: 'text', source: 'answer' }],
      gaps: [],
      status: 'approved',
      approvedBy: 'Pat',
    };

    const lines = renderIntentDoc(doc);
    expect(lines[0]).toBe('# Intent Doc');
    expect(lines[1]).toBe('Status: approved');
    expect(lines[2]).toBe('Approved by: Pat');
    expect(lines[3]).toBe('Statements: 1; open gaps: (none)');
  });

  it('renders only the header lines for a doc with no statements', () => {
    const doc: IntentDoc = { brainDump: 'x', statements: [], gaps: [], status: 'draft' };

    expect(renderIntentDoc(doc)).toEqual(['# Intent Doc', 'Status: draft', 'Statements: 0; open gaps: (none)']);
  });
});
