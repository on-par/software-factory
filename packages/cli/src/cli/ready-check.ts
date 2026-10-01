// packages/cli/src/cli/ready-check.ts — read-only `factory check <issue>` report (#1729)
import {
  findIssueDependencies,
  formatCostTotal,
  gradeIssueCriteria,
  gradeIssueInvest,
  scoreIssueReadiness,
  type CriteriaReport,
  type IssueDependencyState,
  type IssueInvestReport,
  type ReadinessInfo,
  type ReadinessTemplate,
} from '@on-par/factory-core';
import {
  buildDecompositionPrompt,
  buildReadinessGapPrompt,
  parseDecompositionOutput,
  parseReadinessGapOutput,
  type ReadinessGapReport,
} from '@on-par/factory-core/internal';

export type IssueSizeVerdict = 'runs-as-is' | 'would-split';

export type DeepCheckTask = 'decompose' | 'triage';
export type DeepCheckModelRunner = (
  task: DeepCheckTask,
  prompt: string,
) => Promise<{ model: string; output: string; cost: number | null }>;
/** Proposed child story; acceptance criteria are already formatted via formatGapCriterion. */
export interface DeepSplitChild {
  title: string;
  acceptanceCriteria: string[];
}
export type IssueDeepCheck =
  | { kind: 'split'; model: string; cost: number | null; unpriced: boolean; children: DeepSplitChild[] }
  | { kind: 'gaps'; model: string; cost: number | null; unpriced: boolean; gaps: ReadinessGapReport };

export class DeepCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepCheckError';
  }
}

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
  /** Present only when `--deep` was requested. */
  deep?: IssueDeepCheck;
}

export interface IssueCheckDeps {
  /** Read-only issue fetch — the only GitHub access this command has. */
  getIssue(issue: number): Promise<{ title: string; body: string | null }>;
  /** Read-only state lookup for dependencies cited in the issue body. */
  getIssueState?(issue: number): Promise<'open' | 'closed'>;
  /** Single model call for `--deep`; absent otherwise. */
  runModel?: DeepCheckModelRunner;
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

export function formatGapCriterion(c: { name: string; when: readonly string[]; then: readonly string[] }): string {
  return `${c.name} (When: ${c.when.join('; ')} — Then: ${c.then.join('; ')})`;
}

export async function runDeepCheck(
  input: { title: string; body: string; wouldSplit: boolean },
  runModel: DeepCheckModelRunner,
): Promise<IssueDeepCheck> {
  const task: DeepCheckTask = input.wouldSplit ? 'decompose' : 'triage';
  const prompt = input.wouldSplit
    ? buildDecompositionPrompt({ title: input.title, body: input.body })
    : buildReadinessGapPrompt({ title: input.title, body: input.body });
  let result: { model: string; output: string; cost: number | null };
  try {
    result = await runModel(task, prompt);
  } catch (err) {
    throw new DeepCheckError(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const unpriced = result.cost === null;
  if (input.wouldSplit) {
    const parsed = parseDecompositionOutput(result.output);
    if (!parsed.ok) throw new DeepCheckError(`model returned invalid output: ${parsed.reason}`);
    const children = parsed.decomposition.stories.map((s) => ({
      title: s.title,
      acceptanceCriteria: s.acceptanceCriteria.map(formatGapCriterion),
    }));
    return { kind: 'split', model: result.model, cost: result.cost, unpriced, children };
  }
  const parsed = parseReadinessGapOutput(result.output);
  if (!parsed.ok) throw new DeepCheckError(`model returned invalid output: ${parsed.reason}`);
  return { kind: 'gaps', model: result.model, cost: result.cost, unpriced, gaps: parsed.gaps };
}

export function formatDeepCheckLines(deep: IssueDeepCheck): string[] {
  const lines: string[] = [];
  if (deep.kind === 'split') {
    lines.push(`deep: proposed split (preview only — nothing filed), ${deep.children.length} child stories`);
    deep.children.forEach((child, i) => {
      lines.push(`  ${i + 1}. ${child.title}`);
      for (const c of child.acceptanceCriteria) lines.push(`     - ${c}`);
    });
  } else {
    lines.push('deep: suggested missing criteria');
    if (deep.gaps.missingCriteria.length === 0) lines.push('  (none)');
    for (const c of deep.gaps.missingCriteria) lines.push(`  - ${formatGapCriterion(c)}`);
    const sections: Array<[string, string[]]> = [
      ['unclear scope:', deep.gaps.unclearScope],
      ['negotiable:', deep.gaps.negotiable],
      ['estimable:', deep.gaps.estimable],
    ];
    for (const [label, items] of sections) {
      if (items.length === 0) continue;
      lines.push(label);
      for (const item of items) lines.push(`  - ${item}`);
    }
  }
  lines.push(`model: ${deep.model}, cost: ${formatCostTotal(deep.cost, deep.unpriced ? 1 : 0)}`);
  return lines;
}

export async function runIssueCheck(
  issue: number,
  opts: { json?: boolean; deep?: boolean },
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
  if (opts.deep) {
    if (!deps.runModel) throw new DeepCheckError('no model runner configured');
    report.deep = await runDeepCheck(
      { title, body: body ?? '', wouldSplit: report.size.verdict === 'would-split' },
      deps.runModel,
    );
  }
  if (opts.json) {
    deps.log(JSON.stringify(report));
  } else {
    for (const line of formatIssueCheckLines(report)) deps.log(line);
    if (report.deep) for (const line of formatDeepCheckLines(report.deep)) deps.log(line);
  }
  return report;
}
