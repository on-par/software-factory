// src/config/state-root.ts — Resolves the FACTORY_STATE_ROOT / --state-root value to an
// absolute factory state root (#2281), so a repo can run with no in-checkout `.factory/`.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveRepoSlug } from '../logger/repo-slug.js';

export const STATE_ROOT_ENV = 'FACTORY_STATE_ROOT';

/** Maps a raw state-root value to an absolute root: unset/blank → undefined, `auto` →
 *  `<home>/.factory/<owner>/<name>` from the checkout's origin, `~`/`~/x` → under home, an
 *  absolute path → itself. Anything else (relative paths included) throws. */
export function resolveStateRoot(
  value: string | undefined,
  opts: { repoRoot: string; home?: string; resolveSlug?: (dir: string) => string | null },
): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  const home = opts.home ?? homedir();
  if (v.toLowerCase() === 'auto') {
    const slug = (opts.resolveSlug ?? resolveRepoSlug)(opts.repoRoot);
    if (slug === null) {
      throw new Error(
        `${STATE_ROOT_ENV}=auto needs a git origin remote that parses to owner/name (in ${opts.repoRoot})`,
      );
    }
    const [owner, name] = slug.split('/');
    return join(home, '.factory', owner, name);
  }
  if (v === '~') return home;
  if (v.startsWith('~/')) return join(home, v.slice(2));
  if (isAbsolute(v)) return resolve(v);
  throw new Error(`${STATE_ROOT_ENV} must be an absolute path, ~/..., or auto; got "${v}"`);
}
