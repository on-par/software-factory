export type LocalSmallRuntime = 'local-small' | 'workhorse' | (string & {});

export interface LocalSmallScoreboardRun {
  scenario: string;
  runtime: LocalSmallRuntime;
  model: string;
  harness: string;
  patchApplied: boolean;
  testsPassed: boolean;
  diffSize: number;
  repairCount: number;
  durationMs: number;
  reviewerGrade: number;
}

export interface LocalSmallScoreboardInput {
  runs: LocalSmallScoreboardRun[];
  baseline?: {
    runs: LocalSmallScoreboardRun[];
  };
}

export interface LocalSmallScoreboardRow extends LocalSmallScoreboardRun {
  passed: boolean;
}

export interface LocalSmallScoreboardReport {
  rows: LocalSmallScoreboardRow[];
  regressions: string[];
}

export function buildLocalSmallScoreboard(input: LocalSmallScoreboardInput): LocalSmallScoreboardReport {
  const baseline = new Map((input.baseline?.runs ?? []).map((run) => [scoreboardKey(run), run]));
  const rows = input.runs.map((run) => ({
    ...run,
    passed: run.patchApplied && run.testsPassed && run.reviewerGrade >= 7,
  }));
  return {
    rows,
    regressions: rows.flatMap((row) => regressionsFor(row, baseline.get(scoreboardKey(row)))),
  };
}

export function renderLocalSmallScoreboardMarkdown(report: LocalSmallScoreboardReport): string {
  const lines = [
    '# Local-small eval scoreboard',
    '',
    '| Scenario | Runtime | Model | Harness | Patch | Tests | Diff | Repairs | Duration | Grade |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...report.rows
      .map((row) =>
        [
          row.scenario,
          row.runtime,
          row.model,
          row.harness,
          row.patchApplied ? 'yes' : 'no',
          row.testsPassed ? 'yes' : 'no',
          String(row.diffSize),
          String(row.repairCount),
          `${(row.durationMs / 1000).toFixed(2)}s`,
          String(row.reviewerGrade),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
    '## Regressions',
    report.regressions.length > 0
      ? report.regressions.map((regression) => `- ${regression}`).join('\n')
      : 'No regressions against baseline.',
    '',
  ];
  return lines.join('\n');
}

function regressionsFor(current: LocalSmallScoreboardRun, baseline?: LocalSmallScoreboardRun): string[] {
  if (!baseline) return [];
  const prefix = scoreboardKey(current);
  const regressions: string[] = [];
  if (baseline.patchApplied && !current.patchApplied) {
    regressions.push(`${prefix}: patch-applied regressed from true to false`);
  }
  if (baseline.testsPassed && !current.testsPassed) {
    regressions.push(`${prefix}: tests-passed regressed from true to false`);
  }
  if (current.diffSize > baseline.diffSize) {
    regressions.push(`${prefix}: diff-size grew from ${baseline.diffSize} to ${current.diffSize}`);
  }
  if (current.repairCount > baseline.repairCount) {
    regressions.push(`${prefix}: repair-count grew from ${baseline.repairCount} to ${current.repairCount}`);
  }
  if (current.durationMs > baseline.durationMs * 1.5) {
    regressions.push(`${prefix}: duration grew from ${baseline.durationMs}ms to ${current.durationMs}ms`);
  }
  if (current.reviewerGrade < baseline.reviewerGrade) {
    regressions.push(`${prefix}: reviewer-grade fell from ${baseline.reviewerGrade} to ${current.reviewerGrade}`);
  }
  return regressions;
}

function scoreboardKey(run: Pick<LocalSmallScoreboardRun, 'scenario' | 'runtime' | 'model' | 'harness'>): string {
  return `${run.scenario} / ${run.runtime} / ${run.model} / ${run.harness}`;
}
