// packages/core/src/readiness/size.ts — the INVEST "small" rule, applied to a raw
// factory-task issue body (#605). Deliberately duplicates the thresholds in
// packages/product/src/decompose/invest.ts (MAX_IN_SCOPE / MAX_ACCEPTANCE_CRITERIA):
// core must not depend on the private @on-par/product package, and checkInvest()
// needs a parsed Story that does not exist at readiness-scoring time. Change both
// files together. The 5/5 counts now only produce a `size_hint` and no longer gate PLAN (#3350).
// Only top-level list items count (nested sub-bullets elaborate their parent), and a
// `spike`-labeled issue is exempt (#748).

import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DesignArtifact } from '../types/index.js';

/** More in-scope bullets than this and the issue has stopped being one slice. */
export const MAX_IN_SCOPE_ITEMS = 5;
/** More acceptance criteria than this and the issue is really several issues. */
export const MAX_ACCEPTANCE_CRITERIA_ITEMS = 5;

export const DEFAULT_TOKEN_BUDGET = 150_000;
export const DEFAULT_MAX_FILES = 12;
/** A plan changing this many files or fewer never splits (#3350). */
export const NEVER_SPLIT_MAX_FILES = 3;
/** Output allowance per changed/added file, in tokens. */
export const OUTPUT_TOKENS_PER_CHANGED_FILE = 4_000;

export interface SizeBudget {
  tokenBudget: number;
  maxFiles: number;
}

export interface PlanSizeEstimate {
  /** Distinct repo-relative paths with kind added|changed (signature files count as changed). */
  changedFiles: string[];
  /** Colocated test file for each changed non-test .ts/.tsx file. */
  testFiles: string[];
  /** Distinct kind:read paths not already in changedFiles. */
  readFiles: string[];
  /** ceil(bytes of existing changed+test+read files / 4) plus a per-changed-file output allowance. */
  estimatedTokens: number;
}

function defaultFileSize(absPath: string): number | undefined {
  try {
    return statSync(absPath).size;
  } catch {
    return undefined;
  }
}

function normalisePlanPath(worktree: string, file: string): string | null {
  const trimmed = file.trim().replace(/^\.\//, '');
  if (trimmed === '' || isAbsolute(trimmed)) return null;
  const rel = relative(resolve(worktree), resolve(worktree, trimmed));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return trimmed;
}

const TEST_FILE_RE = /\.test\.tsx?$/;

function colocatedTest(file: string): string | null {
  if (TEST_FILE_RE.test(file)) return null;
  const m = /^(.*)\.(tsx?)$/.exec(file);
  return m ? `${m[1]}.test.${m[2]}` : null;
}

/** Deterministic size of the planned change from the design artifact's named files (#3350). Pure apart from stat. */
export function estimatePlanSize(
  design: Pick<DesignArtifact, 'targetTypes' | 'signatures'>,
  deps: { worktree: string; fileSize?: (absPath: string) => number | undefined },
): PlanSizeEstimate {
  const fileSize = deps.fileSize ?? defaultFileSize;
  const changed = new Set<string>();
  const read = new Set<string>();
  for (const t of design.targetTypes) {
    const p = normalisePlanPath(deps.worktree, t.file);
    if (p === null) continue;
    if (t.kind === 'read') read.add(p);
    else changed.add(p);
  }
  for (const s of design.signatures) {
    const p = normalisePlanPath(deps.worktree, s.file);
    if (p !== null) changed.add(p);
  }
  const tests = new Set<string>();
  for (const f of changed) {
    const t = colocatedTest(f);
    if (t !== null && !changed.has(t)) tests.add(t);
  }
  const readFiles = [...read].filter((f) => !changed.has(f));
  const changedFiles = [...changed];
  const testFiles = [...tests];
  let bytes = 0;
  for (const f of [...changedFiles, ...testFiles, ...readFiles]) {
    bytes += fileSize(resolve(deps.worktree, f)) ?? 0;
  }
  return {
    changedFiles,
    testFiles,
    readFiles,
    estimatedTokens: Math.ceil(bytes / 4) + changedFiles.length * OUTPUT_TOKENS_PER_CHANGED_FILE,
  };
}

/** A reason naming the estimate and the budget when the plan is too big for one bounded BUILD, else null. */
export function planOverBudget(estimate: PlanSizeEstimate, budget: SizeBudget): string | null {
  const n = estimate.changedFiles.length;
  if (n <= NEVER_SPLIT_MAX_FILES) return null;
  if (estimate.estimatedTokens > budget.tokenBudget || n > budget.maxFiles) {
    return `plan estimate ${estimate.estimatedTokens} tokens (budget ${budget.tokenBudget}), ${n} changed files (max ${budget.maxFiles})`;
  }
  return null;
}

export interface IssueSizeReport {
  sizeOk: boolean;
  /** Present only when sizeOk is false. */
  reason?: string;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_MARKER_RE = /^( *)(?:[-*+]|\d+[.)])\s+\S/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/;
const CHECKBOX_ITEM_RE = /^ {0,3}[-*+]\s*\[[ xX]\]\s*\S/;
/** The label that marks an investigation issue; its lists are questions, not scope (#748). */
export const SPIKE_LABEL = 'spike';

export function isSpikeIssue(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l.trim().toLowerCase() === SPIKE_LABEL);
}

/** Counts top-level list items matching itemRe; deeper-indented sub-bullets are details of their parent (#748). */
function countTopLevelItems(section: string, itemRe: RegExp): number {
  let count = 0;
  let inFence = false;
  let top: number | null = null;
  for (const line of section.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const expanded = line.replace(/\t/g, '    ');
    const m = LIST_MARKER_RE.exec(expanded);
    if (!m) continue;
    const indent = m[1].length;
    if (top === null ? indent > 3 : indent > top) continue;
    top = indent;
    if (itemRe.test(expanded)) count++;
  }
  return count;
}

export function checkIssueSize(input: {
  inScope: string;
  acceptanceCriteria: string;
  labels?: readonly string[];
}): IssueSizeReport {
  if (isSpikeIssue(input.labels)) return { sizeOk: true };
  const inScopeItems = countTopLevelItems(input.inScope, LIST_ITEM_RE);
  const criteria = countTopLevelItems(input.acceptanceCriteria, CHECKBOX_ITEM_RE);
  if (inScopeItems <= MAX_IN_SCOPE_ITEMS && criteria <= MAX_ACCEPTANCE_CRITERIA_ITEMS) {
    return { sizeOk: true };
  }
  return {
    sizeOk: false,
    reason: `too big: ${inScopeItems} in-scope items, ${criteria} acceptance criteria`,
  };
}
