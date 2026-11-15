import { expect, it } from 'vitest';

export const recordArgs = <A extends unknown[], R>(impl: (...args: A) => R) => {
  const calls: A[] = [];
  return { calls, fn: (...args: A): R => impl(...(calls.push(args), args)) };
};

it('records each call and returns the implementation result', () => {
  const { calls, fn } = recordArgs((a: number) => a * 2);
  expect(fn(2)).toBe(4);
  expect(calls).toEqual([[2]]);
});
