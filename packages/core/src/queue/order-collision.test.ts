// packages/core/src/queue/order-collision.test.ts — lane order scan and collision lookup (#2988).

import { describe, expect, it } from 'vitest';

import { lowestOrderLabel, orderCollisionAt, scanLaneOrders } from './order-collision.js';

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

describe('lowestOrderLabel', () => {
  it('keeps nothing when there is no order label', () => {
    expect(lowestOrderLabel(['factory:queued'], P)).toEqual({ keep: undefined, remove: [] });
  });
  it('keeps a single valid label', () => {
    expect(lowestOrderLabel(['factory:order:4', 'x'], P)).toEqual({ keep: 'factory:order:4', remove: [] });
  });
  it('keeps the lowest of many and removes the rest', () => {
    expect(lowestOrderLabel(['factory:order:9', 'factory:order:2', 'factory:order:5'], P)).toEqual({
      keep: 'factory:order:2',
      remove: ['factory:order:9', 'factory:order:5'],
    });
  });
  it('removes nothing when every order label is malformed', () => {
    expect(lowestOrderLabel(['factory:order:x', 'factory:order:0'], P)).toEqual({ keep: undefined, remove: [] });
  });
  it('removes a malformed label next to a valid one', () => {
    expect(lowestOrderLabel(['factory:order:x', 'factory:order:3'], P)).toEqual({
      keep: 'factory:order:3',
      remove: ['factory:order:x'],
    });
  });
});
