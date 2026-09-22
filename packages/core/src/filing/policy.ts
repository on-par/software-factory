// src/filing/policy.ts — Self-fix merge gate (#374).
//
// A PR carrying the configured self-fix label (default `no-auto-merge`) must not be
// auto-merged: the merge path waits for a human instead. The fingerprinted
// auto-filing loop this label was originally paired with was removed (2026-09);
// only the merge gate is wired.

export interface FilingPolicy {
  selfFixLabel: string; // label that refuses auto-merge, e.g. 'no-auto-merge'
}

export function isAutoMergeBlocked(labels: readonly string[], policy: FilingPolicy): boolean {
  return labels.includes(policy.selfFixLabel);
}
