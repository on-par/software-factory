import {
  computeReviewFloor,
  DEFAULT_REVIEW_FLOOR_RULES,
  parseNumstat,
  type ReviewFloorPathChange,
} from '../review/floor.js';
import type { DiffRunner } from './design-smells.js';
import type { CheckerContext } from './index.js';

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
