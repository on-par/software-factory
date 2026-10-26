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
  judgeReadiness,
  parseDecompositionOutput,
  type JudgeReadinessResult,
} from '@on-par/factory-core/internal';

export type IssueSizeVerdict = 'runs-as-is' | 'would-split';

export type DeepCheckTask = 'decompose' | 'readiness_judge' | 'issue_draft';
export type DeepCheckModelRunner = (
  task: DeepCheckTask,
  prompt: string,
) => Promise<{ model: string; output: string; cost: number | null }>;
/** Proposed child story; acceptance criteria are already formatted via formatGapCriterion. */
export interface DeepSplitChild {
  title: string;
  acceptanceCriteria: string[];
}
export interface IssueDeepCheck {
  kind: 'split';
  model: string;
  cost: number | null;
  unpriced: boolean;
  children: DeepSplitChild[];
}

/** Minimal router surface the deep check needs (a ModelRouter satisfies it). */
export interface DeepCheckRouter {
  setCostSink(sink: (entry: { cost: number | null }) => void): void;
  run(
    task: string,
    prompt: string,
    opts: { worktree: string; timeoutSeconds: number },
  ): Promise<{ model: string; output: string }>;
}

/** Backs `--deep` with a router; captures the call's cost without writing costs.jsonl. */
export function createDeepModelRunner(router: DeepCheckRouter, worktree: string): DeepCheckModelRunner {
  let lastCost: number | null = null;
  router.setCostSink((entry) => {
    lastCost = entry.cost;
  });
  return async (task, prompt) => {
    lastCost = null;
    const r = await router.run(task, prompt, { worktree, timeoutSeconds: 600 });
    return { model: r.model, output: r.output, cost: lastCost };
  };
}

export class DeepCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepCheckError';
  }
}

/** The readiness judge failed (model error or unparseable output after one repair); `check` exits 2. */
export class ReadinessJudgeError extends Error {
  constructor(
    readonly errorKind: string,
    detail: string,
  ) {
    super(`readiness judge failed (${errorKind}): ${detail}`);
    this.name = 'ReadinessJudgeError';
  }
}

export type CheckVerdict = 'ready' | 'ready-with-assumptions' | 'not-ready';
export interface CheckVerdictItem {
  aspect: string;
  text: string;
}

export interface IssueCheckReport {
  issue: number;
  schemaVersion: 1;
  /** Model readiness verdict; null with --no-judge or for a skipped epic. */
  verdict: CheckVerdict | null;
  summary: string | null;
  questions: CheckVerdictItem[];
  assumptions: CheckVerdictItem[];
  /** Judge call metadata; null with --no-judge or for a skipped epic. */
  judge: {
    model: string;
    cost: number | null;
    unpriced: boolean;
    cached: boolean;
    promptVersion: string;
    bodyHash: string;
  } | null;
  /** Present only when the issue is an epic, which the judge does not grade. */
  judgeSkipped?: 'epic';
  /** Advisory when the judge ran. */
  template: ReadinessTemplate;
  /** 0..100, rounded. Advisory when the judge ran. */
  score: number;
  /** Advisory when the judge ran. */
  fields: { pass: boolean; missing: string[] };
  /** Per-criterion findings for factory-task issues; null for epic/factory-bug. Advisory when the judge ran. */
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
  getIssue(
    issue: number,
  ): Promise<{ title: string; body: string | null; labels?: ReadonlyArray<string | { name?: string | null }> }>;
  /** Read-only state lookup for dependencies cited in the issue body. */
  getIssueState?(issue: number): Promise<'open' | 'closed'>;
  /** Model calls for the readiness judge and `--deep`; absent with `--no-judge` and no `--deep`. */
  runModel?: DeepCheckModelRunner;
  /** Per-state-root readiness verdict cache directory; no caching when absent. */
  readinessCacheDir?: string;
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
    schemaVersion: 1,
    verdict: null,
    summary: null,
    questions: [],
    assumptions: [],
    judge: null,
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

/** Folds a readiness judge result into the heading-based report; the verdict decides exit 1. */
export function applyJudgeResult(
  report: IssueCheckReport,
  result: JudgeReadinessResult,
  unpriced: boolean,
): IssueCheckReport {
  if (result.kind === 'skipped') return { ...report, judgeSkipped: 'epic' };
  if (result.kind === 'error') throw new ReadinessJudgeError(result.errorKind, result.detail);
  const { verdict } = result;
  const fresh = unpriced && !result.cached;
  const reasons =
    verdict.verdict === 'not-ready' ? verdict.questions.map((q) => `question: [${q.aspect}] ${q.text}`) : [];
  if (report.size.reason) reasons.push(report.size.reason);
  return {
    ...report,
    verdict: verdict.verdict,
    summary: verdict.summary,
    questions: verdict.questions.map((q) => ({ aspect: q.aspect, text: q.text })),
    assumptions: verdict.assumptions.map((a) => ({ aspect: a.aspect, text: a.text })),
    judge: {
      model: result.model,
      cost: fresh ? null : result.cost,
      unpriced: fresh,
      cached: result.cached,
      promptVersion: result.promptVersion,
      bodyHash: result.bodyHash,
    },
    reasons,
    exitCode: verdict.verdict === 'not-ready' ? 1 : report.size.verdict === 'would-split' ? 3 : 0,
  };
}

function numberedItems(label: string, items: CheckVerdictItem[]): string[] {
  if (items.length === 0) return [];
  return [`${label}:`, ...items.map((item, i) => `  ${i + 1}. [${item.aspect}] ${item.text}`)];
}

export function formatIssueCheckLines(report: IssueCheckReport): string[] {
  const lines: string[] = [];
  if (report.judge) {
    const j = report.judge;
    lines.push(
      `issue #${report.issue}: ${report.verdict} (${j.model}, ${j.cached ? 'cached' : 'fresh'}, ${formatCostTotal(j.cost, j.unpriced ? 1 : 0)})`,
    );
    lines.push(`summary: ${report.summary}`);
    lines.push(...numberedItems('questions', report.questions), ...numberedItems('assumptions', report.assumptions));
    lines.push(`advisory: ${report.template}, score ${report.score}%`);
  } else {
    const state = report.exitCode === 1 ? 'is not factory-ready' : 'is factory-ready';
    lines.push(`issue #${report.issue} ${state} (${report.template}, score ${report.score}%)`);
    if (report.judgeSkipped) lines.push('judge - skipped (epic)');
  }
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
  input: { title: string; body: string },
  runModel: DeepCheckModelRunner,
): Promise<IssueDeepCheck> {
  let result: { model: string; output: string; cost: number | null };
  try {
    result = await runModel('decompose', buildDecompositionPrompt({ title: input.title, body: input.body }));
  } catch (err) {
    throw new DeepCheckError(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseDecompositionOutput(result.output);
  if (!parsed.ok) throw new DeepCheckError(`model returned invalid output: ${parsed.reason}`);
  const children = parsed.decomposition.stories.map((s) => ({
    title: s.title,
    acceptanceCriteria: s.acceptanceCriteria.map(formatGapCriterion),
  }));
  return { kind: 'split', model: result.model, cost: result.cost, unpriced: result.cost === null, children };
}

export function formatDeepCheckLines(deep: IssueDeepCheck): string[] {
  const lines = [`deep: proposed split (preview only — nothing filed), ${deep.children.length} child stories`];
  deep.children.forEach((child, i) => {
    lines.push(`  ${i + 1}. ${child.title}`);
    for (const c of child.acceptanceCriteria) lines.push(`     - ${c}`);
  });
  lines.push(`model: ${deep.model}, cost: ${formatCostTotal(deep.cost, deep.unpriced ? 1 : 0)}`);
  return lines;
}

export async function runIssueCheck(
  issue: number,
  opts: { json?: boolean; deep?: boolean; judge?: boolean; rejudge?: boolean },
  deps: IssueCheckDeps,
): Promise<IssueCheckReport> {
  const { title, body, labels } = await deps.getIssue(issue);
  const labelNames = (labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
  const readiness = scoreIssueReadiness({ title, body: body ?? '', labels: labelNames });
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
  let report = buildIssueCheckReport(issue, readiness, criteria, invest);
  if (opts.judge !== false) {
    const runModel = deps.runModel;
    if (!runModel) throw new ReadinessJudgeError('model-error', 'no model runner configured');
    let unpriced = false;
    const result = await judgeReadiness({
      title,
      body: body ?? '',
      labels: labelNames,
      run: async (prompt) => {
        const r = await runModel('readiness_judge', prompt);
        if (r.cost === null) unpriced = true;
        return { model: r.model, output: r.output, cost: r.cost ?? 0 };
      },
      cache: deps.readinessCacheDir ? { dir: deps.readinessCacheDir } : undefined,
      rejudge: opts.rejudge,
    });
    report = applyJudgeResult(report, result, unpriced);
  }
  if (opts.deep && report.size.verdict === 'would-split') {
    if (!deps.runModel) throw new DeepCheckError('no model runner configured');
    report.deep = await runDeepCheck({ title, body: body ?? '' }, deps.runModel);
  }
  if (opts.json) {
    deps.log(JSON.stringify(report));
  } else {
    for (const line of formatIssueCheckLines(report)) deps.log(line);
    if (report.deep) for (const line of formatDeepCheckLines(report.deep)) deps.log(line);
    else if (opts.deep) deps.log('deep: runs as-is, no split preview');
  }
  return report;
}

/** Maps a judge or `--deep` failure to the CLI exit (2); null for any other error. */
export function checkErrorExit(err: unknown): { message: string; code: 2 } | null {
  if (err instanceof ReadinessJudgeError)
    return { message: `factory: readiness judge failed — ${err.message}`, code: 2 };
  if (err instanceof DeepCheckError) return { message: `factory: --deep failed — ${err.message}`, code: 2 };
  return null;
}

/** Maps a finished report to the CLI exit: 1 not-ready (or missing fields with --no-judge), 3 would split. */
export function checkReportExit(report: IssueCheckReport): { message: string; code: 1 | 3 } | null {
  if (report.exitCode === 1) {
    const state = report.verdict ?? 'not factory-ready';
    return { message: `factory: issue #${report.issue} is ${state} — ${report.reasons.join('; ')}`, code: 1 };
  }
  if (report.exitCode === 3) {
    return { message: `factory: issue #${report.issue} would split — ${report.size.reason}`, code: 3 };
  }
  return null;
}
