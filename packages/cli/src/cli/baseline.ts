// packages/cli/src/cli/baseline.ts — `factory baseline clear [--sha S]` (#3540)

import { getFactoryPaths } from '@on-par/factory-core';
import { BaselineCache } from '@on-par/factory-core/internal';

import { CliExitError, PROGRAM_HANDLERS } from './index.js';

export interface BaselineClearDeps {
  cache: BaselineCache;
  out?: (line: string) => void;
}

/** Removes cached baseline results (all, or those whose base SHA starts with `opts.sha`); logs no event, so no other state file changes. */
export async function runBaselineClear(opts: { sha?: string }, deps: BaselineClearDeps): Promise<number> {
  if (opts.sha !== undefined && !/^[0-9a-f]{4,40}$/i.test(opts.sha)) {
    throw new CliExitError('factory baseline clear: --sha must be 4-40 hex characters', 2);
  }
  const n = await deps.cache.clear(opts.sha);
  const out = deps.out ?? console.log;
  out(`removed ${n} baseline cache ${n === 1 ? 'entry' : 'entries'}${opts.sha ? ` for ${opts.sha}` : ''}`);
  return n;
}

/** `factory baseline clear` (#3540): empty the repo's baseline cache. */
export async function cmdBaselineClear(opts: { sha?: string }): Promise<void> {
  const paths = getFactoryPaths(await PROGRAM_HANDLERS.getRepoRoot());
  await runBaselineClear(opts, { cache: new BaselineCache(paths.baselineCache) });
}
