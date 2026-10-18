// packages/core/src/queue/queue-order.ts — Per-lane `factory:order:<n>` ordering for the GitHub queue (#824, #2977, #3101).

export const QUEUE_ORDER_LABEL_PREFIX = 'factory:order:';

/** Why a queued issue was skipped from ordering (#3192). */
export type QueueOrderLabelProblem = 'missing-order-label' | 'multiple-order-labels' | 'malformed-order-label';

/** A lane ordering problem: two or more issues share a `factory:order:<position>` label (#2977), or one issue has a missing, multiple or malformed order label and was skipped (`position: null`, `reason` set, #3192). */
export interface QueueOrderConflict {
  lane: string;
  /** The shared position; null for a skipped issue. */
  position: number | null;
  /** Every issue at `position`, ascending; the single skipped issue when `reason` is set. */
  issues: number[];
  /** Set only for a skipped issue; absent for a duplicate position. */
  reason?: QueueOrderLabelProblem;
}

function orderLabelProblem(orderLabels: string[]): QueueOrderLabelProblem | null {
  if (orderLabels.length === 0) return 'missing-order-label';
  if (orderLabels.length > 1) return 'multiple-order-labels';
  const positionText = orderLabels[0].slice(QUEUE_ORDER_LABEL_PREFIX.length);
  if (!/^[1-9]\d*$/.test(positionText) || !Number.isSafeInteger(Number(positionText))) return 'malformed-order-label';
  return null;
}

export function orderedCandidates<T extends { number: number; labels: string[] }>(
  lane: string,
  issues: T[],
  onConflict?: (conflict: QueueOrderConflict) => void,
  onMalformed?: (conflict: QueueOrderConflict) => void,
): T[] {
  const byPosition = new Map<number, T[]>();
  for (const issue of issues) {
    const orderLabels = issue.labels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
    const problem = orderLabelProblem(orderLabels);
    if (problem !== null) {
      if (onMalformed === undefined) {
        throw new Error(
          problem === 'malformed-order-label'
            ? `invalid GitHub queue state for lane ${lane}: issue #${issue.number} has malformed queue order label ${orderLabels[0]}`
            : `invalid GitHub queue state for lane ${lane}: issue #${issue.number} must have exactly one queue order label`,
        );
      }
      onMalformed({ lane, position: null, issues: [issue.number], reason: problem });
      continue;
    }
    const position = Number(orderLabels[0].slice(QUEUE_ORDER_LABEL_PREFIX.length));
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

const ORDER_PROBLEM_TEXT: Record<QueueOrderLabelProblem, string> = {
  'missing-order-label': 'has no factory:order:<n> label',
  'multiple-order-labels': 'has multiple factory:order labels',
  'malformed-order-label': 'has a malformed factory:order label',
};

/** One-line operator warning for a duplicated `factory:order:<n>` position (#3101) or a skipped issue (#3192). */
export function formatQueueOrderConflict(conflict: QueueOrderConflict): string {
  if (conflict.reason !== undefined) {
    return `lane ${conflict.lane}: issue #${conflict.issues[0]} ${ORDER_PROBLEM_TEXT[conflict.reason]} — skipped, not claimable | repair: give it exactly one ${QUEUE_ORDER_LABEL_PREFIX}<n> label or remove factory:queued`;
  }
  return `lane ${conflict.lane}: issues ${conflict.issues.map((n) => `#${n}`).join(', ')} share ${QUEUE_ORDER_LABEL_PREFIX}${conflict.position} — claimed in issue-number order | repair: give each a unique order label`;
}
