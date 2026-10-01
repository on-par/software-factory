// packages/cli/src/cli/ready-check.ts — read-only `factory check <issue>` report (#1729)
import { scoreIssueReadiness, type ReadinessInfo, type ReadinessTemplate } from '@on-par/factory-core';

export type IssueSizeVerdict = 'runs-as-is' | 'would-split';

export interface IssueCheckReport {
  issue: number;
  template: ReadinessTemplate;
  /** 0..100, rounded. */
  score: number;
  fields: { pass: boolean; missing: string[] };
  size: { verdict: IssueSizeVerdict; reason?: string };
  /** Human-readable reasons the issue is not ready / would split; empty when exitCode is 0. */
  reasons: string[];
  exitCode: 0 | 1 | 3;
}

export interface IssueCheckDeps {
  /** Read-only issue fetch — the only GitHub access this command has. */
  getIssue(issue: number): Promise<{ title: string; body: string | null }>;
  log(line: string): void;
}

export function buildIssueCheckReport(issue: number, readiness: ReadinessInfo): IssueCheckReport {
  const wouldSplit = readiness.sizeOk === false;
  const size: IssueCheckReport['size'] = wouldSplit
    ? { verdict: 'would-split', reason: readiness.sizeReason ?? 'too big' }
    : { verdict: 'runs-as-is' };
  const reasons = readiness.missing.map((field) => `missing: ${field}`);
  if (size.reason) reasons.push(size.reason);
  return {
    issue,
    template: readiness.template,
    score: Math.round(readiness.score * 100),
    fields: { pass: readiness.pass, missing: [...readiness.missing] },
    size,
    reasons,
    exitCode: !readiness.pass ? 1 : wouldSplit ? 3 : 0,
  };
}

export function formatIssueCheckLines(report: IssueCheckReport): string[] {
  const lines: string[] = [];
  const state = report.fields.pass ? 'is factory-ready' : 'is not factory-ready';
  lines.push(`issue #${report.issue} ${state} (${report.template}, score ${report.score}%)`);
  for (const field of report.fields.missing) lines.push(`  missing: ${field}`);
  lines.push(report.size.verdict === 'would-split' ? `size: would split — ${report.size.reason}` : 'size: runs as-is');
  return lines;
}

export async function runIssueCheck(
  issue: number,
  opts: { json?: boolean },
  deps: IssueCheckDeps,
): Promise<IssueCheckReport> {
  const { title, body } = await deps.getIssue(issue);
  const report = buildIssueCheckReport(issue, scoreIssueReadiness({ title, body: body ?? '' }));
  if (opts.json) {
    deps.log(JSON.stringify(report));
  } else {
    for (const line of formatIssueCheckLines(report)) deps.log(line);
  }
  return report;
}
