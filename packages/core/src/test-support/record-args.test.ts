import { expect, it } from 'vitest';
import { recordArgs } from './record-args.js';

it('records each call and returns the implementation result', () => {
  const { calls, fn } = recordArgs((a: number) => a * 2);
  expect(fn(2)).toBe(4);
  expect(calls).toEqual([[2]]);
});
