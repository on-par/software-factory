export function mergeCiReworkRounds(
  ...maps: (Readonly<Record<string, number>> | undefined)[]
): Record<string, number> | undefined {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    for (const [pr, used] of Object.entries(map)) {
      if (!/^\d+$/.test(pr) || !Number.isSafeInteger(used) || used < 0) continue;
      merged[pr] = Math.max(merged[pr] ?? 0, used);
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}
