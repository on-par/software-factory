// src/kpis/classifier-backtest.ts — Replay the floor and shadow classifier over merged factory PRs (#1728)

import {
  type CollectedDiff,
  DIFF_EXCLUDES,
  type DiffRunner,
  defaultDiffRunner,
  MAX_DIFF_CHARS,
} from '../checkers/design-smells.js';
import { classifyPrShadow, toClassificationRecord } from '../review/classifier.js';
import {
  computeReviewFloor,
  type ReviewClass,
  type ReviewFloorPathChange,
  type ReviewFloorRuleSet,
} from '../review/floor.js';
import { parseNumstat } from '../review/routing.js';
import type { ModelRouter } from '../router/index.js';
import type { FactoryEvent } from '../types/index.js';
import {
  applyHandLabel,
  type ClassifierOutcomeBucket,
  type ClassifierOutcomeRecord,
  classifierOutcomeBucket,
  joinClassifierOutcomes,
} from './classifier-outcomes.js';
import type { PrSource } from './human.js';

export type BacktestLabelSource = 'hand' | 'heuristic';

export interface ClassifierBacktestRecord extends ClassifierOutcomeRecord {
  backtest: true;
  mergeCommitSha: string;
  outcome: ClassifierOutcomeBucket;
  labelSource: BacktestLabelSource;
  handLabel: ReviewClass | null;
  heuristic: { defectFired: boolean; humanEdited: boolean; humanAbandoned: boolean; defectWindowClosed: boolean };
  floorRuleIds: string[];
  costUsd: number | null;
}

export interface ClassifierBacktestInput {
  repoRoot: string;
  /** Already selected (see selectBacktestPrs). */
  prs: PrSource[];
  /** Local log + reconstructed human + post-merge defect events. */
  outcomeEvents: FactoryEvent[];
  rules: ReviewFloorRuleSet;
  router: ModelRouter;
  modelPin?: string;
  specPathFor: (issue: string) => string;
  handLabels?: ReadonlyMap<number, ReviewClass>;
  maxCostUsd?: number;
  now: string;
  windowDays: number;
}

export interface ClassifierBacktestDeps {
  getIssue: (issue: string) => Promise<{ title: string; body: string }>;
  readChanges?: (repoRoot: string, sha: string) => Promise<ReviewFloorPathChange[]>;
  collectDiff?: (repoRoot: string, sha: string) => Promise<CollectedDiff>;
  classify?: typeof classifyPrShadow;
  onRecord?: (record: ClassifierBacktestRecord) => void;
}

export interface ClassifierBacktestResult {
  records: ClassifierBacktestRecord[];
  skipped: Array<{ issue: string; prNumber: number; reason: string }>;
  /** PRs a classifier call was made for. */
  covered: number;
  /** Priced spend only. */
  spentUsd: number;
  unpricedCalls: number;
  stopped: null | 'budget' | 'unpriced';
  /** Selected PRs never attempted because of a stop. */
  notRun: number;
}

export function parseHandLabels(text: string): Map<number, ReviewClass> {
  const labels = new Map<number, ReviewClass>();
  let seenFirst = false;
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    // `#123,A` is a label; any other `#` line is a comment.
    if (line === '' || (line.startsWith('#') && !/^#\d/.test(line))) return;
    if (!seenFirst) {
      seenFirst = true;
      if (/^\s*pr\s*,\s*class\s*$/i.test(line)) return;
    }
    const m = /^#?(\d+)\s*,\s*([A-Za-z])$/.exec(line);
    const pr = m ? Number(m[1]) : 0;
    const cls = m ? m[2].toUpperCase() : '';
    if (!m || pr < 1 || !['A', 'B', 'C'].includes(cls)) {
      throw new Error(`labels line ${idx + 1}: expected "pr,class" with class A, B or C, got "${line}"`);
    }
    labels.set(pr, cls as ReviewClass);
  });
  return labels;
}

export function selectBacktestPrs(sources: PrSource[], opts: { since: string; limit?: number }): PrSource[] {
  const sinceMs = Date.parse(opts.since);
  const seen = new Set<number>();
  const kept: PrSource[] = [];
  for (const s of sources) {
    if (s.mergedAt === null || !s.mergeCommitSha || !/^\d+$/.test(s.issue)) continue;
    if (!(Date.parse(s.mergedAt) >= sinceMs)) continue;
    if (seen.has(s.prNumber)) continue;
    seen.add(s.prNumber);
    kept.push(s);
  }
  kept.sort((a, b) => Date.parse(a.mergedAt as string) - Date.parse(b.mergedAt as string));
  return opts.limit === undefined ? kept : kept.slice(0, opts.limit);
}

export async function collectMergeCommitDiff(
  repoRoot: string,
  sha: string,
  run: DiffRunner = defaultDiffRunner,
): Promise<CollectedDiff> {
  const r = await run(['git', 'diff', '--unified=3', `${sha}^`, sha, '--', '.', ...DIFF_EXCLUDES], repoRoot);
  if (!r.ok) {
    return {
      text: '',
      baseRef: null,
      truncated: false,
      skipReason: `merge commit ${sha} not available locally (git fetch origin?)`,
    };
  }
  let text = r.stdout;
  let truncated = false;
  if (text.length > MAX_DIFF_CHARS) {
    text = `${text.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters]`;
    truncated = true;
  }
  return { text, baseRef: `${sha}^`, truncated };
}

export async function readMergeCommitChanges(
  repoRoot: string,
  sha: string,
  run: DiffRunner = defaultDiffRunner,
): Promise<ReviewFloorPathChange[]> {
  const r = await run(['git', 'diff', '--numstat', '--no-renames', `${sha}^`, sha], repoRoot);
  if (!r.ok) throw new Error(`git diff --numstat for merge commit ${sha} failed`);
  return parseNumstat(r.stdout);
}

export async function runClassifierBacktest(
  input: ClassifierBacktestInput,
  deps: ClassifierBacktestDeps,
): Promise<ClassifierBacktestResult> {
  const { repoRoot, prs, rules, router, modelPin, specPathFor, handLabels, maxCostUsd, now, windowDays } = input;
  const events = input.outcomeEvents.filter((e) => e.type !== 'pr-classified');
  const readChanges = deps.readChanges ?? ((root: string, sha: string) => readMergeCommitChanges(root, sha));
  const collectDiff = deps.collectDiff ?? ((root: string, sha: string) => collectMergeCommitDiff(root, sha));
  const classify = deps.classify ?? classifyPrShadow;

  const result: ClassifierBacktestResult = {
    records: [],
    skipped: [],
    covered: 0,
    spentUsd: 0,
    unpricedCalls: 0,
    stopped: null,
    notRun: 0,
  };

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i];
    const sha = pr.mergeCommitSha as string;
    const remaining = prs.length - i;

    if (maxCostUsd !== undefined && result.spentUsd >= maxCostUsd) {
      result.stopped = 'budget';
      result.notRun = remaining;
      break;
    }

    let floor: ReviewClass | null;
    let floorRules: ReturnType<typeof computeReviewFloor>['rules'];
    try {
      const r = computeReviewFloor({ changes: await readChanges(repoRoot, sha), rules });
      floor = r.floor;
      floorRules = r.rules;
    } catch {
      floor = null;
      floorRules = [];
    }

    let issueTitle: string;
    let issueBody: string;
    try {
      ({ title: issueTitle, body: issueBody } = await deps.getIssue(pr.issue));
    } catch (err) {
      result.skipped.push({
        issue: pr.issue,
        prNumber: pr.prNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const verdict = await classify(
      {
        worktree: repoRoot,
        issueTitle,
        issueBody,
        specPath: specPathFor(pr.issue),
        floor,
        floorRules,
        rules,
        modelPin,
        router,
      },
      { collectDiff: () => collectDiff(repoRoot, sha) },
    );
    result.covered++;

    const unpriced = verdict.costUsd === null && verdict.model !== null;
    if (verdict.costUsd !== null) result.spentUsd += verdict.costUsd;
    else if (verdict.model !== null) result.unpricedCalls++;

    if (verdict.modelClass === null) {
      result.skipped.push({
        issue: pr.issue,
        prNumber: pr.prNumber,
        reason: verdict.reason ?? 'no classification',
      });
    } else {
      const synthetic: FactoryEvent = {
        ts: now,
        type: 'pr-classified',
        issue: pr.issue,
        msg: `backtest PR #${pr.prNumber}`,
        prClassification: toClassificationRecord(verdict),
      };
      const [base] = joinClassifierOutcomes([...events, synthetic], [pr], { now, windowDays });
      const heuristic = {
        defectFired: base.defectFired,
        humanEdited: base.humanEdited,
        humanAbandoned: base.humanAbandoned,
        defectWindowClosed: base.defectWindowClosed,
      };
      const hand = handLabels?.get(pr.prNumber) ?? null;
      const rec = hand === null ? base : applyHandLabel(base, hand);
      const record: ClassifierBacktestRecord = {
        ...rec,
        backtest: true,
        mergeCommitSha: sha,
        outcome: classifierOutcomeBucket(rec),
        labelSource: hand === null ? 'heuristic' : 'hand',
        handLabel: hand,
        heuristic,
        floorRuleIds: floorRules.map((r) => r.id),
        costUsd: verdict.costUsd,
      };
      deps.onRecord?.(record);
      result.records.push(record);
    }

    if (maxCostUsd !== undefined && unpriced) {
      result.stopped = 'unpriced';
      result.notRun = prs.length - i - 1;
      break;
    }
  }
  return result;
}
