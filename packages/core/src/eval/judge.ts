import type { ModelRouter, RouterResult } from '../router/index.js';

export interface JudgeSpecOpts {
  specContent: string;
  issueTitle: string;
  issueBody: string;
  rubric: string[];
  worktree: string;
  timeout: number;
}

interface JudgeRunResult {
  score: number;
  reasons: string;
  result?: RouterResult;
  prompt: string;
}

export async function judgeSpec(router: ModelRouter, opts: JudgeSpecOpts): Promise<{ score: number; reasons: string }> {
  const result = await runJudgeSpec(router, opts);
  return { score: result.score, reasons: result.reasons };
}

export async function runJudgeSpec(router: ModelRouter, opts: JudgeSpecOpts): Promise<JudgeRunResult> {
  const prompt = buildJudgePrompt(opts);

  try {
    const result = await router.run('eval_judge', prompt, {
      worktree: opts.worktree,
      timeout: opts.timeout,
    });
    const jsonMatch = result.output.match(/\{[^{}]*"score"[^{}]*\}/);
    if (!jsonMatch) {
      return { score: 0, reasons: `judge failed: no valid JSON: ${result.output.slice(0, 200)}`, result, prompt };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const rawScore = Number(parsed.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(10, rawScore)) : 0;
    return { score, reasons: String(parsed.reasons ?? ''), result, prompt };
  } catch (err) {
    return { score: 0, reasons: `judge failed: ${err instanceof Error ? err.message : String(err)}`, prompt };
  }
}

function buildJudgePrompt(opts: JudgeSpecOpts): string {
  const rubric = opts.rubric.length > 0
    ? opts.rubric.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '(no rubric items)';

  return `You are an eval judge. Score this frozen spec against the rubric, 0-10.
Return ONLY JSON: {"score": <0-10>, "reasons": "<short>"}

ISSUE TITLE:
${opts.issueTitle}

ISSUE BODY:
${opts.issueBody}

RUBRIC:
${rubric}

FROZEN SPEC:
${opts.specContent}`;
}
