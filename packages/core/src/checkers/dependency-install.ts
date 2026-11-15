import { existsSync } from 'node:fs';
import { join } from 'node:path';

const JS_INSTALL_COMMANDS: ReadonlyArray<{ lockfile: string; argv: readonly string[] }> = [
  { lockfile: 'pnpm-lock.yaml', argv: ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfile: 'yarn.lock', argv: ['yarn', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lock', argv: ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', argv: ['bun', 'install', '--frozen-lockfile'] },
  { lockfile: 'package-lock.json', argv: ['npm', 'ci', '--no-audit', '--no-fund'] },
];
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;

export function dependencyInstallCommand(worktree: string): readonly string[] | null {
  if (!existsSync(join(worktree, 'package.json'))) return null;
  const match = JS_INSTALL_COMMANDS.find((c) => existsSync(join(worktree, c.lockfile)));
  return match?.argv ?? ['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock'];
}
