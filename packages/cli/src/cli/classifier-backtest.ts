// packages/cli/src/cli/classifier-backtest.ts — `factory classifier backtest`: replay the floor + shadow classifier over merged PRs (#1728)
import { join } from 'node:path';
import { styleText } from 'node:util';

import {
  detectPostMergeDefects,
  fetchDefectSources,
  fetchHumanEventSources,
  formatClassifierReport,
  mergedPrRefs,
  reconstructHumanEvents,
  summarizeClassifierOutcomes,
  type ClassifierOutcomeRecord,
  type DefectSourceClient,
  type FactoryEvent,
  type getFactoryPaths,
  type HumanSourceClient,
  type ModelRouter,
} from '@on-par/factory-core';
import {
  backtestFileName,
  parseBacktestLabels,
  runClassifierBacktest,
  selectBacktestPrs,
  type BacktestHandLabel,
  type ReviewFloorRuleSet,
} from '@on-par/factory-core/internal';

export interface ClassifierBacktestOptions {
  since: string;
  limit?: string;
  labels?: string;
  maxCost?: string;
  json?: boolean;
  branchPrefix?: string;
}

export interface ClassifierBacktestDeps {
  repoRoot: string;
  paths: ReturnType<typeof getFactoryPaths>;
  owner: string;
  repo: string;
  octokit: HumanSourceClient &
    DefectSourceClient & {
      rest: { issues: { get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: any }> } };
    };
  router: ModelRouter;
  rules: ReviewFloorRuleSet;
  modelPin?: string;
  windowDays: number;
  /** git, run in repoRoot. */
  exec(cmd: string): Promise<{ stdout: string }>;
  readFile(path: string): string;
  appendFile(path: string, text: string): void;
  ensureDir(path: string): void;
  /** Reads the local events log; [] when it does not exist. */
  readEvents(path: string): FactoryEvent[];
  now(): string;
  log(line: string): void;
}

/** Bad command-line input; the caller maps it to exit code 2. */
export class ClassifierBacktestInputError extends Error {
  constructor(message: string) {
    super(`factory: ${message}`);
    this.name = 'ClassifierBacktestInputError';
  }
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function validateOptions(opts: ClassifierBacktestOptions): { limit?: number; maxCost?: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since) || Number.isNaN(Date.parse(opts.since))) {
    throw new ClassifierBacktestInputError(`invalid --since '${opts.since}' — expected YYYY-MM-DD`);
  }
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!/^\d+$/.test(opts.limit) || limit < 1) {
      throw new ClassifierBacktestInputError(`invalid --limit '${opts.limit}' — expected a positive integer`);
    }
  }
  let maxCost: number | undefined;
  if (opts.maxCost !== undefined) {
    maxCost = Number(opts.maxCost);
    if (opts.maxCost.trim() === '' || !Number.isFinite(maxCost) || maxCost <= 0) {
      throw new ClassifierBacktestInputError(`invalid --max-cost '${opts.maxCost}' — expected a number of USD > 0`);
    }
  }
  return { limit, maxCost };
}

function loadLabels(opts: ClassifierBacktestOptions, deps: ClassifierBacktestDeps): Map<number, BacktestHandLabel> {
  if (opts.labels === undefined) return new Map();
  try {
    return parseBacktestLabels(deps.readFile(opts.labels));
  } catch (err: any) {
    throw new ClassifierBacktestInputError(`--labels ${opts.labels}: ${err?.message ?? err}`);
  }
}

export async function cmdClassifierBacktest(
  opts: ClassifierBacktestOptions,
  deps: ClassifierBacktestDeps,
): Promise<void> {
  const { limit, maxCost } = validateOptions(opts);
  const labels = loadLabels(opts, deps);
  const now = deps.now();
  const { owner, repo, paths } = deps;

  const sources = await fetchHumanEventSources(deps.octokit, owner, repo, null, opts.branchPrefix);
  const selected = selectBacktestPrs(sources, { since: opts.since, limit });
  if (selected.length === 0) {
    deps.log(`No merged factory PRs since ${opts.since}.`);
    return;
  }

  const local = deps.readEvents(paths.events);
  let events = [...local, ...reconstructHumanEvents(selected, local)];
  try {
    const defectSources = await fetchDefectSources(deps.octokit, owner, repo, mergedPrRefs(selected), {
      now,
      windowDays: deps.windowDays,
    });
    events = [...events, ...detectPostMergeDefects(defectSources, events, { now, windowDays: deps.windowDays })];
  } catch (err: any) {
    console.error(
      styleText(
        'yellow',
        `factory: post-merge defect signals unavailable (${err?.message ?? err}) — heuristic defect labels omitted (hand labels still apply)`,
      ),
    );
  }

  const file = join(paths.state, backtestFileName(now));
  deps.ensureDir(paths.state);
  const checkSha = (sha: string): string => {
    if (!SHA_PATTERN.test(sha)) throw new Error(`refusing unsafe merge commit sha '${sha}'`);
    return sha;
  };
  const result = await runClassifierBacktest(
    { sources: selected, events, labels, rules: deps.rules, maxCostUsd: maxCost, now, windowDays: deps.windowDays },
    {
      numstat: async (sha) => (await deps.exec(`git diff --numstat --no-renames ${checkSha(sha)}^1 ${sha}`)).stdout,
      diff: async (sha) => (await deps.exec(`git diff --no-renames ${checkSha(sha)}^1 ${sha}`)).stdout,
      getIssue: async (n) => {
        const { data } = await deps.octokit.rest.issues.get({ owner, repo, issue_number: n });
        return { title: data.title ?? '', body: data.body ?? '' };
      },
      specPath: (issue) => join(paths.plans, `issue-${issue}.md`),
      worktree: deps.repoRoot,
      router: deps.router,
      modelPin: deps.modelPin,
      onRecord: (r) => deps.appendFile(file, `${JSON.stringify(r)}\n`),
    },
  );

  const spent = `$${result.spentUsd.toFixed(2)} spent`;
  const covered = result.records.length;
  if (result.budgetReached) {
    deps.log(`budget reached: covered ${covered} of ${result.candidates} PRs (${spent})`);
  } else {
    const unpriced = result.unpricedCalls > 0 ? `, ${result.unpricedCalls} unpriced` : '';
    deps.log(`covered ${covered} of ${result.candidates} PRs (${spent}${unpriced})`);
  }

  const report = summarizeClassifierOutcomes(
    result.records.filter((r) => r.modelClass !== null) as ClassifierOutcomeRecord[],
  );
  if (opts.json) {
    deps.log(
      JSON.stringify({
        file,
        covered,
        candidates: result.candidates,
        spentUsd: result.spentUsd,
        budgetReached: result.budgetReached,
        report,
      }),
    );
    return;
  }
  for (const line of formatClassifierReport(report)) deps.log(line);
  deps.log(`Wrote ${file}`);
}
