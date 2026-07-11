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
  malformed: boolean;
  rawOutput?: string;
  result?: RouterResult;
  prompt: string;
}

export function extractVerdict(output: string): { score: number; reasons: string } | null {
  for (let start = 0; start < output.length; start++) {
    if (output[start] !== '{') continue;

    let depth = 0;
    let inString = false;

    for (let i = start; i < output.length; i++) {
      const ch = output[i];

      if (inString) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;

      if (depth === 0) {
        const candidate = output.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (typeof parsed.score === 'number' && Number.isFinite(parsed.score)) {
              return {
                score: Math.max(0, Math.min(10, parsed.score)),
                reasons: String(parsed.reasons ?? ''),
              };
            }
          }
        } catch {
          // Keep scanning for the next balanced JSON object.
        }
        break;
      }
    }
  }

  return null;
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
    const verdict = extractVerdict(result.output);
    if (!verdict) {
      return {
        score: 0,
        reasons: 'judge failed: no parseable score',
        malformed: true,
        rawOutput: result.output,
        result,
        prompt,
      };
    }

    return { score: verdict.score, reasons: verdict.reasons, malformed: false, result, prompt };
  } catch (err) {
    return {
      score: 0,
      reasons: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
      malformed: true,
      prompt,
    };
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
