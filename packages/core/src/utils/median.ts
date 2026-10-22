// src/utils/median.ts — The one median helper (#3448).

/** Median of `values` (mean of the two middle values for an even count).
 *  An empty input returns null — the one documented empty result. Does not mutate. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
