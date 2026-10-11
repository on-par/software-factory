// packages/cli/src/entry.ts — bin-entry runner: gates on the Node version (#2382), awaits main and exits 1 on rejection (#2031).

import { checkNodeVersion } from './node-version.js';

export interface EntryIo {
  error(msg: string): void;
  exit(code: number): void;
}

// References, not wrappers: Node's console methods are bound and process.exit ignores `this`.
const defaultIo: EntryIo = { error: console.error, exit: process.exit };

export async function runEntry(
  main: () => Promise<void>,
  io: EntryIo = defaultIo,
  nodeVersion: string = process.version,
): Promise<void> {
  const node = checkNodeVersion(nodeVersion);
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
