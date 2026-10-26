// packages/core/src/queue/github-queue-enqueue.ts — GitHub queue enqueue paths: tail append and right-behind-the-parent placement (#3539).

import { notFoundError } from './github-errors.js';
import {
  orderCollisionAt,
  scanLaneOrders,
  type EnqueueSettleOptions,
  type OrderCollisionRepair,
} from './order-collision.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';
import {
  IN_PROGRESS_LABEL,
  laneLabel,
  QUEUED_LABEL,
  QUEUED_LABEL_COLOR,
  LANE_LABEL_COLOR,
  queueOrderLabel,
  queueOrderLabelSpec,
  type EnqueueOptions,
  type EnqueueResult,
  type QueueGitHubClient,
  type QueueLabelSpec,
} from './github-queue.js';

export interface ChildEnqueueResult {
  /** One per input issue, in input (build) order. */
  results: EnqueueResult[];
  /** 'after-parent': children took orders p+1..p+k behind the parent's factory:order:p.
   *  'tail': parent had no single valid order label, or the shift failed; children were appended via enqueue. */
  placement: 'after-parent' | 'tail';
  /** Set only when the shift of later in-lane issues failed (placement is then 'tail'). */
  detail?: string;
}

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

/** Settle re-checks per enqueued issue: collapse, re-scan, repair (#3147). */
const MAX_ORDER_SETTLE_ATTEMPTS = 3;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createEnqueuers(
  client: QueueGitHubClient,
  owner: string,
  repo: string,
  { onOrderCollisionRepaired }: EnqueueSettleOptions = {},
) {
  async function removeIfPresent(issue: number, name: string): Promise<void> {
    try {
      await client.removeLabel({ owner, repo, issue_number: issue, name });
    } catch (err) {
      if (!notFoundError(err)) throw err; // already removed by a concurrent repairer
    }
  }

  /** Keeps the lowest valid order label on `issue`, removing the rest; returns the kept position (#3147). */
  async function collapse(issue: number): Promise<number | undefined> {
    const orders = (await client.getIssueLabels({ owner, repo, issue_number: issue })).filter((label) =>
      label.startsWith(QUEUE_ORDER_LABEL_PREFIX),
    );
    const keep = orders
      .flatMap((name) => orderOf(name) ?? [])
      .sort((a, b) => a - b)
      .at(0);
    if (keep === undefined) return undefined;
    const keepName = orders.find((name) => orderOf(name) === keep);
    for (const name of orders) if (name !== keepName) await removeIfPresent(issue, name);
    return keep;
  }

  /**
   * Post-write settle (#3147): collapses several order labels to the lowest, then re-scans the lane and, when
   * `issue`'s position is shared, moves every other movable (queued, unclaimed) holder to a fresh max + 1. Bounded.
   * The lowest-numbered non-movable holder (else lowest-numbered) keeps the position.
   */
  async function settleOrder(
    lane: string,
    issue: number,
  ): Promise<{ position?: number; repairs: OrderCollisionRepair[] }> {
    const repairs: OrderCollisionRepair[] = [];
    for (let attempt = 1; attempt <= MAX_ORDER_SETTLE_ATTEMPTS; attempt++) {
      const position = await collapse(issue);
      if (position === undefined) continue; // a concurrent mover may be mid-move
      const members = await client.listOpenIssuesWithLabels({ owner, repo, labels: [laneLabel(lane)] });
      const heldAt = (labels: readonly string[]): string[] =>
        labels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX) && orderOf(label) === position);
      const group = members.filter((m) => heldAt(m.labels).length > 0).sort((a, b) => a.number - b.number);
      if (group.length <= 1) return { position, repairs };
      const movable = (m: { labels: readonly string[] }): boolean =>
        m.labels.includes(QUEUED_LABEL) && !m.labels.includes(IN_PROGRESS_LABEL);
      const keeper = group.find((m) => !movable(m)) ?? group[0];
      const movers = group.filter((m) => m !== keeper && movable(m));
      if (movers.length === 0) return { position, repairs };
      let max = scanLaneOrders(members, QUEUED_LABEL, QUEUE_ORDER_LABEL_PREFIX).maxPos;
      const moved: OrderCollisionRepair['moved'] = [];
      for (const mover of movers) {
        const to = ++max;
        for (const name of heldAt(mover.labels)) await removeIfPresent(mover.number, name); // remove first: never two labels
        await client.ensureLabel({ owner, repo, ...queueOrderLabelSpec(to) });
        await client.addLabels({ owner, repo, issue_number: mover.number, labels: [queueOrderLabel(to)] });
        await collapse(mover.number);
        moved.push({ issue: mover.number, to });
      }
      const repair: OrderCollisionRepair = { lane, position, kept: keeper.number, moved };
      repairs.push(repair);
      onOrderCollisionRepaired?.(repair);
    }
    return { position: await collapse(issue), repairs };
  }

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
          const existing = Number(orderLabel.slice(QUEUE_ORDER_LABEL_PREFIX.length));
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
        const settled = await settleOrder(lane, issue);
        if (settled.position === undefined) {
          results.push({
            issue,
            outcome: 'failed',
            detail: 'order label removed concurrently; re-run to queue it (#3147)',
          });
          continue;
        }
        const collision = orderCollisionAt(scan, naive);
        results.push({
          issue,
          outcome: 'queued',
          position: settled.position,
          labelsAdded: specs.map((s) => s.name).filter((name) => !current.includes(name)),
          labelsCreated: created,
          ...(collision && !useRequested ? { collision } : {}),
          ...(wantsOrder && holders.length > 0 ? { preferredOrderHeldBy: holders } : {}),
          ...(settled.repairs.length > 0 ? { orderRepairs: settled.repairs } : {}),
        });
        if (!useRequested) {
          next = Math.max(next + 1, settled.position + 1);
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

  async function enqueueAfter(lane: string, parent: number, issues: readonly number[]): Promise<ChildEnqueueResult> {
    const parentLabels = await client.getIssueLabels({ owner, repo, issue_number: parent });
    const parentOrders = parentLabels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
    const p = parentOrders.length === 1 ? orderOf(parentOrders[0] ?? '') : undefined;
    if (p === undefined) return { results: await enqueue(lane, issues), placement: 'tail' };
    const out = await insertAfter(lane, p, issues, new Set([parent, ...issues]));
    return {
      results: out.results,
      placement: out.tail ? 'tail' : 'after-parent',
      ...(out.detail ? { detail: out.detail } : {}),
    };
  }

  async function enqueueFront(lane: string, issues: readonly number[]): Promise<FrontEnqueueResult> {
    const out = await insertAfter(lane, 0, issues, new Set(issues));
    return {
      results: out.results,
      placement: out.tail ? 'tail' : 'front',
      ...(out.detail ? { detail: out.detail } : {}),
    };
  }

  return { enqueue, enqueueAfter, enqueueFront };
}
