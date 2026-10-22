// packages/cli/src/entry.ts — bin-entry runner: gates on the Node version (#2382) and pins the CLI version in its reinstall line (#2599) and offers nvm only when detected (#2600), awaits main and exits 1 on rejection (#2031); answers exactly --version / -V itself, before loading the CLI graph (#3251).

import { createRequire } from 'node:module';
import { checkNodeVersion, type NodeEnv } from './node-version.js';

export interface EntryIo {
  log(msg: string): void;
  error(msg: string): void;
  exit(code: number): void;
}

// References, not wrappers: Node's console methods are bound and process.exit ignores `this`.
const defaultIo: EntryIo = { log: console.log, error: console.error, exit: process.exit };

/** Running CLI version from packages/cli/package.json, or '' if unreadable (#2599). */
export function readCliVersion(load: () => unknown = () => createRequire(import.meta.url)('../package.json')): string {
  try {
    const version = (load() as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : '';
  } catch {
    return '';
  }
}

/** True for exactly `--version` or `-V`: answered here so printing a version loads none of the CLI graph (#3251). */
export function isVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-V');
}

export async function runEntry(
  main: () => Promise<void>,
  io: EntryIo = defaultIo,
  nodeVersion: string = process.version,
  cliVersion: string = readCliVersion(),
  env: NodeEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const node = checkNodeVersion(nodeVersion, cliVersion, env);
  if (!node.ok) {
    io.error(node.message);
    io.exit(1);
    return;
  }
  if (isVersionRequest(args) && cliVersion !== '') {
    io.log(cliVersion);
    return;
  }
  try {
    await main();
  } catch (err) {
    io.error((err as Error).message);
    io.exit(1);
  }
}
