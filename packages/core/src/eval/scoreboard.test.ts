import { describe, expect, it } from 'vitest';
import { buildLocalSmallScoreboard, renderLocalSmallScoreboardMarkdown } from './scoreboard.js';

describe('local-small eval scoreboard', () => {
  it('calculates rows and regressions against a baseline', () => {
    const report = buildLocalSmallScoreboard({
      runs: [
        {
          scenario: 'local-small-first-green',
          runtime: 'local-small',
          model: 'qwen2.5-coder:7b',
          harness: 'ollama-agentic',
          patchApplied: true,
          testsPassed: false,
          diffSize: 8,
          repairCount: 2,
          durationMs: 2500,
          reviewerGrade: 7,
        },
        {
          scenario: 'local-small-first-green',
          runtime: 'workhorse',
          model: 'claude-sonnet-5',
          harness: 'codex-cli',
          patchApplied: true,
          testsPassed: true,
          diffSize: 6,
          repairCount: 0,
          durationMs: 1200,
          reviewerGrade: 9,
        },
      ],
      baseline: {
        runs: [
          {
            scenario: 'local-small-first-green',
            runtime: 'local-small',
            model: 'qwen2.5-coder:7b',
            harness: 'ollama-agentic',
            patchApplied: true,
            testsPassed: true,
            diffSize: 4,
            repairCount: 1,
            durationMs: 1000,
            reviewerGrade: 8,
          },
        ],
      },
    });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      scenario: 'local-small-first-green',
      runtime: 'local-small',
      model: 'qwen2.5-coder:7b',
      harness: 'ollama-agentic',
      patchApplied: true,
      testsPassed: false,
      diffSize: 8,
      repairCount: 2,
      durationMs: 2500,
      reviewerGrade: 7,
      passed: false,
    });
    expect(report.regressions).toEqual([
      'local-small-first-green / local-small / qwen2.5-coder:7b / ollama-agentic: tests-passed regressed from true to false',
      'local-small-first-green / local-small / qwen2.5-coder:7b / ollama-agentic: diff-size grew from 4 to 8',
      'local-small-first-green / local-small / qwen2.5-coder:7b / ollama-agentic: repair-count grew from 1 to 2',
      'local-small-first-green / local-small / qwen2.5-coder:7b / ollama-agentic: duration grew from 1000ms to 2500ms',
      'local-small-first-green / local-small / qwen2.5-coder:7b / ollama-agentic: reviewer-grade fell from 8 to 7',
    ]);
  });

  it('renders a Markdown scoreboard table', () => {
    const report = buildLocalSmallScoreboard({
      runs: [
        {
          scenario: 'local-small-first-green',
          runtime: 'local-small',
          model: 'qwen2.5-coder:7b',
          harness: 'ollama-agentic',
          patchApplied: true,
          testsPassed: true,
          diffSize: 5,
          repairCount: 0,
          durationMs: 900,
          reviewerGrade: 9,
        },
      ],
    });

    const markdown = renderLocalSmallScoreboardMarkdown(report);

    expect(markdown).toContain('| Scenario | Runtime | Model | Harness | Patch | Tests | Diff | Repairs | Duration | Grade |');
    expect(markdown).toContain('| local-small-first-green | local-small | qwen2.5-coder:7b | ollama-agentic | yes | yes | 5 | 0 | 0.90s | 9 |');
    expect(markdown).toContain('No regressions against baseline.');
  });
});
