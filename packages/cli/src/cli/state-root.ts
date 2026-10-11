// src/cli/state-root.ts — Applies the global `--state-root` flag / FACTORY_STATE_ROOT env (#2281).

import { resolveStateRoot, STATE_ROOT_ENV } from '@on-par/factory-core/internal';

/** The flag wins over the env var. A resolved root is written back to `env` as an absolute
 *  path so every child process (lanes, CHECK) skips the git lookup and any cwd difference.
 *  Invalid values throw. */
export function applyStateRootOption(
  flag: string | undefined,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolved = resolveStateRoot(flag ?? env[STATE_ROOT_ENV], { repoRoot });
  if (resolved !== undefined) env[STATE_ROOT_ENV] = resolved;
  return resolved;
}
