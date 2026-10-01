import type { Command } from 'commander';
import { branchPrefixSlug, resolveBranchPrefix, slugify } from '@on-par/factory-core/internal';

export const BRANCH_PREFIX_OPTION_DESCRIPTION =
  'Branch-name prefix for branches this command creates (default: factory)';
export const BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION =
  'Branch-name prefix of factory branches to act on; legacy ship-it/ branches are always included (default: factory)';
export const INVALID_BRANCH_PREFIX_MESSAGE = 'factory: --branch-prefix must contain at least one letter or digit';

/** undefined -> resolveBranchPrefix(); otherwise the slug-normalized value; null when it has no [a-z0-9]. */
export function resolveBranchPrefixOption(raw: string | undefined): string | null {
  if (raw === undefined) return resolveBranchPrefix();
  if (slugify(raw) === '') return null;
  return branchPrefixSlug(raw);
}

export function addBranchPrefixOption(cmd: Command): Command {
  return cmd.option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION);
}
