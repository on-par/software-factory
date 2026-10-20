// packages/core/src/readiness/slice-overlap.ts — pure check for whether the slicer's slices
// mostly edit the same files (#3351). Slices cut by criteria rather than by code stack PRs that
// rewrite each other, so a cohesive decomposition keeps the issue whole.

import type { Story } from '@on-par/contracts';

/** A pair of slices overlaps when their Jaccard file share is strictly above this. */
export const COHESIVE_PAIR_SHARE = 0.5;
/** A decomposition whose slices touch this many distinct files or fewer is always cohesive. */
export const COHESIVE_MAX_UNION_FILES = 3;

const MAX_LISTED_FILES = 10;

export interface SliceOverlap {
  sliceCount: number;
  /** Every slice listed at least one file. False means unknown overlap, never cohesive. */
  known: boolean;
  pairCount: number;
  /** Pairs whose |A∩B| / |A∪B| > COHESIVE_PAIR_SHARE. */
  overlappingPairs: number;
  /** Sorted union of every slice's files. */
  files: string[];
  /** Sorted files listed by two or more slices. */
  sharedFiles: string[];
  cohesive: boolean;
}

export function measureSliceOverlap(stories: readonly Pick<Story, 'filesLikelyTouched'>[]): SliceOverlap {
  const sets = stories.map((s) => new Set(s.filesLikelyTouched));
  const known = sets.length > 0 && sets.every((s) => s.size > 0);
  const counts = new Map<string, number>();
  for (const set of sets) {
    for (const file of set) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const files = [...counts.keys()].sort();
  const sharedFiles = files.filter((file) => (counts.get(file) ?? 0) >= 2);

  let pairCount = 0;
  let overlappingPairs = 0;
  if (known) {
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i]!;
        const b = sets[j]!;
        let inter = 0;
        for (const file of a) if (b.has(file)) inter++;
        const union = a.size + b.size - inter;
        pairCount++;
        if (inter / union > COHESIVE_PAIR_SHARE) overlappingPairs++;
      }
    }
  }
  const cohesive =
    known && (files.length <= COHESIVE_MAX_UNION_FILES || (pairCount > 0 && overlappingPairs * 2 > pairCount));
  return { sliceCount: sets.length, known, pairCount, overlappingPairs, files, sharedFiles, cohesive };
}

export function describeSliceOverlap(overlap: SliceOverlap): string {
  const list = (names: string[]): string =>
    names.length > MAX_LISTED_FILES ? `${names.slice(0, MAX_LISTED_FILES).join(', ')}…` : names.join(', ');
  const detail =
    overlap.sharedFiles.length > 0 ? `shared: ${list(overlap.sharedFiles)}` : `files: ${list(overlap.files)}`;
  return `${overlap.sliceCount} slice(s) mostly edit the same files — ${overlap.overlappingPairs}/${overlap.pairCount} pair(s) share more than half their files; ${overlap.files.length} file(s) in total; ${detail}`;
}
