const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;
const SINGLE_EDGE_HYPHEN = /^-|-$/g;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, '-')
    .replace(SINGLE_EDGE_HYPHEN, '')
    .slice(0, 32)
    .replace(/-$/, '');
}

const DEFAULT_BRANCH_PREFIX = 'factory';

export function branchPrefixSlug(prefix?: string): string {
  return slugify(prefix || DEFAULT_BRANCH_PREFIX) || DEFAULT_BRANCH_PREFIX;
}
