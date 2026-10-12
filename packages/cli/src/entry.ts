// packages/cli/src/entry.ts — bin-entry runner: gates on the Node version (#2382) and pins the CLI version in its reinstall line (#2599), awaits main and exits 1 on rejection (#2031).

import { createRequire } from 'node:module';
import { checkNodeVersion } from './node-version.js';

export interface EntryIo {
  error(msg: string): void;
  exit(code: number): void;
}

// References, not wrappers: Node's console methods are bound and process.exit ignores `this`.
const defaultIo: EntryIo = { error: console.error, exit: process.exit };

/** Running CLI version from packages/cli/package.json, or '' if unreadable (#2599). */
export function readCliVersion(load: () => unknown = () => createRequire(import.meta.url)('../package.json')): string {
  try {
    const version = (load() as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : '';
  } catch {
    return '';
  }
}

export async function runEntry(
  main: () => Promise<void>,
  io: EntryIo = defaultIo,
  nodeVersion: string = process.version,
  cliVersion: string = readCliVersion(),
): Promise<void> {
  const node = checkNodeVersion(nodeVersion, cliVersion);
  if (!node.ok) {
    io.error(node.message);
    io.exit(1);
    return;
  }
  try {
    await main();
  } catch (err) {
    io.error((err as Error).message);
    io.exit(1);
  }
}
