// packages/core/src/queue/order-collision.ts — lane order scan and queued-only collision detection for enqueue (#2988).

/** Order-only in-lane issues holding the slot a queued-only scan would have reused (#2988). */
export interface OrderCollision {
  order: number;
  heldBy: number[];
}

export interface LaneOrderScan {
  /** Max valid order over every member (queued, in-progress, order-only); 0 when none. */
  maxPos: number;
  /** Max valid order over members carrying queuedLabel; 0 when none. */
  queuedMax: number;
  /** order -> sorted issue numbers of members WITHOUT queuedLabel holding that order. */
  holders: Map<number, number[]>;
}

/** Tolerant scan: malformed or non-positive order labels never raise a max and never throw. */
export function scanLaneOrders(
  members: ReadonlyArray<{ number: number; labels: readonly string[] }>,
  queuedLabel: string,
  orderPrefix: string,
): LaneOrderScan {
  let maxPos = 0;
  let queuedMax = 0;
  const holders = new Map<number, number[]>();
  for (const member of members) {
    const queued = member.labels.includes(queuedLabel);
    for (const label of member.labels) {
      if (!label.startsWith(orderPrefix)) continue;
      const n = Number(label.slice(orderPrefix.length));
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      if (n > maxPos) maxPos = n;
      if (queued) {
        if (n > queuedMax) queuedMax = n;
      } else {
        const list = holders.get(n) ?? [];
        if (!list.includes(member.number)) list.push(member.number);
        holders.set(n, list);
      }
    }
  }
  for (const list of holders.values()) list.sort((a, b) => a - b);
  return { maxPos, queuedMax, holders };
}

export function orderCollisionAt(scan: LaneOrderScan, order: number): OrderCollision | undefined {
  const list = scan.holders.get(order);
  return list && list.length > 0 ? { order, heldBy: [...list] } : undefined;
}

/** One shared-position repair: `moved` left `from` for `to` because it shared the slot with `kept` (#3147). */
export interface OrderCollisionRepair {
  lane: string;
  position: number;
  moved: number;
  kept: number;
  from: number;
  to: number;
  attempt: number;
}

/** Keeps the lowest valid order label; every other prefixed label (malformed included) is removable. No valid label: nothing to keep or remove. */
export function lowestOrderLabel(
  labels: readonly string[],
  orderPrefix: string,
): { keep: string | undefined; remove: string[] } {
  const prefixed = labels.filter((label) => label.startsWith(orderPrefix));
  let keep: string | undefined;
  let keepPos = Infinity;
  for (const label of prefixed) {
    const n = Number(label.slice(orderPrefix.length));
    if (Number.isSafeInteger(n) && n > 0 && n < keepPos) {
      keep = label;
      keepPos = n;
    }
  }
  return { keep, remove: keep === undefined ? [] : prefixed.filter((label) => label !== keep) };
}
