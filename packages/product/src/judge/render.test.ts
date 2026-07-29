// packages/product/src/judge/render.test.ts (#474).

import { CONTRACTS_SCHEMA_VERSION, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { JudgedStory, JudgeReport } from './loop.js';
import { renderJudgeReport } from './render.js';

function buildStory(title: string): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title,
    role: 'user',
    want: 'a thing',
    soThat: 'value happens',
    problemStatement: 'p',
    inScope: ['s'],
    outOfScope: ['n'],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: [] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: [],
  };
}

describe('renderJudgeReport', () => {
  it('renders "All stories passed." with no Failed checks block when every story passed', () => {
    const judged: JudgedStory = {
      story: buildStory('Story A'),
      verdict: {
        score: 100,
        rationale: 'All 6 checks passed.',
        checks: [{ id: 'traces-resolve', label: 'Traces resolve', passed: true, note: 'ok' }],
      },
      iterations: 0,
      stopReason: 'passed',
      scoreHistory: [100],
    };
    const report: JudgeReport = { stories: [judged], threshold: 80, maxIterations: 3, allPassed: true };

    const lines = renderJudgeReport(report);

    expect(lines[0]).toBe('# Judge Report');
    expect(lines).toContain('Threshold: 80 · Max rework iterations: 3');
    expect(lines).toContain('All stories passed.');
    expect(lines).toContain('## Story 1: Story A — 100/100 (passed)');
    expect(lines).toContain('Stop reason: passed');
    expect(lines).toContain('Score history: 100');
    expect(lines).toContain('Rationale: All 6 checks passed.');
    expect(lines).not.toContain('Failed checks:');
  });

  it('renders score, stop reason, score history, rationale, and failed checks for a below-threshold story', () => {
    const judged: JudgedStory = {
      story: buildStory('Story B'),
      verdict: {
        score: 67,
        rationale: 'unresolved trace ids: INT-SCOPE-99',
        checks: [
          { id: 'traces-resolve', label: 'Traces resolve', passed: false, note: 'unresolved trace ids: INT-SCOPE-99' },
        ],
      },
      iterations: 1,
      stopReason: 'no-improvement',
      scoreHistory: [67, 67],
    };
    const report: JudgeReport = { stories: [judged], threshold: 80, maxIterations: 3, allPassed: false };

    const lines = renderJudgeReport(report);

    expect(lines).toContain('1 of 1 stories below threshold.');
    expect(lines).toContain('## Story 1: Story B — 67/100 (below threshold)');
    expect(lines).toContain('Stop reason: no-improvement after 1 rework iteration(s)');
    expect(lines).toContain('Score history: 67 → 67');
    expect(lines).toContain('Rationale: unresolved trace ids: INT-SCOPE-99');
    expect(lines).toContain('Failed checks:');
    expect(lines).toContain('- traces-resolve: unresolved trace ids: INT-SCOPE-99');
  });

  it('renders a max-iterations stop reason line', () => {
    const judged: JudgedStory = {
      story: buildStory('Story C'),
      verdict: { score: 40, rationale: 'r', checks: [] },
      iterations: 3,
      stopReason: 'max-iterations',
      scoreHistory: [10, 20, 30, 40],
    };
    const report: JudgeReport = { stories: [judged], threshold: 90, maxIterations: 3, allPassed: false };

    const lines = renderJudgeReport(report);

    expect(lines).toContain('Stop reason: max-iterations after 3 rework iteration(s)');
    expect(lines).toContain('Score history: 10 → 20 → 30 → 40');
  });

  it('reports the count of below-threshold stories out of the total', () => {
    const passed: JudgedStory = {
      story: buildStory('Story A'),
      verdict: { score: 100, rationale: 'All 1 checks passed.', checks: [] },
      iterations: 0,
      stopReason: 'passed',
      scoreHistory: [100],
    };
    const failed: JudgedStory = {
      story: buildStory('Story B'),
      verdict: { score: 40, rationale: 'r', checks: [] },
      iterations: 3,
      stopReason: 'max-iterations',
      scoreHistory: [10, 20, 30, 40],
    };
    const report: JudgeReport = { stories: [passed, failed], threshold: 90, maxIterations: 3, allPassed: false };

    const lines = renderJudgeReport(report);

    expect(lines).toContain('1 of 2 stories below threshold.');
  });
});
