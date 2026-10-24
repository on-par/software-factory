import type { EnvironmentFailure } from './check.js';
import type { CheckSummary } from '../types/index.js';

/** Full-output log files named by round-1 FAIL results, then the base-run log dir; deduped, first-seen order. */
export function environmentLogPaths(summary: CheckSummary, baseLogDir: string | undefined): string[] {
  const paths: string[] = [];
  for (const r of summary.results.filter((x) => x.result === 'FAIL')) {
    for (const m of r.details.matchAll(/^full output: (.+)$/gm)) paths.push(m[1]);
  }
  if (baseLogDir !== undefined) paths.push(baseLogDir);
  return [...new Set(paths)];
}

export function renderEnvironmentReleaseComment(failure: EnvironmentFailure): string {
  return [
    '### Factory: CHECK failure caused by the base, not this issue',
    '',
    `Every failing checker also fails on base \`${failure.baseSha}\`, so no rework was run. This issue was released back to \`factory:queued\` and the lane is paused until the base is fixed.`,
    '',
    'Failing checkers:',
    ...failure.failingChecks.map((c) => `- \`${c}\``),
    '',
    `Base SHA: \`${failure.baseSha}\``,
    '',
    ...(failure.logPaths.length > 0
      ? ['Logs:', ...failure.logPaths.map((p) => `- \`${p}\``)]
      : ['No log paths were recorded (logsDir not set).']),
    '',
  ].join('\n');
}
