// packages/cli/src/cli/ready-check.ts — read-only `factory check <issue>` report (#1729)
import {
  findIssueDependencies,
  gradeIssueCriteria,
  gradeIssueInvest,
  scoreIssueReadiness,
  type CriteriaReport,
  type IssueDependencyState,
  type IssueInvestReport,
  type ReadinessInfo,
  type ReadinessTemplate,
} from '@on-par/factory-core';

export type IssueSizeVerdict = 'runs-as-is' | 'would-split';

export interface IssueCheckReport {
  issue: number;
  template: ReadinessTemplate;
  /** 0..100, rounded. */
  score: number;
  fields: { pass: boolean; missing: string[] };
  /** Per-criterion findings for factory-task issues; null for epic/factory-bug. */
  criteria: CriteriaReport | null;
  size: { verdict: IssueSizeVerdict; reason?: string };
  /** Advisory INVEST findings for factory-task issues; null for epic/factory-bug. Never affects exitCode. */
  invest: IssueInvestReport | null;
  /** Human-readable reasons the issue is not ready / would split; empty when exitCode is 0. */
  reasons: string[];
  exitCode: 0 | 1 | 3;
}

export interface IssueCheckDeps {
  /** Read-only issue fetch — the only GitHub access this command has. */
  getIssue(issue: number): Promise<{ title: string; body: string | null }>;
  /** Read-only state lookup for dependencies cited in the issue body. */
  getIssueState?(issue: number): Promise<'open' | 'closed'>;
  log(line: string): void;
}

export function buildIssueCheckReport(
  issue: number,
  readiness: ReadinessInfo,
  criteria: CriteriaReport | null = null,
  invest: IssueInvestReport | null = null,
): IssueCheckReport {
  const wouldSplit = readiness.sizeOk === false;
  const size: IssueCheckReport['size'] = wouldSplit
    ? { verdict: 'would-split', reason: readiness.sizeReason ?? 'too big' }
    : { verdict: 'runs-as-is' };
  const notReady = !readiness.pass || (criteria !== null && !criteria.pass);
  const reasons = readiness.missing.map((field) => `missing: ${field}`);
  reasons.push(...(criteria?.problems ?? []));
  if (size.reason) reasons.push(size.reason);
  return {
    issue,
    template: readiness.template,
    score: Math.round(readiness.score * 100),
    fields: { pass: readiness.pass, missing: [...readiness.missing] },
    criteria,
    size,
    invest,
    reasons,
    exitCode: notReady ? 1 : wouldSplit ? 3 : 0,
  };
}

export function formatIssueCheckLines(report: IssueCheckReport): string[] {
  const lines: string[] = [];
  const state = report.exitCode === 1 ? 'is not factory-ready' : 'is factory-ready';
  lines.push(`issue #${report.issue} ${state} (${report.template}, score ${report.score}%)`);
  for (const field of report.fields.missing) lines.push(`  missing: ${field}`);
  if (report.criteria) {
    lines.push('criteria:');
    for (const f of report.criteria.findings) {
      lines.push(`  ${f.index}. ${f.grade}${f.text ? ` — ${f.text}` : ''}${f.note ? ` (${f.note})` : ''}`);
    }
    for (const problem of report.criteria.problems) {
      if (!/^criterion \d+ is empty$/.test(problem)) lines.push(`  ${problem}`);
    }
  }
  lines.push(report.size.verdict === 'would-split' ? `size: would split — ${report.size.reason}` : 'size: runs as-is');
  if (report.invest) {
    lines.push('invest:');
    for (const f of report.invest.findings) lines.push(`  ${f.letter}: ${f.status} — ${f.reason}`);
  }
  return lines;
}

export async function runIssueCheck(
  issue: number,
  opts: { json?: boolean },
  deps: IssueCheckDeps,
): Promise<IssueCheckReport> {
  const { title, body } = await deps.getIssue(issue);
  const readiness = scoreIssueReadiness({ title, body: body ?? '' });
  const criteria = readiness.template === 'factory-task' ? gradeIssueCriteria(body ?? '') : null;
  let invest: IssueInvestReport | null = null;
  if (readiness.template === 'factory-task') {
    const states = new Map<number, IssueDependencyState>();
    await Promise.all(
      findIssueDependencies(body ?? '').map(async (n) => {
        let state: IssueDependencyState = 'unknown';
        try {
          if (deps.getIssueState) state = await deps.getIssueState(n);
        } catch {
          // a failed lookup is advisory only — leave the dependency 'unknown'
        }
        states.set(n, state);
      }),
    );
    invest = gradeIssueInvest(body ?? '', states);
  }
  const report = buildIssueCheckReport(issue, readiness, criteria, invest);
  if (opts.json) {
    deps.log(JSON.stringify(report));
  } else {
    for (const line of formatIssueCheckLines(report)) deps.log(line);
  }
  return report;
}
