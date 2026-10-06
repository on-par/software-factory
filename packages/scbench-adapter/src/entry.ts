// packages/scbench-adapter/src/entry.ts — bin-entry runner: exits with main's code, or prints the error and exits 2 (#2033).

export interface EntryIo {
  error(msg: string): void;
  exit(code: number): void;
}

// References, not wrappers: Node's console methods are bound and process.exit ignores `this`.
const defaultIo: EntryIo = { error: console.error, exit: process.exit };

export async function runEntry(main: () => Promise<number>, io: EntryIo = defaultIo): Promise<void> {
  let code: number;
  try {
    code = await main();
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.exit(2);
    return;
  }
  io.exit(code);
}
