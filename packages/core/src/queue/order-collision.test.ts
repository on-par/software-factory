// packages/core/src/queue/order-collision.test.ts — lane order scan and collision lookup (#2988).

import { describe, expect, it } from 'vitest';

import { orderCollisionAt, scanLaneOrders } from './order-collision.js';

const Q = 'factory:queued';
const P = 'factory:order:';

describe('scanLaneOrders', () => {
  it('splits queued members from order-only holders', () => {
    const scan = scanLaneOrders(
      [
        { number: 1, labels: [Q, `${P}3`] },
        { number: 2, labels: [`${P}5`] },
      ],
      Q,
      P,
    );
    expect(scan.maxPos).toBe(5);
    expect(scan.queuedMax).toBe(3);
    expect(scan.holders.get(5)).toEqual([2]);
    expect(scan.holders.has(3)).toBe(false);
  });

  it('ignores malformed, zero and negative labels', () => {
    const scan = scanLaneOrders([{ number: 1, labels: [`${P}abc`, `${P}0`, `${P}-4`, Q] }], Q, P);
    expect(scan.maxPos).toBe(0);
    expect(scan.queuedMax).toBe(0);
    expect(scan.holders.size).toBe(0);
  });

  it('sorts and dedupes holders', () => {
    const scan = scanLaneOrders(
      [
        { number: 9, labels: [`${P}2`] },
        { number: 4, labels: [`${P}2`, `${P}2`] },
      ],
      Q,
      P,
    );
    expect(scan.holders.get(2)).toEqual([4, 9]);
  });
});

describe('orderCollisionAt', () => {
  const scan = scanLaneOrders([{ number: 7, labels: [`${P}24`] }], Q, P);

  it('returns the holders of a held slot', () => {
    expect(orderCollisionAt(scan, 24)).toEqual({ order: 24, heldBy: [7] });
  });

  it('returns undefined for a free slot', () => {
    expect(orderCollisionAt(scan, 25)).toBeUndefined();
  });
});
