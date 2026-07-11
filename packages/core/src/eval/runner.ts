import { buildPlanPrompt } from '../phases/plan.js';
import type { ModelRouter } from '../router/index.js';
import { runJudgeSpec } from './judge.js';
import { scoreSpec } from './score.js';
import type { CaseResult, EvalSummary, GoldenCase } from './types.js';

export interface RunEvalOpts {
  cases: GoldenCase[];
  router: ModelRouter;
  judge: boolean;
  worktree?: string;
  timeoutSeconds?: number;
  now?: () => number;
  onLog?: (msg: string) => void;
}

export async function runEval(opts: RunEvalOpts): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  const worktree = opts.worktree ?? process.cwd();
  const timeout = opts.timeoutSeconds ?? 600;
  const now = opts.now ?? Date.now;

  for (const c of opts.cases) {
    opts.onLog?.(`running ${c.id}`);
    const prompt = buildPlanPrompt({
      issue: 0,
      issueTitle: c.title,
      issueBody: c.body,
      specPath: '<eval-spec>',
      constitutionCtx: '',
    });
    const started = now();

    try {
      const result = await opts.router.run('plan', prompt, { worktree, timeout });
      let latencyMs = now() - started;
      const scored = scoreSpec(result.output, result.output, c.expectedRoute);
      const deterministicPass = scored.checks.every(check => check.pass);
      const shouldJudge = opts.judge && !c.deterministicOnly && c.rubric.length > 0 && scored.route !== 'escalate';
      let rubricScore: number | undefined;
      let judgeMalformed = false;
      let malformedRaw: string | undefined;
      let costEstimate = estimateCost(opts.router, result.model, prompt, result.output);

      if (shouldJudge) {
        const judgeStarted = now();
        const judged = await runJudgeSpec(opts.router, {
          specContent: result.output,
          issueTitle: c.title,
          issueBody: c.body,
          rubric: c.rubric,
          worktree,
          timeout,
        });
        latencyMs += now() - judgeStarted;
        if (judged.malformed) {
          judgeMalformed = true;
          malformedRaw = judged.rawOutput ?? judged.reasons;
        } else {
          rubricScore = judged.score;
        }
        if (judged.result) {
          costEstimate += estimateCost(opts.router, judged.result.model, judged.prompt, judged.result.output);
        }
      }

      const pass = deterministicPass && !judgeMalformed && (!shouldJudge || (rubricScore ?? 0) >= c.minRubricScore);
      results.push({
        id: c.id,
        pass,
        route: scored.route,
        routeCorrect: scored.routeCorrect,
        checks: scored.checks,
        ...(rubricScore !== undefined ? { rubricScore } : {}),
        ...(judgeMalformed ? { judgeMalformed: true } : {}),
        judgeSkipped: !shouldJudge,
        model: result.model,
        latencyMs,
        costEstimate,
        ...(malformedRaw !== undefined ? { error: `judge-malformed: ${malformedRaw}` } : {}),
      });
    } catch (err) {
      results.push({
        id: c.id,
        pass: false,
        route: 'unparseable',
        routeCorrect: false,
        checks: [],
        judgeSkipped: true,
        model: 'unknown',
        latencyMs: now() - started,
        costEstimate: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const total = results.length;
  const passed = results.filter(result => result.pass).length;
  const failed = total - passed;
  return {
    results,
    total,
    passed,
    failed,
    passRate: total ? passed / total : 0,
    totalCostEstimate: results.reduce((sum, result) => sum + result.costEstimate, 0),
    totalLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
  };
}

function estimateCost(router: ModelRouter, model: string, input: string, output: string): number {
  const def = router.registryRef.get(model);
  if (!def) return 0;
  return (input.length / 4 / 1_000_000) * def.costPerMtokInput +
    (output.length / 4 / 1_000_000) * def.costPerMtokOutput;
}
