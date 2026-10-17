// packages/core/src/queue/queue-order.ts — Per-lane `factory:order:<n>` ordering for the GitHub queue (#824, #2977, #3101).

export const QUEUE_ORDER_LABEL_PREFIX = 'factory:order:';

/** Two or more queued issues in one lane share a `factory:order:<position>` label (#2977). */
export interface QueueOrderConflict {
  lane: string;
  position: number;
  /** Every issue at `position`, ascending. */
  issues: number[];
}

export function orderedCandidates<T extends { number: number; labels: string[] }>(
  lane: string,
  issues: T[],
  onConflict?: (conflict: QueueOrderConflict) => void,
): T[] {
  const byPosition = new Map<number, T[]>();
  for (const issue of issues) {
    const orderLabels = issue.labels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
    if (orderLabels.length !== 1) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} must have exactly one queue order label`,
      );
    }

    const positionText = orderLabels[0].slice(QUEUE_ORDER_LABEL_PREFIX.length);
    if (!/^[1-9]\d*$/.test(positionText)) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} has malformed queue order label ${orderLabels[0]}`,
      );
    }
    const position = Number(positionText);
    if (!Number.isSafeInteger(position)) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} has malformed queue order label ${orderLabels[0]}`,
      );
    }
    const group = byPosition.get(position);
    if (group === undefined) byPosition.set(position, [issue]);
    else group.push(issue);
  }

  const kept: T[] = [];
  for (const [position, group] of [...byPosition].sort((a, b) => a[0] - b[0])) {
    if (group.length >= 2) {
      const sorted = [...group].sort((a, b) => a.number - b.number);
      onConflict?.({ lane, position, issues: sorted.map((i) => i.number) });
      kept.push(...sorted);
    } else {
      kept.push(group[0]);
    }
  }
  return kept;
}

/** One-line operator warning for a duplicated `factory:order:<n>` position (#3101). */
export function formatQueueOrderConflict(conflict: QueueOrderConflict): string {
  return `lane ${conflict.lane}: issues ${conflict.issues.map((n) => `#${n}`).join(', ')} share ${QUEUE_ORDER_LABEL_PREFIX}${conflict.position} — claimed in issue-number order | repair: give each a unique order label`;
}
