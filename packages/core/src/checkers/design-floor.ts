// src/checkers/design-floor.ts — review-floor class A skip for the design critic (#3374).

import {
  computeReviewFloor,
  DEFAULT_REVIEW_FLOOR_RULES,
  parseNumstat,
  type ReviewFloorPathChange,
} from '../review/floor.js';
import type { DiffRunner } from './design-smells.js';
import type { CheckerContext } from './index.js';

/** Per-file line counts for the same diff the critic sees (committed + uncommitted, DIFF_EXCLUDES);
 *  null when either numstat read fails, so the caller runs the critic (#3374). */
export async function readDesignFloorChanges(
  worktree: string,
  baseRef: string,
  run: DiffRunner,
  excludes: readonly string[],
): Promise<ReviewFloorPathChange[] | null> {
  const committed = await run(
    ['git', 'diff', '--numstat', '--no-renames', `${baseRef}...HEAD`, '--', '.', ...excludes],
    worktree,
  );
  const uncommitted = await run(['git', 'diff', '--numstat', '--no-renames', 'HEAD', '--', '.', ...excludes], worktree);
  if (!committed.ok || !uncommitted.ok) return null;
  return [...parseNumstat(committed.stdout), ...parseNumstat(uncommitted.stdout)];
}

/** SKIP details when the diff is review floor A (docs-only / tests-only: no program design to critique);
 *  null when the critic should run, including on any read failure (fail closed). */
export async function designFloorSkip(
  ctx: CheckerContext,
  baseRef: string,
  run: DiffRunner,
  excludes: readonly string[],
): Promise<string | null> {
  let changes: ReviewFloorPathChange[] | null;
  try {
    changes = await readDesignFloorChanges(ctx.worktree, baseRef, run, excludes);
  } catch {
    return null;
  }
  if (changes === null) return null;
  const floor = computeReviewFloor({ changes, rules: ctx.reviewFloorRules ?? DEFAULT_REVIEW_FLOOR_RULES });
  if (floor.floor !== 'A') return null;
  return `review floor A (${floor.rules.map((r) => r.id).join(',')}): design critic skipped`;
}
