// packages/core/src/readiness/size.ts — the INVEST "small" rule, applied to a raw
// factory-task issue body (#605). Deliberately duplicates the thresholds in
// packages/product/src/decompose/invest.ts (MAX_IN_SCOPE / MAX_ACCEPTANCE_CRITERIA):
// core must not depend on the private @on-par/product package, and checkInvest()
// needs a parsed Story that does not exist at readiness-scoring time. Change both
// files together. Pure — no I/O.

/** More in-scope bullets than this and the issue has stopped being one slice. */
export const MAX_IN_SCOPE_ITEMS = 5;
/** More acceptance criteria than this and the issue is really several issues. */
export const MAX_ACCEPTANCE_CRITERIA_ITEMS = 5;

/**
 * Build-scope budget (Patrick, 2026-08-15): a plan whose design artifact declares
 * more surface than this is too big for one bounded BUILD pass — deepseek/openccode
 * builds can run 30-40 min on mega-slices. Park for decomposition instead of
 * handing the worker a long churn. These are deliberately tight: a healthy slice
 * touches a handful of types/signatures.
 */
export const MAX_BUILD_TARGET_TYPES = 6;
export const MAX_BUILD_SIGNATURES = 8;
export const MAX_BUILD_CALL_EDGES = 10;

export interface IssueSizeReport {
  sizeOk: boolean;
  /** Present only when sizeOk is false. */
  reason?: string;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/;
const CHECKBOX_ITEM_RE = /^ {0,3}[-*+]\s*\[[ xX]\]\s*\S/;

function countMatchingLines(section: string, re: RegExp): number {
  let count = 0;
  let inFence = false;
  for (const line of section.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (re.test(line)) count++;
  }
  return count;
}

function countListItems(section: string): number {
  return countMatchingLines(section, LIST_ITEM_RE);
}

function countCheckboxItems(section: string): number {
  return countMatchingLines(section, CHECKBOX_ITEM_RE);
}

export function checkIssueSize(input: { inScope: string; acceptanceCriteria: string }): IssueSizeReport {
  const inScopeItems = countListItems(input.inScope);
  const criteria = countCheckboxItems(input.acceptanceCriteria);
  if (inScopeItems <= MAX_IN_SCOPE_ITEMS && criteria <= MAX_ACCEPTANCE_CRITERIA_ITEMS) {
    return { sizeOk: true };
  }
  return {
    sizeOk: false,
    reason: `too big: ${inScopeItems} in-scope items, ${criteria} acceptance criteria`,
  };
}
