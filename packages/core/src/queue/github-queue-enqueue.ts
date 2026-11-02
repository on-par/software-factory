// packages/core/src/queue/github-queue-enqueue.ts — GitHub queue enqueue paths: tail append and front placement (#3539, #3552).

import { orderCollisionAt, scanLaneOrders } from './order-collision.js';
import { dedupeOrderLabels, repairOrderCollision, type OrderCollisionRepair } from './order-repair.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';
import {
  laneLabel,
  QUEUED_LABEL,
  QUEUED_LABEL_COLOR,
  LANE_LABEL_COLOR,
  queueOrderLabelSpec,
  type EnqueueOptions,
  type EnqueueResult,
  type QueueGitHubClient,
  type QueueLabelSpec,
} from './github-queue.js';

export interface FrontEnqueueResult {
  /** One per input issue, in input order. */
  results: EnqueueResult[];
  /** 'front': issues took orders 1..k and every other in-lane order moved up; 'tail': the shift failed and they were appended. */
  placement: 'front' | 'tail';
  detail?: string;
}

function queueSpecs(lane: string, position: number): QueueLabelSpec[] {
  return [
    { name: QUEUED_LABEL, color: QUEUED_LABEL_COLOR, description: 'Eligible to be claimed by a factory lane' },
    { name: laneLabel(lane), color: LANE_LABEL_COLOR, description: `Routed to factory lane ${lane}` },
    queueOrderLabelSpec(position),
  ];
}

/** The position in a `factory:order:<n>` label, or undefined when it is not a positive safe integer. */
function orderOf(label: string): number | undefined {
  const n = Number(label.slice(QUEUE_ORDER_LABEL_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createEnqueuers(
  client: QueueGitHubClient,
  owner: string,
  repo: string,
  hooks?: { onOrderRepair?: (repair: OrderCollisionRepair) => void },
) {
  async function enqueue(
    lane: string,
    issues: readonly number[],
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult[]> {
    const members = await client.listOpenIssuesWithLabels({ owner, repo, labels: [laneLabel(lane)] });
    const { requireMember, preferOrder } = options;
    if (requireMember !== undefined && !members.some((m) => m.number === requireMember)) {
      return issues.map((issue) => ({
        issue,
        outcome: 'failed' as const,
        detail: `lane scan for ${laneLabel(lane)} returned ${members.length} issue(s) and omitted #${requireMember}, which carries the lane label; refusing to place it (fail closed, #3554)`,
      }));
    }
    // A single issue may take its park-time order when no other lane member holds it (#3554).
    const only = issues.length === 1 ? issues[0] : undefined;
    const wantsOrder =
      only !== undefined && preferOrder !== undefined && Number.isSafeInteger(preferOrder) && preferOrder > 0;
    const holders = wantsOrder
      ? members
          .filter(
            (m) =>
              m.number !== only &&
              m.labels.some((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX) && orderOf(label) === preferOrder),
          )
          .map((m) => m.number)
          .sort((a, b) => a - b)
      : [];
    const useRequested = wantsOrder && holders.length === 0;
    const scan = scanLaneOrders(members, QUEUED_LABEL, QUEUE_ORDER_LABEL_PREFIX); // tolerant, every open in-lane holder (#2987, #2988)
    let next = scan.maxPos + 1;
    let naive = scan.queuedMax + 1;

    const results: EnqueueResult[] = [];
    for (const issue of issues) {
      try {
        const current = await client.getIssueLabels({ owner, repo, issue_number: issue });
        if (current.some((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX))) {
          const orderLabel = current.find((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX)) ?? '';
          const parsed = Number(orderLabel.slice(QUEUE_ORDER_LABEL_PREFIX.length));
          // A double unpark can leave two order labels; keep one so the lane never stalls (#3147).
          const kept = await dedupeOrderLabels(client, owner, repo, issue);
          const existing = kept ?? parsed;
          results.push({
            issue,
            outcome: 'already-queued',
            ...(Number.isSafeInteger(existing) && existing > 0 ? { position: existing } : {}),
            labelsAdded: [],
            labelsCreated: [],
          });
          continue;
        }
        const position = useRequested ? (preferOrder ?? next) : next;
        const specs = queueSpecs(lane, position);
        const created: string[] = [];
        for (const spec of specs) {
          if (await client.ensureLabel({ owner, repo, ...spec })) created.push(spec.name);
        }
        await client.addLabels({ owner, repo, issue_number: issue, labels: specs.map((s) => s.name) });
        const collision = orderCollisionAt(scan, naive);
        // Converge after the optimistic write: one order label, and no shared position with a lower issue (#3147).
        const kept = await dedupeOrderLabels(client, owner, repo, issue);
        const repair =
          kept === undefined
            ? undefined
            : await repairOrderCollision({
                client,
                owner,
                repo,
                lane,
                issue,
                position: kept,
                onRepair: hooks?.onOrderRepair,
              });
        results.push({
          issue,
          outcome: 'queued',
          position: repair?.position ?? position,
          ...(repair && repair.repairs.length > 0 ? { repaired: repair.repairs } : {}),
          labelsAdded: specs.map((s) => s.name).filter((name) => !current.includes(name)),
          labelsCreated: created,
          ...(collision && !useRequested ? { collision } : {}),
          ...(wantsOrder && holders.length > 0 ? { preferredOrderHeldBy: holders } : {}),
        });
        if (!useRequested) {
          next += 1;
          naive += 1;
        }
      } catch (err) {
        results.push({ issue, outcome: 'failed', detail: errorMessage(err) });
      }
    }
    return results;
  }

  /** Queues `issues` at orders p+1..p+k of the lane, shifting later in-lane orders (not in `exclude`) up by k. */
  async function insertAfter(
    lane: string,
    p: number,
    issues: readonly number[],
    exclude: ReadonlySet<number>,
  ): Promise<{ results: EnqueueResult[]; tail: boolean; detail?: string }> {
    const members = await client.listOpenIssuesWithLabels({ owner, repo, labels: [laneLabel(lane)] });
    const done = new Map<number, EnqueueResult>();
    const toQueue: number[] = [];
    for (const issue of issues) {
      try {
        const current = await client.getIssueLabels({ owner, repo, issue_number: issue });
        const orderLabel = current.find((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
        if (orderLabel === undefined) {
          toQueue.push(issue);
          continue;
        }
        const existing = orderOf(orderLabel);
        done.set(issue, {
          issue,
          outcome: 'already-queued',
          ...(existing === undefined ? {} : { position: existing }),
          labelsAdded: [],
          labelsCreated: [],
        });
      } catch (err) {
        done.set(issue, { issue, outcome: 'failed', detail: errorMessage(err) });
      }
    }
    const inOrder = (): EnqueueResult[] => issues.flatMap((issue) => done.get(issue) ?? []);
    const k = toQueue.length;
    if (k === 0) return { results: inOrder(), tail: false };

    // Members with a malformed or multiple order label are left alone: they are already unclaimable.
    const shifted = members
      .filter((m) => !exclude.has(m.number))
      .flatMap((m) => {
        const orders = m.labels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
        const pos = orders.length === 1 ? orderOf(orders[0] ?? '') : undefined;
        return pos !== undefined && pos > p ? [{ issue: m.number, pos, old: orders[0] ?? '' }] : [];
      })
      .sort((a, b) => b.pos - a.pos || a.issue - b.issue);
    try {
      // Highest order first, new label before the old one is removed: a partial failure shows as a conflict, not a loss.
      for (const item of shifted) {
        const spec = queueOrderLabelSpec(item.pos + k);
        await client.ensureLabel({ owner, repo, ...spec });
        await client.addLabels({ owner, repo, issue_number: item.issue, labels: [spec.name] });
        await client.removeLabel({ owner, repo, issue_number: item.issue, name: item.old });
      }
    } catch (err) {
      for (const r of await enqueue(lane, toQueue)) done.set(r.issue, r);
      return { results: inOrder(), tail: true, detail: errorMessage(err) };
    }

    for (const [j, issue] of toQueue.entries()) {
      try {
        const specs = queueSpecs(lane, p + 1 + j);
        const created: string[] = [];
        for (const spec of specs) {
          if (await client.ensureLabel({ owner, repo, ...spec })) created.push(spec.name);
        }
        const names = specs.map((s) => s.name);
        await client.addLabels({ owner, repo, issue_number: issue, labels: names });
        done.set(issue, { issue, outcome: 'queued', position: p + 1 + j, labelsAdded: names, labelsCreated: created });
      } catch (err) {
        done.set(issue, { issue, outcome: 'failed', detail: errorMessage(err) });
      }
    }
    return { results: inOrder(), tail: false };
  }

  async function enqueueFront(lane: string, issues: readonly number[]): Promise<FrontEnqueueResult> {
    const out = await insertAfter(lane, 0, issues, new Set(issues));
    return {
      results: out.results,
      placement: out.tail ? 'tail' : 'front',
      ...(out.detail ? { detail: out.detail } : {}),
    };
  }

  return { enqueue, enqueueFront };
}
