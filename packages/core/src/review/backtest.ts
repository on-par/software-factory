// packages/core/src/review/backtest.ts — replay the floor + shadow classifier over merged factory PRs (#1728).

import { MAX_DIFF_CHARS } from '../checkers/design-smells.js';
import {
  classifierOutcomeBucket,
  decideVerdict,
  type ClassifierOutcomeBucket,
  type ClassifierOutcomeRecord,
} from '../kpis/classifier-outcomes.js';
import { isDefectWindowClosed } from '../kpis/defects.js';
import type { PrSource } from '../kpis/human.js';
import type { ModelRouter } from '../router/index.js';
import type { FactoryEvent } from '../types/index.js';
import { classifyPrShadow, type PrShadowVerdict } from './classifier.js';
import { computeReviewFloor, type ReviewClass, type ReviewFloorFiredRule, type ReviewFloorRuleSet } from './floor.js';
import { parseNumstat } from './routing.js';

export type BacktestOutcomeLabel = 'defect' | 'clean' | 'gated' | 'pending';
export type BacktestHandLabel = Exclude<BacktestOutcomeLabel, 'pending'>;

/** One JSONL line. Extends ClassifierOutcomeRecord so summarizeClassifierOutcomes reads it as is;
 *  modelClass is widened to allow null (classifier failed), and the summary skips those. */
export interface BacktestRecord extends Omit<ClassifierOutcomeRecord, 'modelClass'> {
  modelClass: ReviewClass | null;
  mergeCommitSha: string | null;
  costUsd: number | null;
  reason?: string;
  outcomeLabel: BacktestOutcomeLabel;
  labelSource: 'hand' | 'heuristic';
}

export interface BacktestPorts {
  /** `git diff --numstat --no-renames <sha>^1 <sha>` output. */
  numstat(mergeCommitSha: string): Promise<string>;
  /** `git diff <sha>^1 <sha>` text (no truncation here; the classifier truncates). */
  diff(mergeCommitSha: string): Promise<string>;
  getIssue(issue: number): Promise<{ title: string; body: string }>;
  /** Path to state/plans/issue-<n>.md (classifyPrShadow falls back to '(no spec)' if missing). */
  specPath(issue: string): string;
  worktree: string;
  router: ModelRouter;
  modelPin?: string;
  classify?: typeof classifyPrShadow; // test seam
  /** Called once per finished record (the CLI appends it to the JSONL file). */
  onRecord?(record: BacktestRecord): void;
}

export interface BacktestResult {
  records: BacktestRecord[];
  /** PRs selected for the run. */
  candidates: number;
  spentUsd: number;
  unpricedCalls: number;
  budgetReached: boolean;
}

const HAND_LABELS: readonly string[] = ['defect', 'clean', 'gated'];

export function parseBacktestLabels(csv: string): Map<number, BacktestHandLabel> {
  const labels = new Map<number, BacktestHandLabel>();
  let first = true;
  const lines = csv.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || /^#(?!\d)/.test(line)) continue;
    const isFirst = first;
    first = false;
    if (isFirst && line.toLowerCase().replace(/\s+/g, '') === 'pr,class') continue;
    const n = i + 1;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== 2) throw new Error(`labels line ${n}: expected '<pr>,<class>'`);
    const pr = cells[0].replace(/^#/, '');
    if (!/^\d+$/.test(pr) || Number(pr) < 1) throw new Error(`labels line ${n}: invalid PR number '${cells[0]}'`);
    const cls = cells[1].toLowerCase();
    if (!HAND_LABELS.includes(cls)) {
      throw new Error(`labels line ${n}: invalid class '${cells[1]}' (expected defect|clean|gated)`);
    }
    labels.set(Number(pr), cls as BacktestHandLabel);
  }
  return labels;
}

export function selectBacktestPrs(sources: PrSource[], opts: { since: string; limit?: number }): PrSource[] {
  const sinceMs = Date.parse(opts.since);
  const selected = sources
    .filter((s) => s.mergedAt !== null && s.mergeCommitSha && Date.parse(s.mergedAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.mergedAt!) - Date.parse(b.mergedAt!) || a.prNumber - b.prNumber);
  return opts.limit === undefined ? selected : selected.slice(0, opts.limit);
}

const BUCKET_LABEL: Record<ClassifierOutcomeBucket, BacktestOutcomeLabel> = {
  slippedDefect: 'defect',
  mergedClean: 'clean',
  humanGated: 'gated',
  pending: 'pending',
};

export function buildBacktestRecord(input: {
  source: PrSource;
  verdict: PrShadowVerdict;
  events: FactoryEvent[];
  handLabel?: BacktestHandLabel;
  now: string;
  windowDays: number;
  classifiedAt: string;
}): BacktestRecord | null {
  const { source, verdict, handLabel } = input;
  if (source.mergedAt === null) return null;
  const mine = input.events.filter((e) => e.issue === source.issue);
  const mergedMs = Date.parse(source.mergedAt);
  let humanEdited = mine.some((e) => e.type === 'human-edited' && Date.parse(e.ts) <= mergedMs);
  let defectWindowClosed = isDefectWindowClosed(source.mergedAt, input.now, input.windowDays);
  let defectFired = defectWindowClosed && mine.some((e) => e.type === 'post-merge-defect');
  if (handLabel) {
    defectWindowClosed = true;
    defectFired = handLabel === 'defect';
    if (handLabel === 'clean') humanEdited = false;
    if (handLabel === 'gated') humanEdited = true;
  }
  const facts = { humanEdited, humanAbandoned: false, merged: true, defectWindowClosed, defectFired };
  const base = {
    issue: source.issue,
    prNumber: source.prNumber,
    classifiedAt: input.classifiedAt,
    modelClass: verdict.modelClass,
    floorClass: verdict.floorClass,
    finalClass: verdict.finalClass,
    model: verdict.model,
    promptVersion: verdict.promptVersion,
    policyVersion: verdict.policyVersion,
    diffSha: verdict.diffSha,
    humanApproved: mine.some((e) => e.type === 'human-approved'),
    humanEdited,
    humanAbandoned: false,
    merged: true,
    mergedAt: source.mergedAt,
    defectWindowClosed,
    defectFired,
  };
  const bucket = classifierOutcomeBucket({ ...base, modelClass: 'A', verdict: 'pending', slipped: false });
  const { verdict: v, slipped } =
    verdict.modelClass === null
      ? { verdict: 'pending' as const, slipped: false }
      : decideVerdict(verdict.modelClass, facts);
  return {
    ...base,
    verdict: v,
    slipped,
    mergeCommitSha: source.mergeCommitSha ?? null,
    costUsd: verdict.costUsd,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    outcomeLabel: BUCKET_LABEL[bucket],
    labelSource: handLabel ? 'hand' : 'heuristic',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runClassifierBacktest(
  input: {
    sources: PrSource[];
    events: FactoryEvent[];
    labels: Map<number, BacktestHandLabel>;
    rules: ReviewFloorRuleSet;
    maxCostUsd?: number;
    now: string;
    windowDays: number;
  },
  ports: BacktestPorts,
): Promise<BacktestResult> {
  const result: BacktestResult = {
    records: [],
    candidates: input.sources.length,
    spentUsd: 0,
    unpricedCalls: 0,
    budgetReached: false,
  };
  for (const source of input.sources) {
    if (input.maxCostUsd !== undefined && result.spentUsd >= input.maxCostUsd) {
      result.budgetReached = true;
      break;
    }
    const sha = source.mergeCommitSha;
    if (!sha) continue;

    let floor: ReviewClass | null = null;
    let floorRules: ReviewFloorFiredRule[] = [];
    try {
      const computed = computeReviewFloor({ changes: parseNumstat(await ports.numstat(sha)), rules: input.rules });
      floor = computed.floor;
      floorRules = computed.rules;
    } catch {
      // fail closed, like resolveReviewRouting
    }

    const issue = await ports.getIssue(Number(source.issue)).catch(() => ({ title: '', body: '' }));
    const verdict = await (ports.classify ?? classifyPrShadow)(
      {
        worktree: ports.worktree,
        issueTitle: issue.title,
        issueBody: issue.body,
        specPath: ports.specPath(source.issue),
        floor,
        floorRules,
        rules: input.rules,
        modelPin: ports.modelPin,
        router: ports.router,
      },
      {
        collectDiff: async () => {
          const baseRef = `${sha}^1`;
          try {
            const text = await ports.diff(sha);
            if (text.length > MAX_DIFF_CHARS) {
              return {
                text: `${text.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters]`,
                baseRef,
                truncated: true,
              };
            }
            return { text, baseRef, truncated: false };
          } catch (err) {
            return {
              text: '',
              baseRef: null,
              truncated: false,
              skipReason: `merge diff unavailable: ${errorMessage(err).slice(0, 200)}`,
            };
          }
        },
      },
    );

    result.spentUsd += verdict.costUsd ?? 0;
    if (verdict.costUsd === null) result.unpricedCalls++;

    const record = buildBacktestRecord({
      source,
      verdict,
      events: input.events,
      handLabel: input.labels.get(source.prNumber),
      now: input.now,
      windowDays: input.windowDays,
      classifiedAt: input.now,
    });
    if (!record) continue;
    result.records.push(record);
    ports.onRecord?.(record);
  }
  return result;
}

export function backtestFileName(now: string): string {
  return `classifier-backtest-${now.replace(/[:.]/g, '-')}.jsonl`;
}
