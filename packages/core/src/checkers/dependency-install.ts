import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FROZEN_INSTALL_BY_LOCKFILE_FIRST_MATCH_WINS: ReadonlyArray<{ lockfile: string; argv: readonly string[] }> = [
  { lockfile: 'pnpm-lock.yaml', argv: ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfile: 'yarn.lock', argv: ['yarn', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lock', argv: ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', argv: ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'package-lock.json', argv: ['npm', 'ci', '--no-audit', '--no-fund'] },
];
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;

export function dependencyInstallCommand(freshWorktreeWithoutNodeModules: string): readonly string[] | null {
  if (!existsSync(join(freshWorktreeWithoutNodeModules, 'package.json'))) return null;
  const match = FROZEN_INSTALL_BY_LOCKFILE_FIRST_MATCH_WINS.find((c) =>
    existsSync(join(freshWorktreeWithoutNodeModules, c.lockfile)),
  );
  return match?.argv ?? ['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock'];
}
