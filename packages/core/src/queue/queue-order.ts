// packages/core/src/queue/queue-order.ts — Per-lane `factory:order:<n>` ordering for the GitHub queue (#824, #2977).

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
      onConflict?.({ lane, position, issues: group.map((i) => i.number).sort((a, b) => a - b) });
    } else {
      kept.push(group[0]);
    }
  }
  return kept;
}
