// src/readiness/duplicate-guard.ts — pure Jaccard-similarity duplicate detection for
// decomposition children against a parent issue's already-filed sub-issues (#1502).
//
// Mirrors adr/similarity.ts's normalized-token-set Jaccard approach, applied to a
// proposed story's rendered title+body against each open sibling issue's title+body.

export const DECOMPOSITION_DUPLICATE_THRESHOLD = 0.5;

function normalizeDecompositionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizedTokenSet(text: string): Set<string> {
  const normalized = normalizeDecompositionText(text);
  return normalized === '' ? new Set() : new Set(normalized.split(/\s+/));
}

export function decompositionTextSimilarity(a: string, b: string): number {
  const aTokens = normalizedTokenSet(a);
  const bTokens = normalizedTokenSet(b);

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

export interface SiblingIssue {
  number: number;
  title: string;
  body: string | null;
}

export interface DuplicateStoryMatch {
  number: number;
  title: string;
  similarity: number;
}

/** Finds the most similar sibling clearing DECOMPOSITION_DUPLICATE_THRESHOLD, if any. */
export function findDuplicateStory(
  storyText: string,
  siblings: readonly SiblingIssue[],
): DuplicateStoryMatch | undefined {
  let duplicate: DuplicateStoryMatch | undefined;

  for (const sibling of siblings) {
    const siblingText = `${sibling.title} ${sibling.body ?? ''}`;
    const similarity = decompositionTextSimilarity(storyText, siblingText);
    if (similarity >= DECOMPOSITION_DUPLICATE_THRESHOLD && similarity > (duplicate?.similarity ?? 0)) {
      duplicate = { number: sibling.number, title: sibling.title, similarity };
    }
  }

  return duplicate;
}
