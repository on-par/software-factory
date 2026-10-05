// packages/product/src/entry.ts — bin-entry runner: awaits main and exits 1 on rejection (#2028).

export interface EntryIo {
  error(msg: string): void;
  exit(code: number): void;
}

// References, not wrappers: Node's console methods are bound and process.exit ignores `this`.
const defaultIo: EntryIo = { error: console.error, exit: process.exit };

export async function runEntry(main: () => Promise<void>, io: EntryIo = defaultIo): Promise<void> {
  try {
    await main();
  } catch (err) {
    io.error((err as Error).message);
    io.exit(1);
  }
}
