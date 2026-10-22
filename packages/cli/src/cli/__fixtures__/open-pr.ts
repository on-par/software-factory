/**
 * The open PR for issue #5 as `pulls.list` returns it. A `head: owner:branch` filter (land's by-branch lookup) gets a
 * same-repo PR on that branch; the unfiltered list (adoption, by-issue lookup) gets a PR with no head repo (#3439).
 */
export function openPrFixture(head?: string) {
  if (!head) return { number: 77, head: { ref: 'factory/5-fix-the-bug' }, body: 'Closes #5' };
  const ref = head.slice(head.indexOf(':') + 1);
  return {
    number: 77,
    head: { ref, repo: { full_name: 'on-par/software-factory' }, sha: 'abc123' },
    body: 'Closes #5',
  };
}
