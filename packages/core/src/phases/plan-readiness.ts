import { writeFile } from 'node:fs/promises';

import type { ReadinessJudgeMode } from '../config/readiness-mode.js';
import { scoreIssueReadiness } from '../readiness/index.js';
import { judgeReadiness, type ReadinessVerdict } from '../readiness/judge.js';
import type { ModelRouter } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { specPaths } from '../spec/index.js';
import type { ReadinessInfo } from '../types/index.js';

const READINESS_JUDGE_TIMEOUT_SECONDS = 120;

type Item = { aspect: string; text: string };

interface ReadinessNotes {
  verdict: ReadinessVerdict['verdict'];
  summary: string;
  assumptions: Item[];
  questions: Item[];
}

type ReadinessGate =
  | { kind: 'proceed'; readiness: ReadinessInfo; fastPathReady?: boolean; notes?: ReadinessNotes }
  | { kind: 'stop'; escalate: string; questions?: Item[] };

const plain = (items: readonly Item[]): Item[] => items.map(({ aspect, text }) => ({ aspect, text }));

export async function runReadinessGate(opts: {
  mode: ReadinessJudgeMode;
  work: { title: string; brief: string; labels?: readonly string[] };
  router: ModelRouter;
  worktree: string;
  sandbox?: SandboxPolicy;
  cacheDir?: string;
  log: (type: 'readiness' | 'router', msg: string, extra?: { readiness: ReadinessInfo }) => void;
}): Promise<ReadinessGate> {
  const { mode, work, log } = opts;
  const headings = scoreIssueReadiness({ title: work.title, body: work.brief, labels: work.labels });
  const percent = `${Math.round(headings.score * 100)}% (${headings.template})`;
  if (mode === 'off') {
    const missing = headings.pass ? '' : ` — missing: ${headings.missing.join(', ')}`;
    log('readiness', `issue readiness ${percent}${missing}`, { readiness: headings });
    return { kind: 'proceed', readiness: headings };
  }

  const advisory = mode === 'advisory';
  const proceeding = advisory ? ' — advisory mode, proceeding' : '';
  const result = await judgeReadiness({
    title: work.title,
    body: work.brief,
    labels: work.labels,
    run: async (prompt) => {
      const r = await opts.router.run('readiness_judge', prompt, {
        worktree: opts.worktree,
        sandbox: opts.sandbox,
        timeoutSeconds: READINESS_JUDGE_TIMEOUT_SECONDS,
        onLog: (msg) => log('router', msg),
      });
      return { model: r.model, output: r.output, cost: 0 };
    },
    cache: opts.cacheDir === undefined ? undefined : { dir: opts.cacheDir },
  });

  if (result.kind === 'skipped') {
    log('readiness', `readiness judge skipped (epic); advisory heading score ${percent}`, { readiness: headings });
    return { kind: 'proceed', readiness: headings, fastPathReady: false };
  }
  if (result.kind === 'error') {
    const failure = `readiness judge failed (${result.errorKind}): ${result.detail}`;
    log('readiness', `${failure}${proceeding}`, { readiness: headings });
    return advisory
      ? { kind: 'proceed', readiness: headings, fastPathReady: false }
      : { kind: 'stop', escalate: failure };
  }

  const { verdict } = result;
  const questions = plain(verdict.questions);
  const assumptions = plain(verdict.assumptions);
  const readiness: ReadinessInfo = {
    ...headings,
    judge: {
      verdict: verdict.verdict,
      questions,
      assumptions,
      aspects: [...new Set([...questions, ...assumptions].map((i) => i.aspect))],
      cached: result.cached,
      model: result.model,
      promptVersion: result.promptVersion,
    },
  };
  const notReady = verdict.verdict === 'not-ready';
  log(
    'readiness',
    `readiness verdict ${verdict.verdict} (${result.model}${result.cached ? ', cached' : ''})${notReady ? proceeding : ''}; advisory heading score ${percent}`,
    { readiness },
  );
  if (notReady && !advisory) {
    return { kind: 'stop', escalate: `ticket is not ready: ${questions.length} question(s) for the author`, questions };
  }
  return {
    kind: 'proceed',
    readiness,
    fastPathReady: verdict.verdict === 'ready',
    notes: { verdict: verdict.verdict, summary: verdict.summary, assumptions, questions },
  };
}

export async function writeReadinessNotes(specPath: string, notes: ReadinessNotes | undefined): Promise<void> {
  if (notes) await writeFile(specPaths(specPath).readiness, `${JSON.stringify(notes, null, 2)}\n`, { mode: 0o600 });
}
