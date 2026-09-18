import { describe, expect, it } from 'vitest';

import { findFileOverlapCollisions } from './file-overlap-guard.js';

describe('findFileOverlapCollisions', () => {
  it('flags a later candidate naming the same file as an earlier one', () => {
    const collisions = findFileOverlapCollisions([
      { number: 568, title: 'Fix layout in intake-lane.tsx', body: '' },
      { number: 598, title: 'Refactor intake-lane.tsx', body: 'touches packages/dashboard/src/intake-lane.tsx' },
    ]);
    expect(collisions.size).toBe(1);
    const match = collisions.get(598);
    expect(match).toEqual({ number: 568, title: 'Fix layout in intake-lane.tsx', path: 'intake-lane.tsx' });
  });

  it('does not flag candidates naming different files', () => {
    const collisions = findFileOverlapCollisions([
      { number: 1, title: 'Fix a.ts', body: '' },
      { number: 2, title: 'Fix b.ts', body: '' },
    ]);
    expect(collisions.size).toBe(0);
  });

  it('matches case-insensitively', () => {
    const collisions = findFileOverlapCollisions([
      { number: 1, title: 'Fix Intake-Lane.TSX', body: '' },
      { number: 2, title: 'Fix intake-lane.tsx', body: '' },
    ]);
    expect(collisions.get(2)).toEqual({ number: 1, title: 'Fix Intake-Lane.TSX', path: 'intake-lane.tsx' });
  });

  it('does not flag a shared generic file name', () => {
    const collisions = findFileOverlapCollisions([
      { number: 1, title: 'Bump deps in package.json', body: '' },
      { number: 2, title: 'Bump more deps in package.json', body: '' },
    ]);
    expect(collisions.size).toBe(0);
  });

  it('returns an empty map for a single candidate', () => {
    const collisions = findFileOverlapCollisions([{ number: 1, title: 'Fix a.ts', body: '' }]);
    expect(collisions.size).toBe(0);
  });
});
