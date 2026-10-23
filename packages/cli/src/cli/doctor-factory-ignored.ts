// packages/cli/src/cli/doctor-factory-ignored.ts — `factory doctor` warns when .factory/ is git-ignored (#3600)

import { relative, resolve } from 'node:path';

import { resolveRepoConfigPath, shellEscape } from '@on-par/factory-core/internal';

import type { DoctorCheck } from './doctor.js';

/** `git check-ignore -v` output: `<source>:<line>:<pattern>` TAB `<path>`. */
const CHECK_IGNORE_LINE = /^(.+?:\d+:.*)\t/;

/** A warning when the repo config file (or `.factory/` itself, when there is no config file) is ignored
 *  by .gitignore, .git/info/exclude or core.excludesFile. A run snapshots config from the source
 *  checkout, but its worktree is checked out from git and has none of the ignored files. Tracked files
 *  never warn: `git check-ignore` only reports untracked paths. Empty when nothing is ignored. */
export function factoryIgnoredChecks(
  repoRoot: string,
  tryExec: (cmd: string) => string | null,
  pathExists: (p: string) => boolean,
): DoctorCheck[] {
  const config = resolveRepoConfigPath(resolve(repoRoot, '.factory'));
  const target = pathExists(config) ? relative(repoRoot, config) : '.factory/';
  const rule = CHECK_IGNORE_LINE.exec(
    tryExec(`git -C ${shellEscape(repoRoot)} check-ignore -v -- ${shellEscape(target)}`) ?? '',
  )?.[1];
  if (rule === undefined) return [];
  return [
    {
      name: '.factory in git',
      ok: false,
      optional: true,
      detail: `${target} is git-ignored (${rule}); the run snapshots config from the source checkout, but worktrees won't contain .factory/ files`,
      fix: `commit ${target} (drop its ignore rule) so worktrees, CI and other checkouts see the same config and constitution`,
    },
  ];
}
