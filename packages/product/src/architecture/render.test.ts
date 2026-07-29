// packages/product/src/architecture/render.test.ts (#477).
import type { DesignArtifact } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { renderEpicArchitecture } from '../export/index.js';
import type { EpicArchitecture } from './design.js';
import { renderArchitectureReport } from './render.js';

const ARTIFACT: DesignArtifact = {
  restatedProblem: 'problem restated',
  approach: { chosen: 'chosen approach', rejected: [] },
  interfacesTouched: ['packages/widget'],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: ['ADR-0001 — Widget architecture: decision text'],
  verificationPlan: [{ command: 'npm test', passWhen: 'green' }],
  riskBlastRadius: 'small',
  openQuestions: ['needs a new ADR: introduce a new component for story "X"'],
};

describe('renderArchitectureReport', () => {
  it('includes the renderEpicArchitecture body, ADR conformance markers, and deviations', () => {
    const architecture: EpicArchitecture = {
      artifact: ARTIFACT,
      constraints: [
        { text: 'ADR-0001 — Widget architecture: decision text', adr: 'ADR-0001' },
        { text: 'introduce a new component for story "X"' },
      ],
      deviations: [{ subject: 'x', text: 'introduce a new component for story "X"' }],
    };

    const lines = renderArchitectureReport(architecture);

    expect(lines.slice(0, renderEpicArchitecture(ARTIFACT).length)).toEqual(renderEpicArchitecture(ARTIFACT));
    expect(lines).toContain('## ADR conformance');
    expect(lines).toContain('- [ADR-0001] ADR-0001 — Widget architecture: decision text');
    expect(lines).toContain('- [needs new ADR] introduce a new component for story "X"');
    expect(lines).toContain('## Deviations (need a new ADR)');
    expect(lines).toContain('- introduce a new component for story "X"');
  });

  it('reports None. when there are no deviations', () => {
    const architecture: EpicArchitecture = {
      artifact: ARTIFACT,
      constraints: [{ text: 'ADR-0001 — Widget architecture: decision text', adr: 'ADR-0001' }],
      deviations: [],
    };

    const lines = renderArchitectureReport(architecture);

    const deviationsIndex = lines.indexOf('## Deviations (need a new ADR)');
    expect(lines[deviationsIndex + 1]).toBe('None.');
  });
});
