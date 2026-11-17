// src/adr/similarity.ts — pure normalized ADR-title duplicate matching (#1439).

export function normalizeAdrTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(?:a|an|the)(?:\s+|$)/, '')
    .trim();
}
