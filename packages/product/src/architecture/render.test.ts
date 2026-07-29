// packages/product/src/architecture/render.test.ts (#477, #478).
import type { DesignArtifact } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { renderEpicArchitecture } from '../export/index.js';
import type { EpicDesignCritique } from './critic.js';
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

const REWORK_RESULT: EpicDesignCritique = {
  architecture: CRITIQUED_ARCHITECTURE,
  verdict: {
    verdict: 'rework',
    score: 60,
    violatedAdrs: ['ADR-0004'],
    rationale: 'active ADRs missing from the constraints: ADR-0004',
    checks: [
      {
        id: 'adrs-covered',
        label: 'Every active ADR is carried as a constraint',
        passed: false,
        note: 'active ADRs missing from the constraints: ADR-0004',
      },
      {
        id: 'verification-planned',
        label: 'The architecture carries a non-empty verification plan',
        passed: true,
        note: 'the architecture carries a non-empty verification plan',
      },
    ],
  },
  iterations: 1,
  stopReason: 'no-improvement',
  scoreHistory: [60, 60],
};

const PASS_RESULT: EpicDesignCritique = {
  architecture: CRITIQUED_ARCHITECTURE,
  verdict: { verdict: 'pass', score: 100, violatedAdrs: [], rationale: 'All 5 checks passed.', checks: [] },
  iterations: 0,
  stopReason: 'passed',
  scoreHistory: [100],
};

describe('renderCriticReport', () => {
  it('includes the verdict line, violated-ADR line, failed-check bullets, and the score history arrow line on a rework result', () => {
    const lines = renderCriticReport(REWORK_RESULT);

    expect(lines[0]).toBe('# Epic-Design Critique');
    expect(lines).toContain('Verdict: rework — 60/100');
    expect(lines).toContain('Stop reason: no-improvement after 1 rework iteration(s)');
    expect(lines).toContain('Score history: 60 → 60');
    expect(lines).toContain('Rationale: active ADRs missing from the constraints: ADR-0004');
    expect(lines).toContain('Violated ADRs: ADR-0004');
    expect(lines).toContain('Failed checks:');
    expect(lines).toContain('- adrs-covered: active ADRs missing from the constraints: ADR-0004');
  });

  it('reports Stop reason: passed, Violated ADRs: none, and omits the Failed checks section on a pass result', () => {
    const lines = renderCriticReport(PASS_RESULT);

    expect(lines).toContain('Verdict: pass — 100/100');
    expect(lines).toContain('Stop reason: passed');
    expect(lines).toContain('Score history: 100');
    expect(lines).toContain('Violated ADRs: none');
    expect(lines).not.toContain('Failed checks:');
  });
});
