/** Branch-name slugging. Dependency-free so config can import it without a cycle through utils/index. */

export function slugify(s: string): string {
  // The [^a-z0-9]+ pass always collapses runs of non-alphanumeric characters to a
  // single '-', so at most one '-' can ever remain at either boundary below — a `+`
  // quantifier there would be redundant and is a polynomial-backtracking regex on
  // attacker-controlled input (CodeQL js/polynomial-redos).
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
}

/** Prefix of factory branches (`ship-it/<n>-…`) created before the default became `factory` (#1714). Still recognized, never created. */
export const LEGACY_BRANCH_PREFIX = 'ship-it';

export function branchPrefixSlug(prefix?: string): string {
  return slugify(prefix || LEGACY_BRANCH_PREFIX) || LEGACY_BRANCH_PREFIX;
}
