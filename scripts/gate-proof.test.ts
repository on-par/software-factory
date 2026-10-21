import { expect, it } from 'vitest';

// Temporary: proves a red shard turns the required `ci` check red. Reverted next commit.
it('fails on purpose', () => {
  expect(1).toBe(2);
});
