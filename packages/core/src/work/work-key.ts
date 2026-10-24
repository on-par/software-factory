// packages/core/src/work/work-key.ts — tracker-native work identity (ADR-0168).

declare const workKeyBrand: unique symbol;

/** Native display key of a ticket: "123" for GitHub, "PROJ-123" for Jira. No tracker prefix (ADR-0168 §3). */
export type WorkKey = string & { readonly [workKeyBrand]: true };

/** Key of a GitHub issue number; throws RangeError unless it is a non-negative safe integer. */
export function workKeyFromIssue(issue: number): WorkKey {
  if (!Number.isSafeInteger(issue) || issue < 0) {
    throw new RangeError(`issue number must be a non-negative safe integer, got ${issue}`);
  }
  return String(issue) as WorkKey;
}

/** Validates a tracker-native key (branch- and path-safe) without changing its case. */
export function toWorkKey(raw: string): WorkKey {
  const key = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new Error(
      `invalid work key "${raw}": expected letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }
  return key as WorkKey;
}

/** True when the key is a canonical non-negative decimal integer (a GitHub issue number). */
export function isNumericWorkKey(key: WorkKey): boolean {
  return /^\d+$/.test(key) && String(Number(key)) === key;
}

/** The only sanctioned path from a key to an Octokit `issue_number`; throws for non-numeric keys. */
export function issueNumberOf(key: WorkKey): number {
  if (!isNumericWorkKey(key)) throw new Error(`work key "${key}" is not a numeric GitHub issue number`);
  return Number(key);
}
