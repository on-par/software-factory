import type { EnqueueOutcome, EnqueueResult } from '@on-par/factory-core/internal';

/** One issue in `factory queue add --json` (#2275). */
export interface QueueAddIssueJson {
  number: number;
  outcome: EnqueueOutcome;
  /** 1-based order position; null when failed or the existing order label is unparsable. */
  order: number | null;
  labelsAdded: string[];
  /** Set only when outcome === 'failed'. */
  detail?: string;
}

/** `factory queue add --json` payload (#2275). Additive changes only; bump schemaVersion on a breaking change. */
export interface QueueAddJson {
  schemaVersion: 1;
  /** False when any issue failed. */
  ok: boolean;
  action: 'queue-add';
  lane: string;
  /** Input order (deduped). */
  issues: QueueAddIssueJson[];
  /** Union of per-result labelsCreated, first-seen order, deduped. */
  labelsCreated: string[];
}

export function buildQueueAddJson(lane: string, results: readonly EnqueueResult[]): QueueAddJson {
  const created = new Set<string>();
  const issues = results.map((r): QueueAddIssueJson => {
    for (const name of r.labelsCreated ?? []) created.add(name);
    const failed = r.outcome === 'failed';
    return {
      number: r.issue,
      outcome: r.outcome,
      order: failed ? null : (r.position ?? null),
      labelsAdded: failed ? [] : [...(r.labelsAdded ?? [])],
      ...(failed ? { detail: r.detail ?? '' } : {}),
    };
  });
  return {
    schemaVersion: 1,
    ok: !results.some((r) => r.outcome === 'failed'),
    action: 'queue-add',
    lane,
    issues,
    labelsCreated: [...created],
  };
}
