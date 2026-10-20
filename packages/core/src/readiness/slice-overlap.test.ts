import { describe, expect, it } from 'vitest';

import { describeSliceOverlap, measureSliceOverlap } from './slice-overlap.js';

const of = (...sets: string[][]) => sets.map((filesLikelyTouched) => ({ filesLikelyTouched }));

describe('measureSliceOverlap', () => {
  it('is cohesive when every slice lists the same files', () => {
    const same = ['a.ts', 'b.ts', 'c.ts'];
    const o = measureSliceOverlap(of(same, same, same));
    expect(o.cohesive).toBe(true);
    expect(o.sharedFiles).toEqual(same);
    expect(o.overlappingPairs).toBe(3);
    expect(o.pairCount).toBe(3);
  });

  it('is not cohesive for disjoint 2-file slices (union 6)', () => {
    expect(measureSliceOverlap(of(['a', 'a2'], ['b', 'b2'], ['c', 'c2'])).cohesive).toBe(false);
  });

  it('is cohesive when the union is 3 files or fewer even if disjoint', () => {
    expect(measureSliceOverlap(of(['a'], ['b'], ['c'])).cohesive).toBe(true);
  });

  it('needs strictly more than half of the pairs overlapping', () => {
    const big = (extra: string) => ['1', '2', '3', extra];
    const two = measureSliceOverlap(
      of(['1', '2', '3', '4'], ['1', '2', '3', '5'], ['1', '2', '3', '6'], ['x', 'y', 'z', 'w']),
    );
    expect(two.pairCount).toBe(6);
    expect(two.overlappingPairs).toBe(3);
    expect(two.cohesive).toBe(false);
    const three = measureSliceOverlap(of(big('4'), big('5'), ['x', 'y', 'z', 'w']));
    expect(three.overlappingPairs).toBe(1);
    expect(three.cohesive).toBe(false);
    const most = measureSliceOverlap(of(big('4'), big('5'), big('6')));
    expect(most.overlappingPairs).toBe(3);
    expect(most.cohesive).toBe(true);
  });

  it('counts a Jaccard share of exactly 0.5 as not overlapping', () => {
    const exact = measureSliceOverlap(of(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'x']));
    expect(exact.overlappingPairs).toBe(0);
    expect(exact.pairCount).toBe(1);
  });

  it('treats a slice with no files as unknown overlap', () => {
    const o = measureSliceOverlap(of(['a'], []));
    expect(o.known).toBe(false);
    expect(o.cohesive).toBe(false);
  });

  it('is not cohesive for an empty list of stories', () => {
    const o = measureSliceOverlap([]);
    expect(o.known).toBe(false);
    expect(o.cohesive).toBe(false);
  });

  it('is not cohesive for a single story with 4 files', () => {
    expect(measureSliceOverlap(of(['a', 'b', 'c', 'd'])).cohesive).toBe(false);
  });
});

describe('describeSliceOverlap', () => {
  it('names the slice count and the shared files', () => {
    const same = ['src/list.ts', 'docs/list.md'];
    const text = describeSliceOverlap(measureSliceOverlap(of(same, same, same)));
    expect(text).toContain('3 slice');
    expect(text).toContain('src/list.ts');
    expect(text).toContain('shared:');
  });

  it('prints the union when nothing is shared and truncates long lists', () => {
    expect(describeSliceOverlap(measureSliceOverlap(of(['a'], ['b'])))).toContain('files: a, b');
    const many = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    expect(describeSliceOverlap(measureSliceOverlap(of(many, many)))).toContain('…');
  });
});
