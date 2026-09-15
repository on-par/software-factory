// src/adr/similarity.ts — pure normalized ADR-title duplicate matching (#1439).

export const ADR_TITLE_DUPLICATE_THRESHOLD = 0.8;

export function normalizeAdrTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(?:a|an|the)(?:\s+|$)/, '')
    .trim();
}

function normalizedTokenSet(title: string): Set<string> {
  const normalized = normalizeAdrTitle(title);
  return normalized === '' ? new Set() : new Set(normalized.split(/\s+/));
}

export function adrTitleSimilarity(a: string, b: string): number {
  const aTokens = normalizedTokenSet(a);
  const bTokens = normalizedTokenSet(b);

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

export function findDuplicateAdrTitle(
  title: string,
  existing: readonly { title: string; path: string }[],
): { title: string; path: string; similarity: number } | undefined {
  let duplicate: { title: string; path: string; similarity: number } | undefined;

  for (const candidate of existing) {
    const similarity = adrTitleSimilarity(title, candidate.title);
    if (similarity >= ADR_TITLE_DUPLICATE_THRESHOLD && similarity > (duplicate?.similarity ?? 0)) {
      duplicate = { ...candidate, similarity };
    }
  }

  return duplicate;
}
