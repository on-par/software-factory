// scripts/max-lines-baseline.ts — Find max-lines baseline entries that must be removed (#2778).
//
// max-lines-baseline.json gives each grandfathered file its own ceiling. Once a file is back
// at or under the limit, or deleted, its entry must go, so the ceiling returns to 500.

/** The repo-wide max-lines limit (#2776). Matches the default rule in oxlint.config.ts. */
export const MAX_LINES_LIMIT = 500;

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
      messages.push(`${path} no longer exists; remove it from max-lines-baseline.json`);
    } else if (count <= MAX_LINES_LIMIT) {
      messages.push(
        `${path} is now ${count} lines (${MAX_LINES_LIMIT} or fewer); remove it from max-lines-baseline.json`,
      );
    }
  }
  return messages;
}
