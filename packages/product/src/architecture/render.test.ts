// packages/product/src/architecture/render.test.ts (#477, #478).
import type { DesignArtifact } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { renderEpicArchitecture } from '../export/index.js';
import type { CritiquedDesign } from './critic.js';
import type { EpicArchitecture } from './design.js';
import { renderArchitectureReport, renderCriticReport } from './render.js';

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

const CRITIQUED_ARCHITECTURE: EpicArchitecture = {
  artifact: ARTIFACT,
  constraints: [{ text: 'ADR-0001 — Widget architecture: decision text', adr: 'ADR-0001' }],
  deviations: [],
};

const REWORK_RESULT: CritiquedDesign = {
  architecture: CRITIQUED_ARCHITECTURE,
  verdict: {
    verdict: 'rework',
    violatedAdrs: ['ADR-0004'],
    rationale: 'design contradicts active ADR(s) it does not carry as constraints: ADR-0004',
    checks: [
      {
        id: 'adrs-honored',
        label: 'Every active ADR is carried as a constraint',
        passed: false,
        note: 'design contradicts active ADR(s) it does not carry as constraints: ADR-0004',
      },
      {
        id: 'verification-grounded',
        label: 'A non-empty verification plan grounds the design',
        passed: true,
        note: 'the verification plan is non-empty',
      },
    ],
  },
  iterations: 2,
  stopReason: 'no-improvement',
  failedCheckHistory: [2, 1, 1],
};

const PASS_RESULT: CritiquedDesign = {
  architecture: CRITIQUED_ARCHITECTURE,
  verdict: { verdict: 'pass', violatedAdrs: [], rationale: 'All 6 checks passed.', checks: [] },
  iterations: 0,
  stopReason: 'passed',
  failedCheckHistory: [0],
};

describe('renderCriticReport', () => {
  it('includes the verdict line, violated-ADR line, failed-check bullets, and the history arrow line on a rework result', () => {
    const lines = renderCriticReport(REWORK_RESULT);

    expect(lines[0]).toBe('# Epic-Design Critic Report');
    expect(lines).toContain('Verdict: rework');
    expect(lines).toContain('Stop reason: no-improvement after 2 rework iteration(s)');
    expect(lines).toContain('Failed-check history: 2 → 1 → 1');
    expect(lines).toContain('Rationale: design contradicts active ADR(s) it does not carry as constraints: ADR-0004');
    expect(lines).toContain('Violated ADRs: ADR-0004');
    expect(lines).toContain('Failed checks:');
    expect(lines).toContain(
      '- adrs-honored: design contradicts active ADR(s) it does not carry as constraints: ADR-0004',
    );
  });

  it('reports Stop reason: passed and omits the Failed checks section and Violated ADRs line on a pass result', () => {
    const lines = renderCriticReport(PASS_RESULT);

    expect(lines).toContain('Stop reason: passed');
    expect(lines).not.toContain('Failed checks:');
    expect(lines.some((l) => l.startsWith('Violated ADRs:'))).toBe(false);
  });
});
