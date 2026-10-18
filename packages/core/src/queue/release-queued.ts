// packages/core/src/queue/release-queued.ts — the add-queued half of release(issue, 'queued') (#3193).

import { scanLaneOrders } from './order-collision.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';
import {
  LANE_LABEL_PREFIX,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueLabelSpecs,
  queueOrderLabelSpec,
  type QueueGitHubClient,
} from './github-queue.js';

function isValidOrderLabel(name: string): boolean {
  const position = Number(name.slice(QUEUE_ORDER_LABEL_PREFIX.length));
  return Number.isSafeInteger(position) && position > 0;
}

/**
 * Re-queues a released issue without ever writing a malformed queue entry: a parked issue stays unqueued,
 * a valid order position is kept, and a missing or invalid one is replaced by the lane tail. An issue with
 * no single lane label cannot be placed and is left unqueued.
 */
export async function addQueuedOnRelease(
  client: QueueGitHubClient,
  owner: string,
  repo: string,
  issue: number,
  current: readonly string[],
): Promise<void> {
  if (current.includes(PARKED_LABEL)) return;

  const queuedSpec = queueLabelSpecs('release', '').find((spec) => spec.name === QUEUED_LABEL);
  if (!queuedSpec) return;

  const orderLabels = current.filter((name) => name.startsWith(QUEUE_ORDER_LABEL_PREFIX));
  if (orderLabels.length === 1 && isValidOrderLabel(orderLabels[0] ?? '')) {
    if (!current.includes(QUEUED_LABEL)) {
      await client.ensureLabel({ owner, repo, ...queuedSpec });
      await client.addLabels({ owner, repo, issue_number: issue, labels: [QUEUED_LABEL] });
    }
    return;
  }

  const laneLabels = current.filter((name) => name.startsWith(LANE_LABEL_PREFIX));
  const [lane] = laneLabels;
  if (laneLabels.length !== 1 || lane === undefined) return;

  for (const name of orderLabels) {
    await client.removeLabel({ owner, repo, issue_number: issue, name });
  }
  const members = (await client.listOpenIssuesWithLabels({ owner, repo, labels: [lane] })).filter(
    (member) => member.number !== issue,
  );
  const position = scanLaneOrders(members, QUEUED_LABEL, QUEUE_ORDER_LABEL_PREFIX).maxPos + 1;
  const specs = [queuedSpec, queueOrderLabelSpec(position)];
  for (const spec of specs) {
    await client.ensureLabel({ owner, repo, ...spec });
  }
  await client.addLabels({ owner, repo, issue_number: issue, labels: specs.map((spec) => spec.name) });
}
