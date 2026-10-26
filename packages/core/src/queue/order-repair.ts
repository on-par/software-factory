// packages/core/src/queue/order-repair.ts — post-write convergence for enqueue: one order label per issue, one issue per position (#3147).
//
// Two hosts enqueueing into one lane can pick the same max+1, and two unparks of one issue can each add an
// order label. Enqueue writes optimistically, then calls these helpers. A collision is always resolved by
// moving the higher-numbered issue, so hosts never move an issue in opposite directions.

import { notFoundError } from './github-errors.js';
import { laneLabel, QUEUED_LABEL, queueOrderLabelSpec, type QueueGitHubClient } from './github-queue.js';
import { scanLaneOrders } from './order-collision.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';

export const MAX_ORDER_REPAIR_ATTEMPTS = 3;

export interface OrderCollisionRepair {
  lane: string;
  issue: number;
  from: number;
  to: number;
  /** The other lane members that held `from`. */
  sharedWith: number[];
  attempt: number;
  /** Set on the final record when the attempts ran out with the collision still present. */
  exhausted?: boolean;
}

/** The position of a valid `factory:order:<n>` label, or undefined when malformed. */
function validPosition(label: string): number | undefined {
  const text = label.slice(QUEUE_ORDER_LABEL_PREFIX.length);
  const n = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(n) ? n : undefined;
}

const goneError = (err: unknown): boolean => notFoundError(err) || (err as { status?: unknown }).status === 410;

async function removeIfPresent(
  client: Pick<QueueGitHubClient, 'removeLabel'>,
  owner: string,
  repo: string,
  issue: number,
  name: string,
): Promise<void> {
  try {
    await client.removeLabel({ owner, repo, issue_number: issue, name });
  } catch (err) {
    if (!goneError(err)) throw err;
  }
}

/** Keeps the lowest valid order label on `issue` and removes every other one; returns its position, or undefined when none is valid. */
export async function dedupeOrderLabels(
  client: Pick<QueueGitHubClient, 'getIssueLabels' | 'removeLabel'>,
  owner: string,
  repo: string,
  issue: number,
): Promise<number | undefined> {
  const labels = (await client.getIssueLabels({ owner, repo, issue_number: issue })).filter((l) =>
    l.startsWith(QUEUE_ORDER_LABEL_PREFIX),
  );
  const valid = labels.flatMap((name) => {
    const position = validPosition(name);
    return position === undefined ? [] : [{ name, position }];
  });
  if (valid.length === 0) return undefined;
  const keep = valid.reduce((lo, v) => (v.position < lo.position ? v : lo));
  for (const name of labels) {
    if (name !== keep.name) await removeIfPresent(client, owner, repo, issue, name);
  }
  return keep.position;
}

export async function repairOrderCollision(input: {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  lane: string;
  issue: number;
  position: number;
  onRepair?: (repair: OrderCollisionRepair) => void;
}): Promise<{ position: number; repairs: OrderCollisionRepair[] }> {
  const { client, owner, repo, lane, issue, onRepair } = input;
  let position = input.position;
  const repairs: OrderCollisionRepair[] = [];
  const record = (repair: OrderCollisionRepair): void => {
    repairs.push(repair);
    onRepair?.(repair);
  };
  // Other open lane members whose single valid order label is `position`, split by issue number.
  const scanSharers = async () => {
    const members = await client.listOpenIssuesWithLabels({ owner, repo, labels: [laneLabel(lane)] });
    const sharers = members
      .filter((m) => m.number !== issue)
      .filter((m) => {
        const orders = m.labels.filter((l) => l.startsWith(QUEUE_ORDER_LABEL_PREFIX));
        return orders.length === 1 && validPosition(orders[0] ?? '') === position;
      })
      .map((m) => m.number)
      .sort((a, b) => a - b);
    return { lower: sharers.filter((n) => n < issue), higher: sharers.filter((n) => n > issue), members };
  };
  // Add the new label first, then drop the old one: a partial failure shows as a conflict, never a lost order.
  const move = async (target: number, from: number, to: number): Promise<number> => {
    const spec = queueOrderLabelSpec(to);
    await client.ensureLabel({ owner, repo, ...spec });
    await client.addLabels({ owner, repo, issue_number: target, labels: [spec.name] });
    await removeIfPresent(client, owner, repo, target, queueOrderLabelSpec(from).name);
    return (await dedupeOrderLabels(client, owner, repo, target)) ?? to;
  };

  for (let attempt = 1; attempt <= MAX_ORDER_REPAIR_ATTEMPTS; attempt++) {
    const { lower, higher, members } = await scanSharers();
    if (lower.length === 0 && higher.length === 0) return { position, repairs };
    const max = scanLaneOrders(members, QUEUED_LABEL, QUEUE_ORDER_LABEL_PREFIX).maxPos;
    if (lower.length > 0) {
      const to = max + 1;
      const kept = await move(issue, position, to);
      record({ lane, issue, from: position, to, sharedWith: lower, attempt });
      position = kept;
      continue;
    }
    // Only higher-numbered issues share the position. Their own enqueuer moves them when its scan saw this
    // write, but its scan may have run before it; the lower issue is the deterministic fixer (#3147).
    for (const [i, other] of higher.entries()) {
      const to = max + 1 + i;
      await move(other, position, to);
      record({ lane, issue: other, from: position, to, sharedWith: [issue], attempt });
    }
  }
  const { lower, higher } = await scanSharers();
  if (lower.length > 0 || higher.length > 0) {
    const attempt = MAX_ORDER_REPAIR_ATTEMPTS;
    record({ lane, issue, from: position, to: position, sharedWith: [...lower, ...higher], attempt, exhausted: true });
  }
  return { position, repairs };
}
