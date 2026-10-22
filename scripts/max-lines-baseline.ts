// scripts/max-lines-baseline.ts — Find max-lines baseline entries that must be removed (#2778).
//
// max-lines-baseline.json gives each grandfathered file its own ceiling. Once a file is back
// at or under the limit, or deleted, its entry must go, so the ceiling returns to 500.
// Every failure message points to the fix-up steps in MAX_LINES_DOCS (#2779).

/** The repo-wide max-lines limit (#2776). Matches the default rule in oxlint.config.ts. */
export const MAX_LINES_LIMIT = 500;

/** Where the max-lines guard and its fix-up steps are documented (#2779). */
export const MAX_LINES_DOCS = '.claude/skills/verify/SKILL.md#max-lines-guard';

/** The PR label a human applies to approve a raised or added baseline entry (#3466). */
export const MAX_LINES_OVERRIDE_LABEL = 'max-lines:override';

/** Where the human override is documented (#3466). */
export const MAX_LINES_OVERRIDE_DOCS = '.claude/skills/verify/SKILL.md#human-override';

/** Message for a file over the limit that is not in the baseline. */
export function oversizedFileMessage(path: string, count: number): string {
  return `${path} is ${count} lines (limit ${MAX_LINES_LIMIT}); split it into files of ${MAX_LINES_LIMIT} lines or fewer, never add it to max-lines-baseline.json; see ${MAX_LINES_DOCS}`;
}

/** Message for a baseline file that grew past its recorded ceiling. */
export function grownBaselineMessage(path: string, count: number, recorded: number): string {
  return `${path} grew to ${count} lines, over its max-lines-baseline.json ceiling of ${recorded}; shrink or split it back to ${recorded} or fewer, never raise the ceiling, or ask a human to apply the ${MAX_LINES_OVERRIDE_LABEL} label (${MAX_LINES_OVERRIDE_DOCS}); see ${MAX_LINES_DOCS}`;
}

/**
 * One message per baseline entry that must be removed, in baseline order: the file no longer
 * exists (countLines returns undefined) or is now MAX_LINES_LIMIT lines or fewer.
 */
export function staleBaselineEntries(
  baseline: Readonly<Record<string, number>>,
  countLines: (path: string) => number | undefined,
): string[] {
  const messages: string[] = [];
  for (const path of Object.keys(baseline)) {
    const count = countLines(path);
    if (count === undefined) {
      messages.push(`${path} no longer exists; remove it from max-lines-baseline.json; see ${MAX_LINES_DOCS}`);
    } else if (count <= MAX_LINES_LIMIT) {
      messages.push(
        `${path} is now ${count} lines (${MAX_LINES_LIMIT} or fewer); remove it from max-lines-baseline.json; see ${MAX_LINES_DOCS}`,
      );
    }
  }
  return messages;
}
