import type { EnqueueResult } from '@on-par/factory-core/internal';
import type { QueueAddIssueJson, QueueAddJson } from './json-contract.js';

export type { QueueAddIssueJson, QueueAddJson } from './json-contract.js';

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
      ...(!failed && r.collision ? { collision: r.collision } : {}),
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
