import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ModelRouter } from '../router/index.js';
import { judgeReadiness, parseReadinessVerdict, prepareReadinessInput } from '../readiness/judge.js';
import { readSpec } from '../spec/index.js';
import type { BaselineComparison } from './baseline.js';
import { extractStubOutput, extractTitleAndBody } from './golden.js';
import { runJudgeSamples } from './judge.js';
import type { JudgeSample } from './judge.js';
import { estimateCost } from './runner.js';
import type { DeterministicCheck } from './types.js';

export type ReadinessVerdictName = 'ready' | 'ready-with-assumptions' | 'not-ready';
export type ExpectedReadiness = ReadinessVerdictName | 'judge-error';

const EXPECTED_VALUES = new Set<string>(['ready', 'ready-with-assumptions', 'not-ready', 'judge-error']);
const VERDICT_NAMES: ReadinessVerdictName[] = ['ready', 'ready-with-assumptions', 'not-ready'];

export interface ReadinessCase {
  id: string;
  title: string;
  body: string;
  expectedVerdict: ExpectedReadiness;
  acceptableVerdicts: ExpectedReadiness[];
  mustAsk: string[];
  labels: string[];
  rubric: string[];
  minRubricScore: number;
  stubOutput?: string;
  path: string;
}

export interface RunReadinessEvalOpts {
  cases: ReadinessCase[];
  router: ModelRouter;
  judge: boolean;
  judgeK?: number;
  worktree?: string;
  timeoutSeconds?: number;
  now?: () => number;
  onLog?: (msg: string) => void;
}

export interface ReadinessCaseResult {
  id: string;
  pass: boolean;
  verdict: ReadinessVerdictName | 'judge-error';
  expectedVerdict: ExpectedReadiness;
  checks: DeterministicCheck[];
  mustAskHit?: boolean;
  rubricScore?: number;
  judgeMalformed?: boolean;
  judgeSamples?: JudgeSample[];
  judgeSkipped: boolean;
  model: string;
  latencyMs: number;
  costEstimate: number;
  error?: string;
}

export type ReadinessConfusion = Record<ReadinessVerdictName, Record<ReadinessVerdictName, number>>;

export interface ReadinessEvalSummary {
  results: ReadinessCaseResult[];
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  confusion: ReadinessConfusion;
  falseReadyRate: number;
  falseNotReadyRate: number;
  mustAskHitRate: number;
  judgeErrors: number;
  totalCostEstimate: number;
  totalLatencyMs: number;
}

export interface ReadinessBaseline {
  version: 1;
  suite: 'readiness';
  tolerance: { falseReadyRate: number; falseNotReadyRate: number; rubricScore: number };
  budgets?: { totalCostEstimate?: number };
  accuracy: number;
  falseReadyRate: number;
  falseNotReadyRate: number;
  cases: Record<string, { pass: boolean; verdict: string; rubricScore?: number }>;
}

const DEFAULT_TOLERANCE: ReadinessBaseline['tolerance'] = {
  falseReadyRate: 0,
  falseNotReadyRate: 0.1,
  rubricScore: 1.0,
};

function parseExpected(value: unknown, field: string, path: string): ExpectedReadiness {
  if (typeof value !== 'string' || !EXPECTED_VALUES.has(value)) {
    throw new Error(`${path}: invalid ${field} '${String(value)}'`);
  }
  return value as ExpectedReadiness;
}

function stringArray(value: unknown, field: string, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: ${field} must be an array`);
  return value.map(String);
}

export async function loadReadinessCases(dir: string): Promise<ReadinessCase[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();

  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      const { data, body } = await readSpec(path);

      const expectedVerdict = parseExpected(data.expectedVerdict, 'expectedVerdict', path);
      if (data.acceptableVerdicts !== undefined && !Array.isArray(data.acceptableVerdicts)) {
        throw new Error(`${path}: acceptableVerdicts must be an array`);
      }
      const acceptableVerdicts = Array.isArray(data.acceptableVerdicts)
        ? data.acceptableVerdicts.map((v: unknown) => parseExpected(v, 'acceptableVerdicts entry', path))
        : [expectedVerdict];

      const { content: contentWithoutStub, stubOutput } = extractStubOutput(body);
      const { title, body: issueBody } = extractTitleAndBody(contentWithoutStub, path);

      return {
        id: typeof data.id === 'string' && data.id.trim() ? data.id : basename(file, '.md'),
        title,
        body: issueBody,
        expectedVerdict,
        acceptableVerdicts,
        mustAsk: stringArray(data.mustAsk, 'mustAsk', path),
        labels: stringArray(data.labels, 'labels', path),
        rubric: stringArray(data.rubric, 'rubric', path),
        minRubricScore: typeof data.minRubricScore === 'number' ? data.minRubricScore : 7,
        ...(stubOutput !== undefined ? { stubOutput } : {}),
        path,
      };
    }),
  );
}

/** Steps for one case. A reply that fails to parse is emitted twice so judgeReadiness's repair call is answered too. */
export function readinessStubSteps(c: ReadinessCase): { output: string }[] {
  const out = c.stubOutput ?? '';
  return parseReadinessVerdict(out).ok ? [{ output: out }] : [{ output: out }, { output: out }];
}

const WRAP_RE = /<untrusted-issue-body>[\s\S]*?<\/untrusted-issue-body>/g;

function wrapsBodyCheck(c: ReadinessCase, prompt: string | undefined): DeterministicCheck {
  const name = 'prompt-wraps-body';
  const prepared = prepareReadinessInput({ title: c.title, body: c.body }).body;
  if (!prepared) return { name, pass: true, details: 'empty body' };
  if (prompt === undefined) return { name, pass: false, details: 'no prompt sent' };
  const line = prepared
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return { name, pass: true, details: 'empty body' };
  const outside = prompt.replace(WRAP_RE, '');
  const pass = prompt.includes(line) && !outside.includes(line);
  return { name, pass, details: pass ? 'body is inside the untrusted wrapper' : 'body line not wrapped' };
}

export async function runReadinessEval(opts: RunReadinessEvalOpts): Promise<ReadinessEvalSummary> {
  const results: ReadinessCaseResult[] = [];
  const worktree = opts.worktree ?? process.cwd();
  const timeoutSeconds = opts.timeoutSeconds ?? 600;
  const judgeK = opts.judgeK ?? 1;
  const now = opts.now ?? Date.now;

  for (const c of opts.cases) {
    opts.onLog?.(`running ${c.id}`);
    const started = now();
    let firstPrompt: string | undefined;
    let model = 'unknown';
    let costEstimate = 0;
    let verdict: ReadinessCaseResult['verdict'] = 'judge-error';
    let questions: string[] = [];
    let error: string | undefined;
    let isVerdict = false;
    let verdictJson = '';

    try {
      const result = await judgeReadiness({
        title: c.title,
        body: c.body,
        labels: c.labels,
        run: async (prompt) => {
          firstPrompt ??= prompt;
          const r = await opts.router.run('readiness_judge', prompt, { worktree, timeoutSeconds });
          const cost = estimateCost(opts.router, r.model, prompt, r.output);
          model = r.model;
          costEstimate += cost;
          return { model: r.model, output: r.output, cost };
        },
      });
      if (result.kind === 'verdict') {
        isVerdict = true;
        verdict = result.verdict.verdict;
        questions = result.verdict.questions.map((q) => q.text);
        verdictJson = JSON.stringify(result.verdict, null, 2);
      } else if (result.kind === 'error') {
        error = `${result.errorKind}: ${result.detail}`;
      } else {
        error = 'skipped: epic';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    let latencyMs = now() - started;

    const checks: DeterministicCheck[] = [wrapsBodyCheck(c, firstPrompt)];
    const parsedOk = c.expectedVerdict === 'judge-error' ? verdict === 'judge-error' : verdict !== 'judge-error';
    checks.push({
      name: 'verdict-parsed',
      pass: parsedOk,
      details: parsedOk ? `verdict ${verdict}` : `verdict ${verdict}, expected ${c.expectedVerdict}`,
    });
    const correct = c.acceptableVerdicts.includes(verdict);
    checks.push({
      name: 'verdict-correct',
      pass: correct,
      details: `got ${verdict}, acceptable ${c.acceptableVerdicts.join('|')}`,
    });
    let mustAskHit: boolean | undefined;
    if (c.mustAsk.length === 0) {
      checks.push({ name: 'must-ask', pass: true, details: 'n/a' });
    } else {
      const keywords = c.mustAsk.map((k) => k.toLowerCase());
      mustAskHit = questions.some((q) => keywords.some((k) => q.toLowerCase().includes(k)));
      checks.push({
        name: 'must-ask',
        pass: mustAskHit,
        details: mustAskHit ? 'a question matches' : `no question mentions ${c.mustAsk.join('|')}`,
      });
    }

    const shouldJudge = opts.judge && c.rubric.length > 0 && isVerdict;
    let rubricScore: number | undefined;
    let judgeMalformed = false;
    let judgeSamples: JudgeSample[] | undefined;
    if (shouldJudge) {
      const judgeStarted = now();
      const judged = await runJudgeSamples(
        opts.router,
        {
          specContent: verdictJson,
          issueTitle: c.title,
          issueBody: c.body,
          rubric: c.rubric,
          worktree,
          timeoutSeconds,
        },
        judgeK,
      );
      latencyMs += now() - judgeStarted;
      judgeSamples = judged.samples;
      if (judged.validCount === 0) judgeMalformed = true;
      else rubricScore = judged.score;
      for (const r of judged.results) costEstimate += estimateCost(opts.router, r.model, judged.prompt, r.output);
    }

    const pass =
      checks.every((check) => check.pass) &&
      !judgeMalformed &&
      (!shouldJudge || (rubricScore ?? 0) >= c.minRubricScore);
    results.push({
      id: c.id,
      pass,
      verdict,
      expectedVerdict: c.expectedVerdict,
      checks,
      ...(mustAskHit !== undefined ? { mustAskHit } : {}),
      ...(rubricScore !== undefined ? { rubricScore } : {}),
      ...(judgeMalformed ? { judgeMalformed: true } : {}),
      ...(judgeSamples !== undefined ? { judgeSamples } : {}),
      judgeSkipped: !shouldJudge,
      model,
      latencyMs,
      costEstimate,
      ...(error !== undefined ? { error } : {}),
    });
  }

  return summarize(results);
}

function isReady(v: string): boolean {
  return v === 'ready' || v === 'ready-with-assumptions';
}

function summarize(results: ReadinessCaseResult[]): ReadinessEvalSummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const confusion = {} as ReadinessConfusion;
  for (const e of VERDICT_NAMES) {
    confusion[e] = { ready: 0, 'ready-with-assumptions': 0, 'not-ready': 0 };
  }
  for (const r of results) {
    if (r.expectedVerdict !== 'judge-error' && r.verdict !== 'judge-error') {
      confusion[r.expectedVerdict][r.verdict]++;
    }
  }
  const notReady = results.filter((r) => r.expectedVerdict === 'not-ready');
  const readyCases = results.filter((r) => isReady(r.expectedVerdict));
  const mustAsked = results.filter((r) => r.mustAskHit !== undefined);
  const falseReady = notReady.filter((r) => isReady(r.verdict)).length;
  const falseNotReady = readyCases.filter((r) => r.verdict === 'not-ready').length;
  return {
    results,
    total,
    passed,
    failed: total - passed,
    accuracy: total ? passed / total : 0,
    confusion,
    falseReadyRate: notReady.length ? falseReady / notReady.length : 0,
    falseNotReadyRate: readyCases.length ? falseNotReady / readyCases.length : 0,
    mustAskHitRate: mustAsked.length ? mustAsked.filter((r) => r.mustAskHit).length / mustAsked.length : 1,
    judgeErrors: results.filter((r) => r.verdict === 'judge-error').length,
    totalCostEstimate: results.reduce((sum, r) => sum + r.costEstimate, 0),
    totalLatencyMs: results.reduce((sum, r) => sum + r.latencyMs, 0),
  };
}

export function toReadinessBaseline(
  summary: ReadinessEvalSummary,
  tolerance: ReadinessBaseline['tolerance'] = DEFAULT_TOLERANCE,
  budgets?: ReadinessBaseline['budgets'],
): ReadinessBaseline {
  const cases: ReadinessBaseline['cases'] = {};
  for (const r of summary.results) {
    cases[r.id] = {
      pass: r.pass,
      verdict: r.verdict,
      ...(r.rubricScore !== undefined ? { rubricScore: r.rubricScore } : {}),
    };
  }
  return {
    version: 1,
    suite: 'readiness',
    tolerance,
    ...(budgets ? { budgets } : {}),
    accuracy: summary.accuracy,
    falseReadyRate: summary.falseReadyRate,
    falseNotReadyRate: summary.falseNotReadyRate,
    cases,
  };
}

export function compareReadinessToBaseline(
  summary: ReadinessEvalSummary,
  baseline: ReadinessBaseline,
): BaselineComparison {
  const regressions: string[] = [];
  const notes: string[] = [];
  const tolFalseReady = baseline.tolerance.falseReadyRate ?? 0;
  const tolFalseNotReady = baseline.tolerance.falseNotReadyRate ?? 0;
  const tolRubric = baseline.tolerance.rubricScore ?? 0;

  if (summary.falseReadyRate > baseline.falseReadyRate + tolFalseReady) {
    const ids = summary.results.filter((r) => r.expectedVerdict === 'not-ready' && isReady(r.verdict)).map((r) => r.id);
    regressions.push(
      `false-ready rate rose: ${summary.falseReadyRate} > baseline ${baseline.falseReadyRate} + tolerance ${tolFalseReady}` +
        (ids.length ? ` (false-ready: ${ids.join(', ')})` : ''),
    );
  }

  if (summary.falseNotReadyRate > baseline.falseNotReadyRate + tolFalseNotReady) {
    const ids = summary.results.filter((r) => isReady(r.expectedVerdict) && r.verdict === 'not-ready').map((r) => r.id);
    regressions.push(
      `false-not-ready rate rose: ${summary.falseNotReadyRate} > baseline ${baseline.falseNotReadyRate} + tolerance ${tolFalseNotReady}` +
        (ids.length ? ` (false-not-ready: ${ids.join(', ')})` : ''),
    );
  }

  if (
    baseline.budgets?.totalCostEstimate !== undefined &&
    summary.totalCostEstimate > baseline.budgets.totalCostEstimate
  ) {
    regressions.push(
      `estimated cost exceeds budget: ${summary.totalCostEstimate} > budget ${baseline.budgets.totalCostEstimate}`,
    );
  }

  const runIds = new Set(summary.results.map((r) => r.id));
  for (const r of summary.results) {
    const b = baseline.cases[r.id];
    if (!b) {
      notes.push(`case '${r.id}' is present in the run but missing from the baseline`);
      continue;
    }
    if (b.pass && !r.pass) regressions.push(`case '${r.id}' was passing in the baseline and now fails`);
    if (b.rubricScore !== undefined && r.rubricScore !== undefined && r.rubricScore < b.rubricScore - tolRubric) {
      regressions.push(
        `case '${r.id}' rubric score dropped: ${r.rubricScore} < baseline ${b.rubricScore} - tolerance ${tolRubric}`,
      );
    }
  }
  for (const id of Object.keys(baseline.cases)) {
    if (!runIds.has(id)) notes.push(`case '${id}' is present in the baseline but missing from the run`);
  }

  return { regressions, notes, ok: regressions.length === 0 };
}
