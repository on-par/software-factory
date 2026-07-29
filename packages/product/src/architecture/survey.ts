// packages/product/src/architecture/survey.ts — read-only repo component survey (#477).
import type { RepoContextReader } from '@on-par/repo-context';

import { DEFAULT_ADR_DIR } from './adrs.js';

export const DEFAULT_PACKAGES_DIR = 'packages';

/** A top-level component of the target repo, e.g. { name: 'core', path: 'packages/core' }. */
export interface RepoComponent {
  name: string;
  path: string;
}

export interface RepoSurvey {
  /** Directories under packages/, sorted by name; [] when the dir is absent or empty. */
  components: readonly RepoComponent[];
  /** Whether the target repo has an ADR home at the scanned dir. */
  hasAdrHome: boolean;
}

export async function surveyRepo(
  reader: RepoContextReader,
  opts?: { packagesDir?: string; adrDir?: string },
): Promise<RepoSurvey> {
  const packagesDir = opts?.packagesDir ?? DEFAULT_PACKAGES_DIR;
  const adrDir = opts?.adrDir ?? DEFAULT_ADR_DIR;

  const entries = await reader.readDir(packagesDir);
  const components = entries
    .filter((entry) => entry.type === 'dir')
    .map((entry) => ({ name: entry.name, path: entry.path }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const hasAdrHome = await reader.exists(adrDir);

  return { components, hasAdrHome };
}
