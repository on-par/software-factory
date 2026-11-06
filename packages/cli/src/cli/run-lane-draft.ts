/** The event text for a PR SHIP left as a draft: `landing` is a CI-pending draft that enters the land path (#3968). */
export function draftLeftMessage(prNumber: number | undefined, ciPending: boolean, landing: boolean): string {
  if (landing) return `PR #${prNumber} left as draft — CI pending; landing it (#3968)`;
  return ciPending
    ? `PR #${prNumber} left as draft — CI pending; the between-issue sweep lands it once CI passes`
    : `PR #${prNumber} left as draft — merge skipped (draft wins over auto-merge); mark it ready for review to land it`;
}
