import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDirs {
  /** mkdtemp under os.tmpdir() and register the dir for cleanup. */
  make(prefix: string): Promise<string>;
  makeSync(prefix: string): string;
  /** Remove every registered dir (recursive, force, maxRetries 3). Idempotent; never throws for a missing dir. */
  cleanup(): Promise<void>;
}

/** Self-cleaning scratch dirs (#3114): call `cleanup()` from afterEach or a finally block. */
export function createTempDirs(): TempDirs {
  const dirs: string[] = [];
  return {
    async make(prefix) {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    makeSync(prefix) {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    async cleanup() {
      const pending = dirs.splice(0);
      const results = await Promise.allSettled(
        pending.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
      );
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dirs = createTempDirs();
  const dir = await dirs.make(prefix);
  try {
    return await fn(dir);
  } finally {
    await dirs.cleanup();
  }
}
